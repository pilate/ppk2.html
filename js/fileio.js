// Saving and loading recordings.
//
// Session file layout (little-endian):
//   8 bytes   magic "WPPK2SES"
//   uint32    format version (1)
//   uint32    header length in bytes
//   header    UTF-8 JSON: { sampleRate, count, timeOffset, startedAt, mode, vdd, ... }
//   padding   to a 4-byte boundary
//   float32[count]  current in µA (NaN = lost sample)
//   uint8[count]    digital channels D0..D7

import { SampleStore } from './store.js';

const MAGIC = 'WPPK2SES';
const VERSION = 1;
const FIXED_HEAD = 16; // magic + version + header length
const BLOCK = 1 << 20;

/** Byte offset of the sample data for a JSON header of `jsonLen` bytes. */
const dataOffset = (jsonLen) => Math.ceil((FIXED_HEAD + jsonLen) / 4) * 4;

/** Ask for a destination file; falls back to a download when the File System Access API is missing. */
async function openSink(suggestedName, description, mime, ext) {
  if ('showSaveFilePicker' in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description, accept: { [mime]: [ext] } }],
    });
    const writable = await handle.createWritable();
    return {
      write: (part) => writable.write(part),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }
  const parts = [];
  return {
    write: async (part) => parts.push(part),
    close: async () => download(new Blob(parts, { type: mime }), suggestedName),
    abort: async () => {},
  };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function isAbort(e) {
  return e?.name === 'AbortError';
}

/** Timestamped file name, e.g. "ppk2-20261030-193455.csv". */
function fileName(ext, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const t = `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `ppk2-${d}-${t}.${ext}`;
}

/**
 * Write the whole recording as a session file.
 * @param {SampleStore} store
 * @param {object} info extra header fields
 * @param {(fraction: number) => void} [progress]
 */
export async function saveSession(store, info, progress) {
  const from = store.start;
  const to = store.end;
  const json = new TextEncoder().encode(
    JSON.stringify({ app: 'ppk2.html', sampleRate: store.sampleRate, count: to - from, timeOffset: store.timeOf(from), ...info }),
  );
  const head = new Uint8Array(dataOffset(json.length));
  head.set(new TextEncoder().encode(MAGIC), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(8, VERSION, true);
  dv.setUint32(12, json.length, true);
  head.set(json, FIXED_HEAD);

  const sink = await openSink(fileName('wppk2'), 'PPK2 session', 'application/octet-stream', '.wppk2');
  try {
    await sink.write(head);
    const total = (to - from) * 2;
    let done = 0;
    for (const field of ['cur', 'bits']) {
      for (const seg of store.segments(from, to)) {
        await sink.write(seg[field]);
        done += seg[field].length;
        progress?.(done / total);
      }
    }
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

/**
 * Read a session file into a new store sized to hold all of it.
 * @param {File} file
 * @returns {Promise<{ store: SampleStore, header: object }>}
 */
export async function loadSession(file, maxBytes, progress) {
  const head = new Uint8Array(await file.slice(0, FIXED_HEAD).arrayBuffer());
  if (new TextDecoder().decode(head.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error(`${file.name} is not a session saved by this app.`);
  }
  const dv = new DataView(head.buffer);
  if (dv.getUint32(8, true) > VERSION) throw new Error(`${file.name} was saved by a newer version of this app.`);
  const jsonLen = dv.getUint32(12, true);
  const header = JSON.parse(new TextDecoder().decode(await file.slice(FIXED_HEAD, FIXED_HEAD + jsonLen).arrayBuffer()));
  const curStart = dataOffset(jsonLen);
  const count = header.count;
  const bitsStart = curStart + count * 4;
  if (file.size < bitsStart + count) throw new Error(`${file.name} is truncated.`);

  const store = new SampleStore(header.sampleRate, Math.max(maxBytes, SampleStore.bytesFor(count)));
  store.timeOffset = header.timeOffset ?? 0;
  for (let i = 0; i < count; i += BLOCK) {
    const n = Math.min(BLOCK, count - i);
    const [curBuf, bitsBuf] = await Promise.all([
      file.slice(curStart + i * 4, curStart + (i + n) * 4).arrayBuffer(),
      file.slice(bitsStart + i, bitsStart + i + n).arrayBuffer(),
    ]);
    const cur = new Float32Array(curBuf);
    const bits = new Uint8Array(bitsBuf);
    for (let k = 0; k < n; k++) store.append(cur[k], bits[k]);
    progress?.((i + n) / count);
  }
  return { store, header };
}

/**
 * CSV with the same columns as nRF Connect's Power Profiler export.
 * @param {SampleStore} store
 */
export async function exportCsv(store, from, to, { digital = true } = {}, progress) {
  from = Math.max(store.start, Math.floor(from));
  to = Math.min(store.end, Math.ceil(to));
  const sink = await openSink(fileName('csv'), 'CSV', 'text/csv', '.csv');
  const enc = new TextEncoder();
  const tDecimals = Math.max(0, Math.ceil(Math.log10(store.sampleRate / 1000)));
  const bitStr = Array.from({ length: 256 }, (_, b) => {
    let s = '';
    for (let ch = 0; ch < 8; ch++) s += (b >> ch) & 1;
    return s;
  });
  try {
    await sink.write(enc.encode(digital ? 'Timestamp(ms),Current(uA),D0-D7\n' : 'Timestamp(ms),Current(uA)\n'));
    let lines = [];
    for (const seg of store.segments(from, to)) {
      for (let k = 0; k < seg.cur.length; k++) {
        const t = (store.timeOf(seg.start + k) * 1000).toFixed(tDecimals);
        const v = seg.cur[k];
        const val = v === v ? v.toFixed(4) : '';
        lines.push(digital ? `${t},${val},${bitStr[seg.bits[k]]}` : `${t},${val}`);
        if (lines.length === 65536) {
          await sink.write(enc.encode(lines.join('\n') + '\n'));
          lines = [];
          progress?.((seg.start + k - from) / (to - from));
        }
      }
    }
    if (lines.length) await sink.write(enc.encode(lines.join('\n') + '\n'));
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

export function savePng(canvas) {
  return new Promise((resolve) =>
    canvas.toBlob((blob) => {
      download(blob, fileName('png'));
      resolve();
    }, 'image/png'),
  );
}
