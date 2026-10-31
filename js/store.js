// Sample storage for long recordings.
//
// Samples live in fixed-size chunks so the buffer can grow without copying and
// drop its oldest data when it reaches its memory budget. Each chunk keeps a
// min/max/sum pyramid (buckets of 16, 256, 4096 and 65536 samples), which lets
// the chart and statistics summarise any range in roughly constant time.

const CHUNK_SHIFT = 20;
export const CHUNK_SIZE = 1 << CHUNK_SHIFT;
const LEVEL_SHIFTS = [0, 4, 8, 12, 16];
const TOP = LEVEL_SHIFTS.length - 1;

/** Approximate bytes used per stored sample, including the pyramid. */
const BYTES_PER_SAMPLE = 5 + 22 * (1 / 16 + 1 / 256 + 1 / 4096 + 1 / 65536);

class Level {
  constructor(n) {
    this.min = new Float32Array(n);
    this.max = new Float32Array(n);
    this.sum = new Float64Array(n);
    this.cnt = new Uint32Array(n);
    this.or = new Uint8Array(n);
    this.and = new Uint8Array(n);
    this.clear();
  }

  clear() {
    this.min.fill(Infinity);
    this.max.fill(-Infinity);
    this.sum.fill(0);
    this.cnt.fill(0);
    this.or.fill(0);
    this.and.fill(0xff);
  }

  /** Merge bucket j of `src` into bucket k of this level. */
  fold(k, src, j) {
    if (src.cnt[j]) {
      if (src.min[j] < this.min[k]) this.min[k] = src.min[j];
      if (src.max[j] > this.max[k]) this.max[k] = src.max[j];
      this.sum[k] += src.sum[j];
      this.cnt[k] += src.cnt[j];
    }
    this.or[k] |= src.or[j];
    this.and[k] &= src.and[j];
  }
}

class Chunk {
  constructor(start) {
    this.cur = new Float32Array(CHUNK_SIZE);
    this.bits = new Uint8Array(CHUNK_SIZE);
    this.levels = [null];
    for (let k = 1; k <= TOP; k++) this.levels.push(new Level(CHUNK_SIZE >> LEVEL_SHIFTS[k]));
    this.start = start;
    this.len = 0;
  }

  reuse(start) {
    for (let k = 1; k <= TOP; k++) this.levels[k].clear();
    this.start = start;
    this.len = 0;
  }
}

/** Running summary of a range; reused to avoid allocation in hot loops. */
export class Agg {
  constructor() {
    this.reset();
  }

  reset() {
    this.min = Infinity;
    this.max = -Infinity;
    this.sum = 0;
    this.cnt = 0; // valid (non-NaN) samples
    this.n = 0; // all samples in range
    this.or = 0;
    this.and = 0xff;
    return this;
  }

  get mean() {
    return this.cnt ? this.sum / this.cnt : NaN;
  }

  get validMin() {
    return this.cnt ? this.min : NaN;
  }

  get validMax() {
    return this.cnt ? this.max : NaN;
  }
}

export class SampleStore {
  /** Samples a store with this memory budget holds before it drops old data. */
  static capacityFor(maxBytes) {
    return Math.max(2, Math.floor(maxBytes / (BYTES_PER_SAMPLE * CHUNK_SIZE))) * CHUNK_SIZE;
  }

  /** Memory budget needed to hold `samples` without dropping any. */
  static bytesFor(samples) {
    return (Math.ceil(samples / CHUNK_SIZE) + 1) * CHUNK_SIZE * BYTES_PER_SAMPLE;
  }

  /**
   * @param {number} sampleRate samples per second
   * @param {number} maxBytes memory budget; oldest data is dropped past it
   */
  constructor(sampleRate, maxBytes = 512 * 1024 * 1024) {
    this.sampleRate = sampleRate;
    this.chunks = [];
    this.maxChunks = SampleStore.capacityFor(maxBytes) / CHUNK_SIZE;
    this.end = 0;
    this.version = 0;
    this.droppedSamples = 0;
    this.timeOffset = 0; // seconds added to timestamps (used for loaded sessions)
  }

  get start() {
    return this.chunks.length ? this.chunks[0].start : this.end;
  }

  get length() {
    return this.end - this.start;
  }

  get capacity() {
    return this.maxChunks * CHUNK_SIZE;
  }

  get duration() {
    return this.length / this.sampleRate;
  }

  timeOf(index) {
    return index / this.sampleRate + this.timeOffset;
  }

  _nextChunk() {
    let chunk;
    if (this.chunks.length >= this.maxChunks) {
      chunk = this.chunks.shift();
      this.droppedSamples += chunk.len;
      chunk.reuse(this.end);
    } else {
      chunk = new Chunk(this.end);
    }
    this.chunks.push(chunk);
    return chunk;
  }

  append(value, bits) {
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.len === CHUNK_SIZE) chunk = this._nextChunk();
    const i = chunk.len++;
    chunk.cur[i] = value;
    chunk.bits[i] = bits;

    // Only the finest level is updated per sample; a coarser bucket is filled
    // in when the finer bucket below it completes. Readers only use complete
    // buckets, so partial coarse buckets are never seen.
    const levels = chunk.levels;
    const L = levels[1];
    const j = i >> 4;
    if (value === value) {
      if (value < L.min[j]) L.min[j] = value;
      if (value > L.max[j]) L.max[j] = value;
      L.sum[j] += value;
      L.cnt[j]++;
    }
    L.or[j] |= bits;
    L.and[j] &= bits;
    for (let k = 2; k <= TOP; k++) {
      const done = i + 1;
      if (done & ((1 << LEVEL_SHIFTS[k - 1]) - 1)) break;
      levels[k].fold(i >> LEVEL_SHIFTS[k], levels[k - 1], i >> LEVEL_SHIFTS[k - 1]);
    }
    this.end++;
    this.version++;
  }

  _chunkFor(index) {
    const first = this.chunks[0];
    if (!first) return null;
    return this.chunks[(index >> CHUNK_SHIFT) - (first.start >> CHUNK_SHIFT)] ?? null;
  }

  /** Current (µA) at a global sample index, or NaN outside the buffer. */
  valueAt(index) {
    if (index < this.start || index >= this.end) return NaN;
    const c = this._chunkFor(index);
    return c.cur[index - c.start];
  }

  bitsAt(index) {
    if (index < this.start || index >= this.end) return 0;
    const c = this._chunkFor(index);
    return c.bits[index - c.start];
  }

  /**
   * Summarise samples in [from, to) into `agg` (merged, not reset).
   * @returns {Agg}
   */
  aggregate(from, to, agg = new Agg()) {
    from = Math.max(Math.floor(from), this.start);
    to = Math.min(Math.ceil(to), this.end);
    if (to <= from) return agg;
    agg.n += to - from;
    let pos = from;
    while (pos < to) {
      const chunk = this._chunkFor(pos);
      const b = Math.min(to - chunk.start, chunk.len);
      aggregateChunk(chunk, pos - chunk.start, b, agg);
      pos = chunk.start + b;
    }
    return agg;
  }

  /** Iterate contiguous typed-array views covering [from, to). */
  *segments(from, to) {
    from = Math.max(Math.floor(from), this.start);
    to = Math.min(Math.ceil(to), this.end);
    let i = from;
    while (i < to) {
      const chunk = this._chunkFor(i);
      const a = i - chunk.start;
      const b = Math.min(to - chunk.start, chunk.len);
      yield { start: i, cur: chunk.cur.subarray(a, b), bits: chunk.bits.subarray(a, b) };
      i = chunk.start + b;
    }
  }
}

function aggregateChunk(chunk, a, b, agg) {
  const levels = chunk.levels;
  const cur = chunk.cur;
  const bitsArr = chunk.bits;
  let i = a;
  while (i < b) {
    let k = TOP;
    while (k > 0) {
      const size = 1 << LEVEL_SHIFTS[k];
      if ((i & (size - 1)) === 0 && i + size <= b) break;
      k--;
    }
    if (k === 0) {
      const v = cur[i];
      if (v === v) {
        if (v < agg.min) agg.min = v;
        if (v > agg.max) agg.max = v;
        agg.sum += v;
        agg.cnt++;
      }
      agg.or |= bitsArr[i];
      agg.and &= bitsArr[i];
      i++;
    } else {
      const L = levels[k];
      const j = i >> LEVEL_SHIFTS[k];
      if (L.cnt[j]) {
        if (L.min[j] < agg.min) agg.min = L.min[j];
        if (L.max[j] > agg.max) agg.max = L.max[j];
        agg.sum += L.sum[j];
        agg.cnt += L.cnt[j];
      }
      agg.or |= L.or[j];
      agg.and &= L.and[j];
      i += 1 << LEVEL_SHIFTS[k];
    }
  }
}
