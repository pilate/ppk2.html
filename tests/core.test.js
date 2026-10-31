// Run with: npm test (or node --test tests/*.test.js)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as fmt from '../js/format.js';
import { Ppk2Device } from '../js/ppk2.js';
import {
  PowerMode,
  SampleDecoder,
  command,
  encodeWord,
  findAlignment,
  linearModifiers,
  parseMetadata,
  rawForCurrent,
} from '../js/protocol.js';
import { Recorder } from '../js/recorder.js';
import { Agg, CHUNK_SIZE, SampleStore } from '../js/store.js';
import { DemoTransport } from '../js/transport.js';

const METADATA = `Calibrated: 1
R0: 1003.3804
R1: 101.1006
R2: 10.1909
R3: 0.9936
R4: 0.0533
GS0: 0.0000
GS1: 112.7700
GI0: 1.0000
O0: 106.6100
S0: -nan
I4: 0.0012
UG2: 1.0300
VDD: 3300
HW: 9173
mode: 2
IA: 56
`;


function wordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  words.forEach((w, k) => dv.setUint32(k * 4, w, true));
  return out;
}

function makeStream(currentsA, startCounter = 0) {
  const m = linearModifiers();
  return currentsA.map((a, k) => {
    const raw = rawForCurrent(a, m);
    return encodeWord(raw & 0xffff, raw >> 16, startCounter + k, k & 0xff);
  });
}

function decodeAll(decoder, chunks) {
  const values = [];
  const bits = [];
  for (const c of chunks) decoder.decode(c, (v, b) => (values.push(v), bits.push(b)));
  return { values, bits };
}

test('parses metadata keys, per-range values and nan', () => {
  const m = parseMetadata(METADATA);
  assert.equal(m.calibrated, 1);
  assert.equal(m.hw, 9173);
  assert.equal(m.vdd, 3300);
  assert.equal(m.mode, 2);
  assert.equal(m.ia, 56);
  assert.equal(m.modifiers.r[0], 1003.3804);
  assert.equal(m.modifiers.r[4], 0.0533);
  assert.equal(m.modifiers.gs[1], 112.77);
  assert.equal(m.modifiers.o[0], 106.61);
  assert.equal(m.modifiers.s[0], 0, 'nan keeps the default');
  assert.equal(m.modifiers.i[4], 0.0012);
  assert.equal(m.modifiers.ug[2], 1.03);
  assert.equal(m.hasCalibration, true);
  assert.equal(parseMetadata('Calibrated: 1\nR0: 1003\nHW: 9173\n').hasCalibration, false, 'shunt values missing');
  const full = parseMetadata('Calibrated: 0\nR0: 1003\nR1: 101\nR2: 10.1\nR3: 0.99\nR4: 0.053\n');
  assert.equal(full.calibrated, 0);
  assert.equal(full.hasCalibration, true, 'the flag alone does not mean uncalibrated');
});

test('encodes commands', () => {
  assert.deepEqual(command.vdd(3300), [0x0d, 0x0c, 0xe4]);
  assert.deepEqual(command.vdd(100), [0x0d, 0x03, 0x20], 'clamped to 800 mV');
  assert.deepEqual(command.powerMode(PowerMode.Ammeter), [0x11, 1]);
  assert.deepEqual(command.dutPower(true), [0x0c, 1]);
  assert.deepEqual(command.userGain(2, 1), [0x25, 2, 0, 0, 0x80, 0x3f]);
});

test('decodes calibrated current across ranges and split reads', () => {
  const amps = [2e-6, 50e-6, 400e-6, 3e-3, 40e-3, 300e-3];
  const currents = [];
  for (const a of amps) for (let k = 0; k < 50; k++) currents.push(a);
  const bytes = wordsToBytes(makeStream(currents));
  const d = new SampleDecoder();
  d.modifiers = linearModifiers();
  // Split at awkward offsets so words straddle reads.
  const chunks = [];
  for (let i = 0; i < bytes.length; ) {
    const n = 1 + ((i * 7) % 61);
    chunks.push(bytes.slice(i, i + n));
    i += n;
  }
  const { values, bits } = decodeAll(d, chunks);
  assert.equal(values.length, currents.length);
  assert.equal(d.lostSamples, 0);
  for (let k = 0; k < values.length; k++) {
    // Skip the spike-filtered samples right after each range change.
    if (k % 50 < 6) continue;
    const expected = currents[k] * 1e6;
    assert.ok(Math.abs(values[k] - expected) / expected < 0.01, `sample ${k}: ${values[k]} vs ${expected}`);
  }
  assert.equal(bits[7], 7);
});

test('inserts NaN for samples lost according to the counter', () => {
  const words = makeStream(new Array(100).fill(1e-3));
  const kept = [...words.slice(0, 40), ...words.slice(45)];
  const d = new SampleDecoder();
  d.modifiers = linearModifiers();
  const { values } = decodeAll(d, [wordsToBytes(kept)]);
  assert.equal(values.length, 100);
  assert.equal(d.lostSamples, 5);
  assert.ok(values.slice(40, 45).every(Number.isNaN));
  assert.ok(!Number.isNaN(values[45]));
});

test('finds word alignment after junk bytes', () => {
  const words = makeStream(new Array(64).fill(1e-3), 17);
  const bytes = wordsToBytes(words);
  const junk = new Uint8Array(bytes.length + 3);
  junk.set([0xaa, 0x55, 0x01]);
  junk.set(bytes, 3);
  assert.equal(findAlignment(junk), 3);
  const d = new SampleDecoder();
  d.modifiers = linearModifiers();
  const { values } = decodeAll(d, [junk]);
  assert.equal(values.length, 64);
  assert.equal(d.lostSamples, 0);
});

test('store aggregates match brute force across chunks and after eviction', () => {
  const store = new SampleStore(100_000, 0); // minimum: 2 chunks
  const n = Math.floor(CHUNK_SIZE * 2.6);
  const ref = new Float32Array(n);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n; i++) {
    const v = i % 9973 === 0 ? NaN : Math.fround(rnd() * 1000 - 100);
    ref[i] = v;
    store.append(v, i & 0xff);
  }
  assert.equal(store.end, n);
  assert.equal(store.start, CHUNK_SIZE, 'oldest chunk dropped');
  for (let t = 0; t < 40; t++) {
    const a = store.start + Math.floor(rnd() * (store.length - 1));
    const b = a + 1 + Math.floor(rnd() * Math.min(store.end - a - 1, t < 20 ? 5000 : CHUNK_SIZE * 1.5));
    const agg = store.aggregate(a, b, new Agg());
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let cnt = 0;
    for (let i = a; i < b; i++) {
      const v = ref[i];
      if (v !== v) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
      cnt++;
    }
    assert.equal(agg.n, b - a);
    assert.equal(agg.cnt, cnt);
    assert.equal(agg.min, min);
    assert.equal(agg.max, max);
    assert.ok(Math.abs(agg.sum - sum) < 1e-6 * Math.max(1, Math.abs(sum)), `sum ${agg.sum} vs ${sum}`);
  }
  assert.equal(store.valueAt(n - 1), ref[n - 1]);
  assert.ok(Number.isNaN(store.valueAt(0)));
});

test('recorder averages down to a lower rate', () => {
  const r = new Recorder();
  const store = r.begin({ rate: 1000, maxBytes: 0, limitSec: 0, triggerEnabled: false });
  for (let i = 0; i < 1000; i++) r.push(i < 100 ? 10 : 20, i === 50 ? 4 : 0);
  assert.equal(store.length, 10);
  assert.equal(store.valueAt(0), 10);
  assert.equal(store.bitsAt(0), 4, 'digital bits are ORed');
  assert.equal(store.valueAt(5), 20);
});

test('trigger captures a window around a rising edge', () => {
  const r = new Recorder();
  Object.assign(r.trigger, { level: 500, edge: 'rising', windowSec: 0.001, prePercent: 20, mode: 'single' });
  let captured = null;
  r.trigger.oncapture = (c) => (captured = c);
  r.begin({ rate: 100_000, maxBytes: 0, limitSec: 0, triggerEnabled: true });
  for (let i = 0; i < 1000; i++) r.push(i >= 300 && i < 350 ? 1000 : 10, 0);
  assert.deepEqual(captured, { trigger: 300, from: 280, to: 380 });
  assert.equal(r.trigger.state, 'off', 'single shot disarms itself');
  assert.deepEqual(r.trigger.last, captured);
});

test('stop-after limit fires once', () => {
  const r = new Recorder();
  let hits = 0;
  r.onlimit = () => hits++;
  const store = r.begin({ rate: 100_000, maxBytes: 0, limitSec: 0.001, triggerEnabled: false });
  for (let i = 0; i < 500; i++) r.push(1, 0);
  assert.equal(hits, 1);
  assert.equal(store.length, 100);
});

test('formats values with SI prefixes', () => {
  assert.equal(fmt.current(1234), '1.234 mA');
  assert.equal(fmt.current(0.0123), '12.30 nA');
  assert.equal(fmt.current(5.5), '5.500 µA');
  assert.equal(fmt.charge(2500), '2.500 mC');
  assert.equal(fmt.duration(0.00001), '10.00 µs');
  assert.deepEqual(fmt.ticks(0, 1, 5).values, [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1]);
});

test('end to end with the simulated device', async () => {
  const dev = new Ppk2Device(new DemoTransport());
  await dev.open();
  assert.equal(dev.metadata.hasCalibration, true);
  assert.equal(dev.mode, PowerMode.Source);
  await dev.setVdd(3000);
  await dev.setDutPower(true);
  const r = new Recorder();
  const store = r.begin({ rate: 100_000, maxBytes: 0, limitSec: 0, triggerEnabled: false });
  dev.onsample = r.sink;
  await dev.start();
  await new Promise((res) => setTimeout(res, 400));
  await dev.stop();
  await dev.close();
  assert.ok(store.length > 20_000, `got ${store.length} samples`);
  assert.equal(dev.decoder.lostSamples, 0);
  const agg = store.aggregate(store.start, store.end, new Agg());
  // Sleeps at ~3 µA with mA bursts: the max should be in the mA range.
  assert.ok(agg.min > 0 && agg.min < 10, `min ${agg.min}`);
  assert.ok(agg.max > 2000 && agg.max < 40_000, `max ${agg.max}`);
});

test('appendBlock builds the same summaries as append', () => {
  const one = new SampleStore(100_000, 0);
  const block = new SampleStore(100_000, 0);
  const n = CHUNK_SIZE + 123_457;
  const cur = new Float32Array(n);
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    cur[i] = i % 5003 === 0 ? NaN : Math.fround(Math.sin(i / 97) * 100);
    bits[i] = (i >> 7) & 0xff;
    one.append(cur[i], bits[i]);
  }
  // Odd block sizes so blocks straddle buckets and the chunk boundary.
  for (let i = 0; i < n; i += 70_001) block.appendBlock(cur.subarray(i, i + 70_001), bits.subarray(i, i + 70_001));
  assert.equal(block.end, n);
  for (const [a, b] of [[0, n], [17, 4113], [CHUNK_SIZE - 300, CHUNK_SIZE + 70_000], [65_535, 1_000_001]]) {
    const x = one.aggregate(a, b);
    const y = block.aggregate(a, b);
    assert.deepEqual([y.min, y.max, y.sum, y.cnt, y.or, y.and], [x.min, x.max, x.sum, x.cnt, x.or, x.and], `[${a}, ${b})`);
  }
});

test('BinCache stays exact while reusing bins across updates', async () => {
  const { BinCache } = await import('../js/chart.js');
  const check = (cache, store) => {
    const { first, count, spp, min, max, mean } = cache.bins;
    for (let k = 0; k < count; k++) {
      const agg = store.aggregate((first + k) * spp, (first + k + 1) * spp);
      assert.equal(min[k], agg.validMin, `bin ${first + k} min`);
      assert.equal(max[k], agg.validMax, `bin ${first + k} max`);
      assert.ok(Object.is(mean[k], agg.mean), `bin ${first + k} mean`);
    }
  };
  const store = new SampleStore(1000, 0);
  const overview = new BinCache(); // like the overview: whole recording, power-of-two buckets
  const columns = new BinCache(); // like the chart: a scrolling window, fractional bin size
  const spp = 7.3;
  const update = () => {
    let size = 1;
    while (store.length / size > 100) size *= 2;
    overview.update(store, 0, Math.floor((store.end - 1) / size) + 1, size);
    columns.update(store, Math.floor(Math.max(0, store.end - 300) / spp), 44, spp);
  };
  for (let i = 0; i < 20_000; i++) {
    store.append(i % 997 === 0 ? NaN : Math.sin(i * 0.37) * 100 + (i % 1500 === 0 ? 500 : 0), 0);
    if (i % 37 === 0) update(); // irregular updates, like frames
  }
  update();
  check(overview, store);
  check(columns, store);
  assert.ok(overview.bins.spp > 1 && overview.bins.count <= 101);
});
