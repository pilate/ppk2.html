// UI wiring: connects controls, the device, the recorder and the chart.

import { Chart, Minimap } from './chart.js';
import * as files from './fileio.js';
import * as fmt from './format.js';
import { Ppk2Device } from './ppk2.js';
import { DEFAULT_SPIKE_FILTER, DIGITAL_CHANNELS, MODIFIER_FIELDS, PowerMode, RANGE_COUNT, clamp, clampVdd } from './protocol.js';
import { Recorder, SAMPLE_RATES } from './recorder.js';
import { SampleStore } from './store.js';
import { DemoTransport, SerialTransport } from './transport.js';

const $ = (id) => document.getElementById(id);

// ---- settings -------------------------------------------------------------

// Only settings that differ from the defaults are stored, so changing a default reaches
// everyone who hasn't picked their own value.
const SETTINGS_KEY = 'ppk2.html.settings.v2';
const OLD_SETTINGS_KEY = 'ppk2.html.settings.v1'; // stored every setting, defaults included
const DEFAULTS = {
  rate: 100_000,
  limit: 0,
  buffer: 536_870_912,
  spike: { ...DEFAULT_SPIKE_FILTER },
  trigger: { enabled: false, level: 1000, unit: 1000, edge: 'rising', windowMs: 10, prePercent: 10, mode: 'single' },
  yLog: false,
  showDigital: true,
  channels: 0xff,
  spanSec: 4,
  main: 'current', // signal in the big chart: 'current' or a digital channel number
  tool: 'pan',
  csvDigital: true,
};

function loadSettings() {
  const s = structuredClone(DEFAULTS);
  try {
    let saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved) {
      saved = JSON.parse(localStorage.getItem(OLD_SETTINGS_KEY) || '{}');
      // The old format can't tell a chosen 1 s window from the old default, so let the new default apply.
      if (saved.spanSec === 1) delete saved.spanSec;
    }
    for (const [k, v] of Object.entries(saved)) {
      if (!(k in s)) continue;
      s[k] = typeof s[k] === 'object' ? { ...s[k], ...v } : v;
    }
  } catch {}
  return s;
}

const settings = loadSettings();

function saveSettings() {
  const changed = {};
  for (const [k, v] of Object.entries(settings)) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) changed[k] = v;
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(changed));
    localStorage.removeItem(OLD_SETTINGS_KEY);
  } catch {}
}

// ---- state ----------------------------------------------------------------

const chart = new Chart($('chart'));
new Minimap($('minimap'), chart);
const recorder = new Recorder();

let device = null;
let connecting = false;
let busy = false; // a file operation is running
/** The recording on screen: its samples, recording details ({ startedAt, mode, vdd, source }) and save state. */
let session = { store: null, info: null, unsaved: false };

const isRecording = () => !!device?.sampling;
const hasUnsaved = () => session.unsaved && !!session.store?.length;

chart.rate = settings.rate;
chart.setSpanSeconds(settings.spanSec);
chart.configure({
  tool: settings.tool,
  yLog: settings.yLog,
  showDigital: settings.showDigital,
  channels: settings.channels,
  main: Number.isInteger(settings.main) && settings.main >= 0 && settings.main < DIGITAL_CHANNELS ? settings.main : 'current',
});
chart.onmainchange = (main) => {
  settings.main = main;
  saveSettings();
};

// ---- helpers --------------------------------------------------------------

let toastTimer = 0;
function toast(message, kind = 'info', ms = 4500) {
  const el = $('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function reportError(e) {
  console.error(e);
  toast(e.message || String(e), 'error', 8000);
}

async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    reportError(e);
  }
}

/** Write text/markup only when it changed, so periodic refreshes don't churn the DOM. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setHTML(el, html) {
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}

/** Read a number input, clamp it, write the clamped value back and return it. */
function readNumber(el, { min = -Infinity, max = Infinity, fallback, round = false }) {
  let v = Number(el.value);
  v = clamp(Number.isFinite(v) && el.value !== '' ? v : fallback, min, max);
  if (round) v = Math.round(v);
  el.value = v;
  return v;
}

function segmented(id, value, onChange) {
  const buttons = [...$(id).querySelectorAll('button')];
  const set = (v) => buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === String(v))));
  for (const b of buttons) {
    b.addEventListener('click', () => {
      set(b.dataset.value);
      onChange(b.dataset.value);
    });
  }
  set(value);
  return { set, disable: (d) => buttons.forEach((b) => (b.disabled = d)) };
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function definitionList(rows) {
  return rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

// ---- device ---------------------------------------------------------------

async function connect(makeTransport) {
  if (device || connecting) return;
  let transport;
  try {
    transport = await makeTransport();
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(e.message, 'error');
    return;
  }
  connecting = true;
  syncUI();
  const dev = new Ppk2Device(transport);
  dev.onclose = () => onDeviceLost(dev);
  try {
    await dev.open();
    dev.setSpikeFilter(settings.spike);
    await dev.setMode(dev.mode);
    if (dev.mode === PowerMode.Source) await dev.setVdd(dev.vdd);
    await dev.setDutPower(false);
    device = dev;
    renderDevice();
  } catch (e) {
    await dev.close().catch(() => {});
    reportError(
      e.name === 'InvalidStateError' || e.name === 'NetworkError'
        ? new Error('The PPK2 is in use by another app. Close nRF Connect Power Profiler or any serial terminal, then connect again.')
        : e,
    );
  } finally {
    connecting = false;
    syncUI();
  }
}

async function connectSerial() {
  const known = await SerialTransport.known();
  return known.length === 1 ? known[0] : SerialTransport.request();
}

async function disconnect() {
  if (!device) return;
  if (isRecording()) await endRecording();
  const dev = device;
  device = null;
  await dev.close().catch(() => {});
  syncUI();
}

function onDeviceLost(dev) {
  if (device !== dev) return;
  device = null;
  endRecording();
  toast('The PPK2 was disconnected. Your recording so far is kept.', 'error', 8000);
}

function renderDevice() {
  const meta = device.metadata;
  $('device-facts').innerHTML = definitionList([
    ['Device', device.label],
    ['Hardware', meta.hw ?? 'unknown'],
    ['Calibration', meta.hasCalibration ? 'Loaded from device' : 'Missing'],
  ]);
  $('uncalibrated').hidden = meta.hasCalibration;
  modeSeg.set(device.mode);
  $('vdd-num').value = device.vdd;
  $('dut-power').checked = device.dutPower;

  // Range gains
  const gains = $('gains');
  gains.innerHTML = '';
  device.userGains.forEach((gain, r) => {
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    const label = document.createElement('label');
    label.htmlFor = `gain-${r}`;
    label.textContent = r === 0 ? 'Range 1 (lowest)' : r === RANGE_COUNT - 1 ? `Range ${r + 1} (highest)` : `Range ${r + 1}`;
    const box = Object.assign(document.createElement('span'), { className: 'box' });
    const input = Object.assign(document.createElement('input'), {
      type: 'number',
      id: `gain-${r}`,
      min: '80',
      max: '120',
      step: '0.1',
      value: (gain * 100).toFixed(1),
    });
    input.addEventListener('change', () =>
      guarded(() => device?.setUserGain(r, readNumber(input, { min: 80, max: 120, fallback: 100 }) / 100)),
    );
    box.append(input, Object.assign(document.createElement('span'), { className: 'unit', textContent: '%' }));
    row.append(label, box);
    gains.append(row);
  });

  // Calibration table
  const m = meta.modifiers;
  const head = Array.from({ length: RANGE_COUNT }, (_, r) => `<th>${r + 1}</th>`).join('');
  const body = MODIFIER_FIELDS.map(
    ([key, name, description]) =>
      `<tr><th title="${escapeHtml(description)}">${name}</th>${m[key]
        .map((v) => `<td>${escapeHtml(Number(v).toPrecision(6))}</td>`)
        .join('')}</tr>`,
  ).join('');
  $('calib-table').innerHTML = `<table><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---- recording ------------------------------------------------------------

/** Push the trigger settings to the recorder and the chart's level line. */
function applyTrigger() {
  const t = settings.trigger;
  recorder.trigger.configure(t);
  chart.configure({ triggerLevel: isRecording() && t.enabled ? t.level : null });
}

async function startRecording() {
  if (!device || isRecording()) return;
  if (hasUnsaved() && !confirm('Starting a new recording discards the current one. Continue?')) return;
  recorder.trigger.configure(settings.trigger);
  const store = recorder.begin({
    rate: settings.rate,
    maxBytes: settings.buffer,
    limitSec: settings.limit,
    triggerEnabled: settings.trigger.enabled,
  });
  session = {
    store,
    info: { startedAt: new Date().toISOString(), mode: device.mode, vdd: device.vdd, source: device.label },
    unsaved: true,
  };
  chart.setStore(store);
  chart.setLive(true);
  chart.setSpanSeconds(settings.spanSec);
  device.onsample = recorder.sink;
  try {
    await device.start();
  } catch (e) {
    toast(`Couldn't start sampling: ${e.message}`, 'error');
  }
  applyTrigger();
  syncUI();
}

/** The one way a recording ends: stop button, limit, single trigger, failed start or unplugged device. */
async function endRecording() {
  recorder.end();
  chart.configure({ triggerLevel: null });
  syncUI();
  if (device?.sampling) await device.stop().catch(() => {});
  syncUI();
}

recorder.onlimit = () => {
  endRecording();
  toast(`Stopped after ${fmt.humanDuration(settings.limit)}, as set in Stop after.`);
};

recorder.trigger.oncapture = (capture, { final }) => {
  chart.configure({ triggerMarker: capture.trigger });
  chart.setView(capture.from, capture.to);
  if (final) endRecording();
  else syncUI();
};

// ---- controls -------------------------------------------------------------

const modeSeg = segmented('mode', PowerMode.Source, (v) =>
  guarded(async () => {
    if (!device) return;
    const mode = Number(v);
    await device.setMode(mode);
    if (mode === PowerMode.Source) await device.setVdd(Number($('vdd-num').value));
    syncUI();
  }),
);

async function applyVdd(mV) {
  const v = clampVdd(mV);
  $('vdd-num').value = v;
  if (device?.mode !== PowerMode.Source) return;
  await device.setVdd(v);
  if (isRecording()) session.info.vdd = v;
}

// Steppers: − and + either side of a number box. A click steps once; holding repeats.
for (const btn of document.querySelectorAll('.step')) {
  const input = btn.parentElement.querySelector('input');
  const step = () => {
    input.value = clamp((Number(input.value) || 0) + Number(btn.dataset.step), Number(input.min), Number(input.max));
    input.dispatchEvent(new Event('change'));
  };
  let timer = 0;
  const stop = () => clearTimeout(timer);
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    step();
    timer = setTimeout(function repeat() {
      step();
      timer = setTimeout(repeat, 75);
    }, 400);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(type, stop);
  btn.addEventListener('click', (e) => e.detail === 0 && step()); // keyboard (Enter or Space)
}
$('vdd-num').addEventListener('change', () => guarded(() => applyVdd(Number($('vdd-num').value) || 3000)));
$('dut-power').addEventListener('change', () => guarded(() => device?.setDutPower($('dut-power').checked)));

$('btn-connect').addEventListener('click', () => connect(connectSerial));
$('btn-demo').addEventListener('click', () => connect(async () => new DemoTransport()));
$('btn-disconnect').addEventListener('click', () => guarded(disconnect));
$('btn-start').addEventListener('click', () => guarded(() => (isRecording() ? endRecording() : startRecording())));

// Sample rate, duration and memory
for (const rate of SAMPLE_RATES) $('rate').add(new Option(fmt.rateLabel(rate), String(rate)));
$('rate').value = String(settings.rate);
$('rate').addEventListener('change', () => {
  settings.rate = Number($('rate').value);
  saveSettings();
  syncUI();
});
$('limit').value = settings.limit || '';
$('limit').addEventListener('change', () => {
  settings.limit = readNumber($('limit'), { min: 0, fallback: 0 });
  $('limit').value = settings.limit || '';
  saveSettings();
});
$('buffer').value = String(settings.buffer);
$('buffer').addEventListener('change', () => {
  settings.buffer = Number($('buffer').value);
  saveSettings();
  syncUI();
});

// Trigger
const trig = settings.trigger;
$('trig-on').checked = trig.enabled;
$('trig-unit').value = String(trig.unit);
$('trig-level').value = +(trig.level / trig.unit).toPrecision(6);
$('trig-window').value = trig.windowMs;
$('trig-pre').value = trig.prePercent;
segmented('trig-edge', trig.edge, (v) => updateTrigger({ edge: v }));
segmented('trig-mode', trig.mode, (v) => updateTrigger({ mode: v }));

function updateTrigger(patch) {
  Object.assign(settings.trigger, patch);
  saveSettings();
  if ('enabled' in patch && isRecording()) {
    if (patch.enabled) recorder.trigger.arm();
    else recorder.trigger.disarm();
  }
  applyTrigger();
  syncUI();
}

const triggerLevel = () => (Number($('trig-level').value) || 0) * Number($('trig-unit').value);
$('trig-on').addEventListener('change', () => updateTrigger({ enabled: $('trig-on').checked }));
$('trig-level').addEventListener('change', () => updateTrigger({ level: triggerLevel() }));
$('trig-unit').addEventListener('change', () =>
  updateTrigger({ unit: Number($('trig-unit').value), level: triggerLevel() }),
);
$('trig-window').addEventListener('change', () =>
  updateTrigger({ windowMs: readNumber($('trig-window'), { min: 0.01, fallback: 10 }) }),
);
$('trig-pre').addEventListener('change', () =>
  updateTrigger({ prePercent: readNumber($('trig-pre'), { min: 0, max: 90, fallback: 0 }) }),
);

// Display
segmented('yscale', settings.yLog ? 'log' : 'linear', (v) => {
  settings.yLog = v === 'log';
  chart.configure({ yLog: settings.yLog });
  saveSettings();
});
$('show-digital').checked = settings.showDigital;
$('show-digital').addEventListener('change', () => {
  settings.showDigital = $('show-digital').checked;
  chart.configure({ showDigital: settings.showDigital });
  saveSettings();
});
for (let ch = 0; ch < DIGITAL_CHANNELS; ch++) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `D${ch}`;
  const pressed = () => b.setAttribute('aria-pressed', String(!!(settings.channels & (1 << ch))));
  pressed();
  b.addEventListener('click', () => {
    settings.channels ^= 1 << ch;
    chart.configure({ channels: settings.channels });
    pressed();
    saveSettings();
  });
  $('channels').append(b);
}

// Spike filter
const spikeInputs = { samples: $('spike-samples'), alpha: $('spike-alpha'), alpha5: $('spike-alpha5') };
function applySpike() {
  for (const [k, el] of Object.entries(spikeInputs)) el.value = settings.spike[k];
  device?.setSpikeFilter(settings.spike);
  saveSettings();
}
for (const [k, el] of Object.entries(spikeInputs)) {
  el.addEventListener('change', () => {
    const [min, max, round] = k === 'samples' ? [1, 10, true] : [0.01, 1, false];
    settings.spike[k] = readNumber(el, { min, max, round, fallback: DEFAULT_SPIKE_FILTER[k] });
    applySpike();
  });
}
$('btn-spike-reset').addEventListener('click', () => {
  settings.spike = { ...DEFAULT_SPIKE_FILTER };
  applySpike();
});
for (const [k, el] of Object.entries(spikeInputs)) el.value = settings.spike[k];

// Chart toolbar
segmented('tool', settings.tool, (v) => {
  settings.tool = v;
  chart.configure({ tool: v });
  saveSettings();
});
const SPANS = [0.001, 0.01, 0.1, 0.5, 1, 4, 10, 30, 60, 300, 600, 1800, 3600];
const spanSelect = $('span');
const customSpan = new Option('', 'custom');
customSpan.hidden = true;
spanSelect.add(customSpan);
for (const s of SPANS) spanSelect.add(new Option(s < 60 ? fmt.si(s, 's', 1) : `${s / 60} min`, String(s)));
spanSelect.addEventListener('change', () => {
  if (spanSelect.value === 'custom') return;
  settings.spanSec = Number(spanSelect.value);
  chart.setSpanSeconds(settings.spanSec);
  saveSettings();
});
$('btn-zoom-in').addEventListener('click', () => chart.zoom(0.5));
$('btn-zoom-out').addEventListener('click', () => chart.zoom(2));
$('btn-fit').addEventListener('click', () => chart.fitAll());
$('btn-live').addEventListener('click', () => chart.setLive(!chart.live));

chart.onselect = () => requestStats();
chart.onviewchange = () => requestStats();

// Files
$('csv-digital').checked = settings.csvDigital;
$('csv-digital').addEventListener('change', () => {
  settings.csvDigital = $('csv-digital').checked;
  saveSettings();
});

async function fileTask(label, fn) {
  if (busy) return;
  busy = true;
  syncUI();
  let last = 0;
  const progress = (f) => {
    const now = performance.now();
    if (now - last > 250) {
      last = now;
      toast(`${label}… ${Math.round(f * 100)} %`, 'info', 0);
    }
  };
  try {
    await fn(progress);
  } catch (e) {
    if (files.isAbort(e)) $('toast').hidden = true;
    else reportError(e);
  } finally {
    busy = false;
    syncUI();
  }
}

$('btn-save').addEventListener('click', () =>
  fileTask('Saving', async (progress) => {
    await files.saveSession(session.store, session.info, progress);
    session.unsaved = false;
    toast('Recording saved.');
  }),
);

$('btn-open').addEventListener('click', () => {
  if (isRecording()) return toast('Stop sampling before opening a recording.');
  if (hasUnsaved() && !confirm('Opening a file discards the current recording. Continue?')) return;
  $('file-open').click();
});
$('file-open').addEventListener('change', () => {
  const file = $('file-open').files[0];
  $('file-open').value = '';
  if (!file) return;
  fileTask('Opening', async (progress) => {
    const { store, info } = await files.loadSession(file, progress);
    session = { store, info, unsaved: false };
    chart.setStore(store);
    chart.yAuto = true;
    chart.fitAll();
    toast(`Opened ${file.name}.`);
  });
});

$('btn-csv-sel').addEventListener('click', () => {
  const sel = chart.selection;
  if (!sel) return;
  fileTask('Exporting', async (progress) => {
    await files.exportCsv(session.store, sel.a, sel.b, { digital: settings.csvDigital }, progress);
    toast('Selection exported.');
  });
});
$('btn-csv-all').addEventListener('click', () => {
  const store = session.store;
  const rows = store.length;
  if (rows > 20_000_000 && !confirm(`This writes ${(rows / 1e6).toFixed(0)} million rows, which takes a while and makes a large file. Continue?`)) return;
  fileTask('Exporting', async (progress) => {
    await files.exportCsv(store, store.start, store.end, { digital: settings.csvDigital }, progress);
    toast('Recording exported.');
  });
});
$('btn-png').addEventListener('click', () => files.savePng($('chart')));

// Keyboard: space starts and stops when focus isn't in a form control.
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || !device) return;
  if (['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA', 'SUMMARY'].includes(e.target.tagName)) return;
  e.preventDefault();
  guarded(() => (isRecording() ? endRecording() : startRecording()));
});

// Number boxes take digits only, plus a decimal point where the step allows fractions (no
// settings are negative, and "e" for exponents isn't wanted). Applies to boxes added later too.
const numberBox = (el) => el instanceof HTMLInputElement && el.type === 'number';
const allowsFraction = (el) => el.step === 'any' || !Number.isInteger(Number(el.step || 1));
document.addEventListener('focusin', (e) => {
  if (numberBox(e.target)) e.target.inputMode = allowsFraction(e.target) ? 'decimal' : 'numeric';
});
document.addEventListener('keydown', (e) => {
  if (!numberBox(e.target) || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!/\d/.test(e.key) && !(e.key === '.' && allowsFraction(e.target))) e.preventDefault();
});
document.addEventListener('paste', (e) => {
  if (!numberBox(e.target)) return;
  const text = e.clipboardData.getData('text').trim();
  if (!(allowsFraction(e.target) ? /^\d*\.?\d*$/ : /^\d*$/).test(text)) e.preventDefault();
});

// Hints: a click only focuses the "?" (so it doesn't toggle a section it sits in); Escape closes it.
document.addEventListener('click', (e) => {
  const tip = e.target.closest('.tip-btn');
  if (!tip) return;
  e.preventDefault();
  tip.focus(); // Safari doesn't focus buttons on click
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.closest?.('.tip-btn')) e.target.blur();
});

window.addEventListener('beforeunload', (e) => {
  if (!hasUnsaved()) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---- view updates ---------------------------------------------------------

function triggerStatus() {
  const t = settings.trigger;
  const trg = recorder.trigger;
  if (!t.enabled) return '';
  if (isRecording()) {
    if (trg.state === 'capturing') return 'Triggered, capturing…';
    if (t.mode === 'continuous' && trg.captures) return `${trg.captures} captures so far.`;
    return `Waiting for current to ${t.edge === 'rising' ? 'rise above' : 'fall below'} ${fmt.current(t.level)}.`;
  }
  // Only describe a capture if it belongs to the recording on screen.
  if (trg.last && recorder.store === session.store) {
    return `Triggered at ${fmt.duration(session.store.timeOf(trg.last.trigger), 6)}. Press Start to arm it again.`;
  }
  return 'Press Start to arm the trigger.';
}

function syncUI() {
  const connected = !!device;
  const recording = isRecording();
  $('conn').dataset.state = recording ? 'rec' : connected ? 'on' : 'off';
  setText(
    $('conn-text'),
    connecting
      ? 'Connecting…'
      : recording
        ? `Sampling at ${fmt.rateLabel(recorder.rate)}`
        : connected
          ? `Connected to ${device.label}`
          : 'Not connected',
  );

  for (const el of document.querySelectorAll('[data-when="disconnected"]')) el.hidden = connected;
  for (const el of document.querySelectorAll('[data-when="connected"]')) el.hidden = !connected;
  $('btn-connect').disabled = connecting || !SerialTransport.supported;
  $('btn-demo').disabled = connecting;
  for (const el of document.querySelectorAll('[data-needs="device"]')) el.dataset.disabled = String(!connected);

  const source = !connected || device.mode === PowerMode.Source;
  $('vdd-field').hidden = !source;
  setText(
    $('mode-hint'),
    source
      ? 'The PPK2 powers your device from VOUT and measures what it draws.'
      : 'Wire the PPK2 in series with your own supply: supply to VIN, your device to VOUT.',
  );
  modeSeg.disable(recording);

  const start = $('btn-start');
  setText(start, recording ? 'Stop' : settings.trigger.enabled ? 'Start and wait for trigger' : 'Start');
  start.dataset.running = String(recording);
  start.disabled = !connected;
  $('rate').disabled = recording;

  const hasData = !!session.store?.length;
  const fileBlocked = recording || busy;
  $('btn-save').disabled = !hasData || fileBlocked;
  $('btn-csv-all').disabled = !hasData || fileBlocked;
  $('btn-open').disabled = fileBlocked;
  $('btn-png').disabled = !hasData;
  $('chart-empty').hidden = hasData || recording;

  const keeps = fmt.humanDuration(SampleStore.capacityFor(settings.buffer) / settings.rate);
  setHTML(
    $('buffer-hint'),
    `<p>Keeps the last <span class="value">${keeps}</span> at <span class="value">${fmt.rateLabel(settings.rate)}</span>.</p>` +
      '<p>Change the memory limit under Advanced.</p>',
  );

  const summary = $('trig-summary');
  const tState = recorder.trigger.state;
  setText(
    summary,
    !settings.trigger.enabled ? 'Off' : recording && tState === 'armed' ? 'Waiting' : recording && tState === 'capturing' ? 'Capturing' : 'On',
  );
  summary.dataset.on = String(settings.trigger.enabled);
  setText($('trig-status'), triggerStatus());

  requestStats();
}

let statsQueued = false;
let selectionRowShown = false;
function requestStats() {
  if (statsQueued) return;
  statsQueued = true;
  requestAnimationFrame(() => {
    statsQueued = false;
    updateStats();
  });
}

/** Supply voltage in volts when the recording's energy can be worked out (source meter mode). */
function energyVolts() {
  const { mode, vdd } = session.info ?? {};
  return mode === PowerMode.Source && vdd ? vdd / 1000 : null;
}

/**
 * One table row: Average, Min, Max, Charge, Energy for samples [from, to). The window's length
 * is in the toolbar; a selection's goes next to its label.
 */
function statsRow(label, className, store, from, to, showDuration = false) {
  const agg = store?.aggregate(from, to);
  let cells = ['—', '—', '—', '—', '—'];
  let duration = '';
  if (agg?.n) {
    const chargeUC = agg.sum / store.sampleRate;
    const volts = energyVolts();
    cells = [
      fmt.current(agg.mean),
      fmt.current(agg.validMin),
      fmt.current(agg.validMax),
      fmt.charge(chargeUC),
      volts ? fmt.energy(chargeUC * volts) : '—',
    ];
    if (showDuration) duration = ` <span class="duration">${escapeHtml(fmt.duration(agg.n / store.sampleRate, 3))}</span>`;
  }
  const tds = cells.map((v, i) => `<td${i === 4 ? ' class="energy"' : ''}>${escapeHtml(v)}</td>`).join('');
  return `<tr class="${className}"><th scope="row">${label}${duration}</th>${tds}</tr>`;
}

/** What the app is doing, for the indicator next to the live reading: [state, word, tooltip]. */
function captureStatus() {
  if (!device) return ['off', 'No device', 'Connect a PPK2, or use the simulated device.'];
  if (isRecording()) {
    if (device.mode === PowerMode.Source && !device.dutPower) {
      return ['warn', 'Output off', 'Turn on Enable power output to power your device.'];
    }
    if (recorder.trigger.state === 'armed') return ['armed', 'Waiting', 'Waiting for the trigger.'];
    return ['recording', 'Recording', ''];
  }
  return session.store?.length ? ['stopped', 'Stopped', 'Press Start for a new recording.'] : ['ready', 'Ready', 'Press Start to measure.'];
}

function updateStats() {
  const store = session.store;
  const recording = isRecording();

  // Big reading: average of the whole recording (recent current is the Window row's Average).
  if (store?.length) {
    const { num, unit } = fmt.currentParts(store.aggregate(store.start, store.end).mean);
    setText($('meter-num'), num);
    setText($('meter-unit'), unit);
  }
  $('meter').dataset.state = store?.length ? 'run' : 'idle';
  const [state, text, hint] = captureStatus();
  const status = $('status');
  status.dataset.state = state;
  status.title = hint;
  setText($('status-text'), text);

  // Window and selection. The selection row comes and goes only when no drag is in progress,
  // so the bar never changes height (and moves the chart) under the pointer.
  const [from, to] = chart.visibleRange();
  const sel = store ? chart.selection : null;
  if (!chart.selecting) selectionRowShown = !!sel;
  setHTML(
    $('stats-body'),
    statsRow('Window', 'window', store, from, to) +
      (selectionRowShown ? statsRow('Selection', 'selection', store, sel?.a, sel?.b, true) : ''),
  );
  $('stats').classList.toggle('no-energy', !energyVolts());
  $('btn-csv-sel').disabled = !sel || recording || busy;

  // Toolbar
  $('btn-live').setAttribute('aria-pressed', String(chart.live));
  const span = chart.spanSeconds;
  const preset = SPANS.find((s) => Math.abs(s - span) / s < 0.01);
  if (preset) spanSelect.value = String(preset);
  else {
    setText(customSpan, fmt.duration(span, 3));
    spanSelect.value = 'custom';
  }

  const parts = [];
  if (store?.length) {
    parts.push(`${fmt.humanDuration(store.duration)} recorded`);
    if (store.droppedSamples) parts.push('<span class="warn">memory full, oldest data dropped</span>');
    else if (recording) parts.push(`memory ${Math.round((store.length / store.capacity) * 100)} % used`);
  }
  if (recording && device.lostSamples) parts.push(`<span class="warn">${device.lostSamples.toLocaleString()} samples lost</span>`);
  if (recording && device.overruns) parts.push(`<span class="warn">${device.overruns} USB overruns</span>`);
  setHTML($('tool-status'), parts.join(', '));
}

setInterval(() => {
  if (isRecording()) syncUI();
  else updateStats();
}, 250);

// ---- start ----------------------------------------------------------------

if (!SerialTransport.supported) $('unsupported').hidden = false;
syncUI();

// Handle for poking at things from the browser console.
window.ppk2 = {
  chart,
  recorder,
  settings,
  get device() {
    return device;
  },
  get session() {
    return session;
  },
};

// ?demo connects the simulated device and starts sampling straight away.
if (new URLSearchParams(location.search).has('demo')) {
  connect(async () => new DemoTransport()).then(() =>
    guarded(async () => {
      if (!device) return;
      await device.setDutPower(true);
      $('dut-power').checked = true;
      await startRecording();
    }),
  );
}
