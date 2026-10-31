// Getting recordings and exports in and out of the browser: the save dialog
// (or a download where there isn't one, e.g. Firefox), .ppk2 save/load, CSV
// and PNG export.

import { readPpk2, writePpk2 } from './ppk2file.js';
import { DIGITAL_CHANNELS } from './protocol.js';
import { memorySink } from './zip.js';

const TYPES = {
  ppk2: { description: 'Power Profiler recording', mime: 'application/octet-stream' },
  csv: { description: 'CSV', mime: 'text/csv' },
};

/** "D0-D7" column text for each bits value, D0 first. */
const BIT_STRINGS = Array.from({ length: 256 }, (_, b) => {
  let s = '';
  for (let ch = 0; ch < DIGITAL_CHANNELS; ch++) s += (b >> ch) & 1;
  return s;
});

/**
 * Ask where to save a file of the given type. Returns a sink ({ write, patch,
 * close, abort }); without the File System Access API it collects the bytes
 * and downloads them on close.
 */
async function openSink(ext) {
  const { description, mime } = TYPES[ext];
  const name = fileName(ext);
  if ('showSaveFilePicker' in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description, accept: { [mime]: [`.${ext}`] } }],
    });
    const writable = await handle.createWritable();
    let end = 0;
    return {
      write: async (bytes) => {
        await writable.write(bytes);
        end += bytes.length;
      },
      patch: async (position, bytes) => {
        await writable.write({ type: 'write', position, data: bytes });
        await writable.seek(end);
      },
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }
  const sink = memorySink();
  return { ...sink, close: async () => download(sink.blob(mime), name), abort: async () => {} };
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

async function saveTo(ext, write) {
  const sink = await openSink(ext);
  try {
    await write(sink);
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

/** Save the whole recording as a .ppk2 file. */
export function saveSession(store, info, progress) {
  return saveTo('ppk2', (sink) => writePpk2(sink, store, info, progress));
}

/** Open a .ppk2 file (ours or nRF Connect's). */
export function loadSession(file, progress) {
  return readPpk2(file, progress);
}

/** Export samples [from, to) as CSV with the same columns as nRF Connect's export. */
export function exportCsv(store, from, to, options, progress) {
  return saveTo('csv', (sink) => writeCsv(sink, store, from, to, options, progress));
}

export async function writeCsv(sink, store, from, to, { digital = true } = {}, progress) {
  [from, to] = store.clampRange(from, to);
  const enc = new TextEncoder();
  const tDecimals = Math.max(0, Math.ceil(Math.log10(store.sampleRate / 1000)));
  await sink.write(enc.encode(digital ? 'Timestamp(ms),Current(uA),D0-D7\n' : 'Timestamp(ms),Current(uA)\n'));
  let lines = [];
  for (const seg of store.segments(from, to)) {
    for (let k = 0; k < seg.cur.length; k++) {
      const t = (store.timeOf(seg.start + k) * 1000).toFixed(tDecimals);
      const v = seg.cur[k];
      const val = v === v ? v.toFixed(4) : '';
      lines.push(digital ? `${t},${val},${BIT_STRINGS[seg.bits[k]]}` : `${t},${val}`);
      if (lines.length === 65536) {
        await sink.write(enc.encode(lines.join('\n') + '\n'));
        lines = [];
        progress?.((seg.start + k - from) / (to - from));
      }
    }
  }
  if (lines.length) await sink.write(enc.encode(lines.join('\n') + '\n'));
}

export function savePng(canvas) {
  return new Promise((resolve) =>
    canvas.toBlob((blob) => {
      download(blob, fileName('png'));
      resolve();
    }, 'image/png'),
  );
}
