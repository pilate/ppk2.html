// UI wiring: connects controls, the device, the recorder and the chart.

import { Chart, Minimap, signalName } from './chart.js';
import * as files from './fileio.js';
import * as fmt from './format.js';
import { Ppk2Device } from './ppk2.js';
import { DEFAULT_SPIKE_FILTER, DIGITAL_CHANNELS, MODIFIER_FIELDS, PowerMode, RANGE_COUNT } from './protocol.js';
import { Recorder, SAMPLE_RATES } from './recorder.js';
import { DEFAULTS, loadSettings, saveSettings } from './settings.js';
import { SampleStore } from './store.js';
import { DemoTransport, SerialTransport } from './transport.js';
import { $, definitionList, escapeHtml, initWidgets, readNumber, segmented, setHTML, setText, toast } from './ui.js';

// ---- state ----------------------------------------------------------------

const settings = loadSettings();
const save = () => saveSettings(settings);

const chart = new Chart($('chart'));
new Minimap($('minimap'), chart);
const recorder = new Recorder();
recorder.trigger.configure(settings.trigger);

let device = null;
let connecting = false;
let busy = false; // a file operation is running
/** The recording on screen: its samples, recording details ({ startedAt, mode, vdd, source }) and save state. */
let session = { store: null, info: null, unsaved: false };

const isRecording = () => !!device?.sampling;
const hasUnsaved = () => session.unsaved && !!session.store?.length;

chart.configure({
  rate: settings.rate,
  tool: settings.tool,
  yLog: settings.yLog,
  showDigital: settings.showDigital,
  channels: settings.channels,
  main: settings.main,
});
chart.setSpanSeconds(settings.spanSec);
chart.onmainchange = (main) => {
  settings.main = main;
  save();
};

// ---- helpers --------------------------------------------------------------

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

/** Keep a checkbox and a boolean setting in step; `apply` runs after each change. */
function bindCheckbox(id, key, apply) {
  const el = $(id);
  el.checked = settings[key];
  el.addEventListener('change', () => {
    settings[key] = el.checked;
    apply?.();
    save();
  });
}

/** Keep a select and a numeric setting in step; `apply` runs after each change. */
function bindSelect(id, key, apply) {
  const el = $(id);
  el.value = String(settings[key]);
  el.addEventListener('change', () => {
    settings[key] = Number(el.value);
    apply?.();
    save();
  });
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
    // A real PPK2 starts with VOUT off so nothing gets powered by surprise; the simulated one has nothing to protect.
    await dev.setDutPower(transport instanceof DemoTransport);
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

  const rangeName = (r) => (r === 0 ? 'Range 1 (lowest)' : r === RANGE_COUNT - 1 ? `Range ${r + 1} (highest)` : `Range ${r + 1}`);
  $('gains').innerHTML = device.userGains
    .map(
      (gain, r) => `<div class="row">
        <label for="gain-${r}">${rangeName(r)}</label>
        <span class="box"><input id="gain-${r}" data-range="${r}" type="number" min="80" max="120" step="0.1" value="${(gain * 100).toFixed(1)}" /><span class="unit">%</span></span>
      </div>`,
    )
    .join('');

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

$('gains').addEventListener('change', (e) =>
  guarded(() => device?.setUserGain(Number(e.target.dataset.range), readNumber(e.target, 100) / 100)),
);

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
    await endRecording();
    return;
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

initWidgets();

const modeSeg = segmented('mode', PowerMode.Source, (v) =>
  guarded(async () => {
    if (!device) return;
    const mode = Number(v);
    await device.setMode(mode);
    if (mode === PowerMode.Source) await device.setVdd(Number($('vdd-num').value));
    syncUI();
  }),
);

$('vdd-num').addEventListener('change', () =>
  guarded(async () => {
    const mV = readNumber($('vdd-num'), device?.vdd ?? 3000);
    if (device?.mode !== PowerMode.Source) return;
    await device.setVdd(mV);
    if (isRecording()) session.info.vdd = mV;
  }),
);
$('dut-power').addEventListener('change', () =>
  guarded(async () => {
    await device?.setDutPower($('dut-power').checked);
    syncUI();
  }),
);

$('btn-connect').addEventListener('click', () => connect(connectSerial));
$('btn-demo').addEventListener('click', () => connect(async () => new DemoTransport()));
$('btn-disconnect').addEventListener('click', () => guarded(disconnect));
for (const btn of document.querySelectorAll('.start-btn')) {
  btn.addEventListener('click', () => guarded(() => (isRecording() ? endRecording() : startRecording())));
}

function showSide(show) {
  document.body.classList.toggle('side-hidden', !show);
  const btn = $('btn-side');
  btn.setAttribute('aria-expanded', String(show));
  btn.title = show ? 'Hide the settings' : 'Show the settings';
  btn.setAttribute('aria-label', btn.title);
}
showSide(!settings.sideHidden);
$('btn-side').addEventListener('click', () => {
  settings.sideHidden = !settings.sideHidden;
  save();
  showSide(!settings.sideHidden);
});

// Sample rate, duration and memory
for (const rate of SAMPLE_RATES) $('rate').add(new Option(fmt.rateLabel(rate), String(rate)));
bindSelect('rate', 'rate', syncUI);
bindSelect('buffer', 'buffer', syncUI);
$('limit').value = settings.limit || '';
$('limit').addEventListener('change', () => {
  settings.limit = readNumber($('limit'), 0);
  $('limit').value = settings.limit || '';
  save();
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
  save();
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
  updateTrigger({ windowMs: readNumber($('trig-window'), DEFAULTS.trigger.windowMs) }),
);
$('trig-pre').addEventListener('change', () =>
  updateTrigger({ prePercent: readNumber($('trig-pre'), DEFAULTS.trigger.prePercent) }),
);

// Display
segmented('yscale', settings.yLog ? 'log' : 'linear', (v) => {
  settings.yLog = v === 'log';
  chart.configure({ yLog: settings.yLog });
  save();
});
bindCheckbox('show-digital', 'showDigital', () => chart.configure({ showDigital: settings.showDigital }));
for (let ch = 0; ch < DIGITAL_CHANNELS; ch++) {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: signalName(ch) });
  const pressed = () => b.setAttribute('aria-pressed', String(!!(settings.channels & (1 << ch))));
  pressed();
  b.addEventListener('click', () => {
    settings.channels ^= 1 << ch;
    chart.configure({ channels: settings.channels });
    pressed();
    save();
  });
  $('channels').append(b);
}

// Spike filter
const spikeInputs = { samples: $('spike-samples'), alpha: $('spike-alpha'), alpha5: $('spike-alpha5') };
function applySpike() {
  for (const [k, el] of Object.entries(spikeInputs)) el.value = settings.spike[k];
  device?.setSpikeFilter(settings.spike);
}
for (const [k, el] of Object.entries(spikeInputs)) {
  el.addEventListener('change', () => {
    settings.spike[k] = readNumber(el, DEFAULT_SPIKE_FILTER[k]);
    applySpike();
    save();
  });
}
$('btn-spike-reset').addEventListener('click', () => {
  settings.spike = { ...DEFAULT_SPIKE_FILTER };
  applySpike();
  save();
});
applySpike();

// Chart toolbar
segmented('tool', settings.tool, (v) => {
  settings.tool = v;
  chart.configure({ tool: v });
  save();
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
  save();
});
$('btn-zoom-in').addEventListener('click', () => chart.zoom(0.5));
$('btn-zoom-out').addEventListener('click', () => chart.zoom(2));
$('btn-fit').addEventListener('click', () => chart.fitAll());
$('btn-live').addEventListener('click', () => chart.setLive(!chart.live));

chart.onselect = () => requestStats();
chart.onviewchange = () => requestStats();

// Files
bindCheckbox('csv-digital', 'csvDigital');

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
    chart.configure({ yAuto: true });
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

window.addEventListener('beforeunload', (e) => {
  if (!hasUnsaved()) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---- view updates ---------------------------------------------------------

function connectionText() {
  if (connecting) return 'Connecting…';
  if (isRecording()) return `Sampling at ${fmt.rateLabel(recorder.rate)}`;
  return device ? `Connected to ${device.label}` : 'Not connected';
}

/** What the app is doing, for the indicator next to the big reading: [state, word, tooltip]. */
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

// The trigger state is 'off' whenever nothing is recording (ending a recording disarms it).
const TRIGGER_WORDS = { armed: 'Waiting', capturing: 'Capturing' };

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
  setText($('conn-text'), connectionText());

  for (const el of document.querySelectorAll('[data-when="disconnected"]')) el.hidden = connected;
  for (const el of document.querySelectorAll('[data-when="connected"]')) el.hidden = !connected;
  $('btn-connect').disabled = connecting || !SerialTransport.supported;
  $('btn-demo').disabled = connecting;
  for (const el of document.querySelectorAll('[data-needs="device"]')) el.dataset.disabled = String(!connected);
  // Settings a recording takes at its start are locked until it ends.
  for (const el of document.querySelectorAll('[data-lock]')) {
    el.dataset.locked = String(recording);
    el.title = recording ? 'Fixed while recording' : '';
    for (const control of el.querySelectorAll('input, select, button')) control.disabled = recording;
  }

  $('vdd-field').hidden = connected && device.mode !== PowerMode.Source;

  for (const start of document.querySelectorAll('.start-btn')) {
    setText(start, recording ? 'Stop' : settings.trigger.enabled ? 'Start and wait for trigger' : 'Start');
    start.dataset.running = String(recording);
    start.disabled = !connected;
  }

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
  setText(summary, settings.trigger.enabled ? (TRIGGER_WORDS[recorder.trigger.state] ?? 'On') : 'Off');
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

/**
 * One table row: Average, Min, Max, Charge, Energy for samples [from, to) of the recording on
 * screen. Energy needs the supply voltage in volts (source meter mode only).
 */
function statsRow(label, from, to, volts, withDuration = false) {
  const store = session.store;
  const agg = store?.aggregate(from, to);
  let cells = ['—', '—', '—', '—', '—'];
  let duration = '';
  if (agg?.n) {
    const chargeUC = agg.sum / store.sampleRate;
    cells = [
      fmt.current(agg.mean),
      fmt.current(agg.validMin),
      fmt.current(agg.validMax),
      fmt.charge(chargeUC),
      volts ? fmt.energy(chargeUC * volts) : '—',
    ];
    if (withDuration) duration = ` <span class="duration">${escapeHtml(fmt.duration(agg.n / store.sampleRate, 3))}</span>`;
  }
  const tds = cells.map((v, i) => `<td${i === 4 ? ' class="energy"' : ''}>${escapeHtml(v)}</td>`).join('');
  return `<tr class="${label.toLowerCase()}"><th scope="row">${label}${duration}</th>${tds}</tr>`;
}

function updateStats() {
  const store = session.store;
  const hasData = !!store?.length;
  const recording = isRecording();

  // Big reading: average of the whole recording (recent current is the Window row's Average).
  const { num, unit } = fmt.currentParts(hasData ? store.aggregate(store.start, store.end).mean : NaN);
  setText($('meter-num'), num);
  setText($('meter-unit'), unit);
  $('meter').dataset.state = hasData ? 'run' : 'idle';
  const [state, text, hint] = captureStatus();
  const status = $('status');
  status.dataset.state = state;
  status.title = hint;
  setText($('status-text'), text);

  // Window and selection. The selection row comes and goes only when no drag is in progress,
  // so the bar never changes height (and moves the chart) under the pointer.
  const { mode, vdd } = session.info ?? {};
  const volts = mode === PowerMode.Source && vdd ? vdd / 1000 : null;
  const [from, to] = chart.visibleRange();
  const sel = store ? chart.selection : null;
  if (!chart.selecting) selectionRowShown = !!sel;
  setHTML(
    $('stats-body'),
    statsRow('Window', from, to, volts) + (selectionRowShown ? statsRow('Selection', sel?.a, sel?.b, volts, true) : ''),
  );
  $('stats').classList.toggle('no-energy', !volts);
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
  if (hasData) {
    parts.push(`${fmt.humanDuration(store.duration)} recorded`);
    if (store.droppedSamples) parts.push('<span class="warn">memory full, oldest data dropped</span>');
    else if (recording) parts.push(`memory ${Math.round((store.length / store.capacity) * 100)} % used`);
  }
  if (recording && device.lostSamples) parts.push(`<span class="warn">${device.lostSamples.toLocaleString()} samples lost</span>`);
  if (recording && device.overruns) parts.push(`<span class="warn">${device.overruns} USB overruns</span>`);
  setHTML($('tool-status'), parts.join(', '));
}

// Every write above is skipped when nothing changed, so a steady refresh is cheap.
setInterval(syncUI, 250);

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
      if (device) await startRecording();
    }),
  );
}
