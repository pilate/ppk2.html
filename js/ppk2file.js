// The .ppk2 recording format of Nordic's nRF Connect Power Profiler, so files
// move freely between the two apps.
//
// A .ppk2 file is a ZIP archive holding:
//   metadata.json  { metadata: { samplesPerSecond, startSystemTime }, formatVersion: 2 }
//                  (we add a "ppk2html" object with mode, supply voltage, source device and
//                  time offset; nRF Connect ignores it)
//   minimap.raw    JSON overview of the recording, which nRF Connect needs to open the file
//   session.raw    6 bytes per sample: float32 LE current in µA (NaN = lost sample), then
//                  uint16 BE digital channels with 2 bits per channel: 01 low, 10 high,
//                  11 toggled within the sample (channel n in bits 2n and 2n+1)

import { DIGITAL_CHANNELS } from './protocol.js';
import { SampleStore } from './store.js';
import { ZipWriter, openZipEntry, readZipDirectory, readZipText } from './zip.js';

const FORMAT_VERSION = 2;
const RECORD = 6;
/** Recording details kept in metadata.json's "ppk2html" object, besides the time offset. */
const EXTRA_INFO = ['mode', 'vdd', 'source'];

/** 8 channel bits → nRF Connect's 2-bits-per-channel form. */
const BITS_TO_PAIRS = Uint16Array.from({ length: 256 }, (_, b) => {
  let v = 0;
  for (let ch = 0; ch < DIGITAL_CHANNELS; ch++) v |= ((b >> ch) & 1 ? 2 : 1) << (2 * ch);
  return v;
});

/** And back; a channel that toggled within the sample (11) counts as high, like our averaging does. */
const PAIRS_TO_BITS = Uint8Array.from({ length: 65536 }, (_, v) => {
  let b = 0;
  for (let ch = 0; ch < DIGITAL_CHANNELS; ch++) if ((v >> (2 * ch)) & 2) b |= 1 << ch;
  return b;
});

/**
 * Builds minimap.raw. A port of nRF Connect's FoldingBuffer, quirks included:
 * up to 10 000 min/max buckets (x in µs, y in nA, floored at 200 nA); once the
 * 10 000th bucket is created, pairs of buckets merge and each covers twice as
 * many samples.
 */
export class FoldingBuffer {
  constructor(maxElements = 10_000) {
    this.maxNumberOfElements = maxElements;
    this.numberOfTimesToFold = 1; // samples per bucket
    this.lastElementFoldCount = 0; // samples in the newest bucket so far
    this.length = 0;
    this.x = new Float64Array(maxElements); // nRF keeps identical x values for min and max
    this.minY = new Float64Array(maxElements);
    this.maxY = new Float64Array(maxElements);
  }

  add(uA, timestampUs) {
    if (this.lastElementFoldCount === 0) {
      const i = this.length++;
      this.x[i] = timestampUs;
      this.minY[i] = Number.MAX_VALUE;
      this.maxY[i] = -Number.MAX_VALUE;
    }
    let v = uA * 1000;
    if (v < 200) v = 200;
    this.lastElementFoldCount++;
    const a = 1 / this.lastElementFoldCount;
    const i = this.length - 1;
    this.x[i] = timestampUs * a + this.x[i] * (1 - a);
    if (v === v) {
      if (v < this.minY[i]) this.minY[i] = v;
      if (v > this.maxY[i]) this.maxY[i] = v;
    }
    if (this.lastElementFoldCount === this.numberOfTimesToFold) this.lastElementFoldCount = 0;
    if (this.length === this.maxNumberOfElements) this._fold();
  }

  _fold() {
    this.numberOfTimesToFold *= 2;
    for (let i = 0; i < this.maxNumberOfElements / 2; i++) {
      const j = 2 * i;
      this.x[i] = (this.x[j] + this.x[j + 1]) / 2;
      this.minY[i] = Math.min(this.minY[j], this.minY[j + 1]);
      this.maxY[i] = Math.max(this.maxY[j], this.maxY[j + 1]);
    }
    this.length /= 2;
  }

  toJSON() {
    const points = (ys) =>
      Array.from({ length: this.maxNumberOfElements }, (_, i) => (i < this.length ? { x: this.x[i], y: ys[i] } : null));
    return {
      lastElementFoldCount: this.lastElementFoldCount,
      data: { length: this.length, min: points(this.minY), max: points(this.maxY) },
      maxNumberOfElements: this.maxNumberOfElements,
      numberOfTimesToFold: this.numberOfTimesToFold,
    };
  }
}

/**
 * Write a whole recording as .ppk2 to a sink ({ write, patch }; see zip.js).
 * @param {SampleStore} store
 * @param {{ startedAt?: string, mode?: number, vdd?: number, source?: string }} info
 * @param {(fraction: number) => void} [progress]
 */
export async function writePpk2(sink, store, info, progress) {
  const usPerSample = 1e6 / store.sampleRate;
  const timeOffset = store.timeOf(store.start);

  const minimap = new FoldingBuffer();
  for (const seg of store.segments(store.start, store.end)) {
    const base = seg.start - store.start;
    for (let k = 0; k < seg.cur.length; k++) minimap.add(seg.cur[k], (base + k) * usPerSample);
  }
  progress?.(0.1);

  // startSystemTime is the wall-clock time of the first saved sample.
  const started = Date.parse(info.startedAt);
  const metadata = {
    metadata: {
      samplesPerSecond: store.sampleRate,
      startSystemTime: Number.isFinite(started) ? Math.round(started + timeOffset * 1000) : undefined,
    },
    formatVersion: FORMAT_VERSION,
    ppk2html: { ...Object.fromEntries(EXTRA_INFO.map((k) => [k, info[k]])), timeOffset },
  };

  const zip = new ZipWriter(sink);
  const enc = new TextEncoder();
  await zip.add('metadata.json', [enc.encode(JSON.stringify(metadata))]);
  await zip.add('minimap.raw', [enc.encode(JSON.stringify(minimap))]);
  await zip.add('session.raw', sessionRecords(store, (f) => progress?.(0.1 + 0.9 * f)), store.length * RECORD);
  await zip.finish();
}

function* sessionRecords(store, progress) {
  for (const seg of store.segments(store.start, store.end)) {
    const n = seg.cur.length;
    const out = new Uint8Array(n * RECORD);
    const v = new DataView(out.buffer);
    for (let k = 0; k < n; k++) {
      v.setFloat32(k * RECORD, seg.cur[k], true);
      v.setUint16(k * RECORD + 4, BITS_TO_PAIRS[seg.bits[k]], false);
    }
    yield out;
    progress((seg.start + n - store.start) / store.length);
  }
}

/**
 * Read a .ppk2 file (ours or nRF Connect's) into a new store sized to hold all of it.
 * @param {File} file
 * @returns {Promise<{ store: SampleStore, info: object }>}
 */
export async function readPpk2(file, progress) {
  const entries = await readZipDirectory(file).catch(() => new Map());
  const sessionEntry = entries.get('session.raw');
  const metaEntry = entries.get('metadata.json');
  if (!sessionEntry || !metaEntry) throw new Error(`${file.name} is not a .ppk2 recording.`);

  const meta = JSON.parse(await readZipText(file, metaEntry));
  const rate = meta?.metadata?.samplesPerSecond;
  if (!(rate > 0)) throw new Error(`${file.name} doesn't say what sample rate it was recorded at.`);
  const extra = meta.ppk2html ?? {};
  const timeOffset = Number.isFinite(extra.timeOffset) ? extra.timeOffset : 0;

  const count = Math.floor(sessionEntry.size / RECORD);
  const store = new SampleStore(rate, SampleStore.bytesFor(count));
  store.timeOffset = timeOffset;

  // Decode each read in place; only a record split across two reads goes through `split`.
  const cur = new Float32Array(1 << 16);
  const bits = new Uint8Array(1 << 16);
  const split = new Uint8Array(RECORD);
  const splitView = new DataView(split.buffer);
  let splitLen = 0;
  let n = 0;
  const flush = () => {
    store.appendBlock(cur, bits, n);
    n = 0;
  };
  const reader = (await openZipEntry(file, sessionEntry)).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let o = 0;
    if (splitLen) {
      o = Math.min(RECORD - splitLen, value.length);
      split.set(value.subarray(0, o), splitLen);
      splitLen += o;
      if (splitLen < RECORD) continue;
      cur[n] = splitView.getFloat32(0, true);
      bits[n++] = PAIRS_TO_BITS[splitView.getUint16(4, false)];
      splitLen = 0;
    }
    const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
    for (; o + RECORD <= value.length; o += RECORD) {
      if (n === cur.length) flush();
      cur[n] = v.getFloat32(o, true);
      bits[n++] = PAIRS_TO_BITS[v.getUint16(o + 4, false)];
    }
    split.set(value.subarray(o));
    splitLen = value.length - o;
    if (n === cur.length) flush();
    progress?.((store.length + n) / count);
  }
  flush();

  const started = meta.metadata.startSystemTime;
  const info = {
    startedAt: Number.isFinite(started) ? new Date(started - timeOffset * 1000).toISOString() : undefined,
    ...Object.fromEntries(EXTRA_INFO.map((k) => [k, extra[k]])),
  };
  return { store, info };
}
