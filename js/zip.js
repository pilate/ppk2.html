// Minimal ZIP reading and writing for .ppk2 files, using the browser's own
// deflate (CompressionStream), so it works in Chrome and Firefox without
// libraries. Entries are deflated; ZIP64 is used for entries or archives past
// 4 GiB. Each local header is written first and patched with the real CRC and
// sizes once the entry's data is out, so no data descriptors are needed.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const U32 = 0xffffffff;
const ZIP64_AT = 0xf0000000; // margin below 4 GiB, as deflate can grow incompressible data slightly
const FEED = 1 << 20; // input slice per compressor call, to keep main-thread stalls short
const BATCH = 4 << 20; // compressed bytes gathered per sink write

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function record(length) {
  const bytes = new Uint8Array(length);
  return [bytes, new DataView(bytes.buffer)];
}

/** Write a ZIP64 extra field holding `values` at `at`; returns its length. */
function zip64Extra(view, at, values) {
  if (!values.length) return 0;
  view.setUint16(at, 0x0001, true);
  view.setUint16(at + 2, 8 * values.length, true);
  values.forEach((n, k) => view.setBigUint64(at + 4 + 8 * k, BigInt(n), true));
  return 4 + 8 * values.length;
}

/** A sink that keeps the archive in memory; `patch` rewrites earlier bytes in place. */
export function memorySink() {
  const parts = [];
  const starts = [];
  let size = 0;
  return {
    async write(bytes) {
      parts.push(bytes);
      starts.push(size);
      size += bytes.length;
    },
    async patch(position, bytes) {
      for (let k = 0; k < parts.length; k++) {
        const a = Math.max(position, starts[k]);
        const b = Math.min(position + bytes.length, starts[k] + parts[k].length);
        if (a < b) parts[k].set(bytes.subarray(a - position, b - position), a - starts[k]);
      }
    },
    blob: (type) => new Blob(parts, { type }),
  };
}

/** Writes a ZIP archive to a sink: { write(bytes), patch(position, bytes) }. */
export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.offset = 0;
    this.entries = [];
    this.stamp = dosDateTime(new Date());
  }

  async _write(bytes) {
    await this.sink.write(bytes);
    this.offset += bytes.length;
  }

  /**
   * Add a deflated entry.
   * @param {string} name
   * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array>} chunks uncompressed data
   * @param {number} sizeHint expected uncompressed size; 4 GiB or more makes it a ZIP64 entry
   */
  async add(name, chunks, sizeHint = 0) {
    const e = { name: UTF8_ENCODER.encode(name), offset: this.offset, zip64: sizeHint >= ZIP64_AT, crc: 0, size: 0, compSize: 0 };
    const header = this._localHeader(e);
    await this._write(header);

    // Compressed output is batched into large sink writes while input is still being fed in.
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    let batch = [];
    let batched = 0;
    const flush = async () => {
      if (!batched) return;
      const out = new Uint8Array(batched);
      let at = 0;
      for (const c of batch) {
        out.set(c, at);
        at += c.length;
      }
      batch = [];
      batched = 0;
      await this._write(out);
    };
    const drained = cs.readable.pipeTo(
      new WritableStream({
        async write(c) {
          e.compSize += c.length;
          batch.push(c);
          batched += c.length;
          if (batched >= BATCH) await flush();
        },
      }),
    );
    try {
      for await (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i += FEED) {
          const piece = chunk.subarray(i, i + FEED);
          e.crc = crc32(piece, e.crc);
          e.size += piece.length;
          await writer.write(piece);
        }
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      await drained.catch(() => {});
      throw err;
    }
    await drained;
    await flush();
    if (!e.zip64 && (e.size >= U32 || e.compSize >= U32)) {
      throw new Error(`${name} grew past 4 GiB without ZIP64; pass a larger sizeHint.`);
    }

    await this.sink.patch(e.offset, this._localHeader(e));
    this.entries.push(e);
  }

  /**
   * Fields shared by local and central headers, written from `at` (version
   * needed, flags, method, time, date, CRC, sizes, name and extra lengths).
   */
  _common(view, at, e, extraLength) {
    view.setUint16(at, e.zip64 || e.offset >= U32 ? 45 : 20, true);
    view.setUint16(at + 4, 8, true); // deflate; flags at +2 stay 0
    view.setUint16(at + 6, this.stamp.time, true);
    view.setUint16(at + 8, this.stamp.day, true);
    view.setUint32(at + 10, e.crc, true);
    view.setUint32(at + 14, e.zip64 ? U32 : e.compSize, true);
    view.setUint32(at + 18, e.zip64 ? U32 : e.size, true);
    view.setUint16(at + 22, e.name.length, true);
    view.setUint16(at + 24, extraLength, true);
  }

  _localHeader(e) {
    const big = e.zip64 ? [e.size, e.compSize] : [];
    const [bytes, view] = record(30 + e.name.length + (big.length ? 4 + 8 * big.length : 0));
    view.setUint32(0, SIG_LOCAL, true);
    bytes.set(e.name, 30);
    this._common(view, 4, e, zip64Extra(view, 30 + e.name.length, big));
    return bytes;
  }

  /** Write the central directory and end records. */
  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      // The ZIP64 extra holds, in this order, whichever values overflow 32 bits.
      const big = e.zip64 ? [e.size, e.compSize] : [];
      if (e.offset >= U32) big.push(e.offset);
      const [bytes, view] = record(46 + e.name.length + (big.length ? 4 + 8 * big.length : 0));
      view.setUint32(0, SIG_CENTRAL, true);
      view.setUint16(4, 45, true); // version made by
      view.setUint32(42, e.offset >= U32 ? U32 : e.offset, true);
      bytes.set(e.name, 46);
      this._common(view, 6, e, zip64Extra(view, 46 + e.name.length, big));
      await this._write(bytes);
    }
    const cdSize = this.offset - cdStart;
    const n = this.entries.length;

    if (cdStart >= U32 || cdSize >= U32) {
      const end64At = this.offset;
      const [bytes, view] = record(56 + 20);
      view.setUint32(0, SIG_END64, true);
      view.setBigUint64(4, 44n, true);
      view.setUint16(12, 45, true);
      view.setUint16(14, 45, true);
      view.setBigUint64(24, BigInt(n), true);
      view.setBigUint64(32, BigInt(n), true);
      view.setBigUint64(40, BigInt(cdSize), true);
      view.setBigUint64(48, BigInt(cdStart), true);
      view.setUint32(56, SIG_LOCATOR64, true);
      view.setBigUint64(64, BigInt(end64At), true);
      view.setUint32(72, 1, true);
      await this._write(bytes);
    }

    const [bytes, view] = record(22);
    view.setUint32(0, SIG_END, true);
    view.setUint16(8, n, true);
    view.setUint16(10, n, true);
    view.setUint32(12, Math.min(cdSize, U32), true);
    view.setUint32(16, Math.min(cdStart, U32), true);
    await this._write(bytes);
  }
}

/**
 * List the entries of a ZIP file (a Blob/File) from its central directory.
 * @returns {Promise<Map<string, { method: number, compSize: number, size: number, offset: number }>>}
 */
export async function readZipDirectory(file) {
  const read = async (from, to) => new DataView(await file.slice(from, to).arrayBuffer());
  const tailStart = Math.max(0, file.size - (22 + 0xffff));
  const tail = await read(tailStart, file.size);
  let endAt = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_END) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new Error('not a ZIP archive');

  let count = tail.getUint16(endAt + 10, true);
  let cdSize = tail.getUint32(endAt + 12, true);
  let cdStart = tail.getUint32(endAt + 16, true);
  const locAt = endAt - 20;
  if (locAt >= 0 && tail.getUint32(locAt, true) === SIG_LOCATOR64) {
    const end64At = Number(tail.getBigUint64(locAt + 8, true));
    const end64 = await read(end64At, end64At + 56);
    if (end64.getUint32(0, true) !== SIG_END64) throw new Error('damaged ZIP64 directory');
    count = Number(end64.getBigUint64(32, true));
    cdSize = Number(end64.getBigUint64(40, true));
    cdStart = Number(end64.getBigUint64(48, true));
  }

  const cd = await read(cdStart, cdStart + cdSize);
  const entries = new Map();
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (cd.getUint32(p, true) !== SIG_CENTRAL) throw new Error('damaged ZIP directory');
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const name = UTF8_DECODER.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // ZIP64 extra: 64-bit values for whichever fields above are 0xffffffff, in this order.
    for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; ) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        const next = () => {
          const n = Number(cd.getBigUint64(q, true));
          q += 8;
          return n;
        };
        if (size === U32) size = next();
        if (compSize === U32) compSize = next();
        if (offset === U32) offset = next();
      }
      x += 4 + len;
    }
    entries.set(name, { method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Stream the uncompressed contents of one entry. */
export async function openZipEntry(file, entry) {
  const local = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
  if (local.getUint32(0, true) !== SIG_LOCAL) throw new Error('damaged ZIP entry');
  const dataAt = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const raw = file.slice(dataAt, dataAt + entry.compSize).stream();
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
  throw new Error(`unsupported ZIP compression method ${entry.method}`);
}

/** Read a whole (small) entry as text. */
export async function readZipText(file, entry) {
  return new Response(await openZipEntry(file, entry)).text();
}
