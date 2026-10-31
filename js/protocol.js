// PPK2 wire protocol: command bytes, metadata parsing and sample decoding.
//
// The PPK2 is a USB CDC ACM device. Commands are short byte sequences; while
// sampling it streams 4-byte little-endian words at 100 kHz:
//
//   bits  0..13  ADC value (14 bits)
//   bits 14..16  measurement range (shunt resistor index, 0..4)
//   bits 18..23  rolling sample counter (6 bits)
//   bits 24..31  digital channels D0..D7

export const USB_VENDOR_ID = 0x1915;
export const USB_PRODUCT_ID = 0xc00a;

export const SAMPLE_RATE = 100_000;
export const VDD_MIN = 800;
export const VDD_MAX = 5000;
export const RANGE_COUNT = 5;

// The commands Nordic's app sends to a PPK2. Its source and the IRNAS Python
// library define more opcodes (trigger, range, LCD, spike filter, ...), but
// neither sends them, and Nordic marks several as "no-firmware".
export const Cmd = Object.freeze({
  AverageStart: 0x06,
  AverageStop: 0x07,
  DeviceRunningSet: 0x0c,
  RegulatorSet: 0x0d,
  SetPowerMode: 0x11,
  GetMetadata: 0x19,
  SetUserGains: 0x25,
});

export const PowerMode = Object.freeze({ Ammeter: 1, Source: 2 });

const ADC_MULT = 1.8 / 163840;
const COUNTER_MASK = 0x3f;
const EMPTY = new Uint8Array(0);

export const command = {
  start: () => [Cmd.AverageStart],
  stop: () => [Cmd.AverageStop],
  getMetadata: () => [Cmd.GetMetadata],
  powerMode: (mode) => [Cmd.SetPowerMode, mode],
  dutPower: (on) => [Cmd.DeviceRunningSet, on ? 1 : 0],
  vdd: (mV) => {
    const v = clampVdd(mV);
    return [Cmd.RegulatorSet, v >> 8, v & 0xff];
  },
  userGain: (range, gain) => [
    Cmd.SetUserGains,
    range,
    ...new Uint8Array(new Float32Array([gain]).buffer),
  ],
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function clampVdd(mV) {
  return Math.round(clamp(mV, VDD_MIN, VDD_MAX));
}

/** Per-range calibration fields: key in `modifiers`, metadata prefix, description. */
export const MODIFIER_FIELDS = [
  ['r', 'R', 'Shunt resistance'],
  ['gs', 'GS', 'Gain slope'],
  ['gi', 'GI', 'Gain intercept'],
  ['o', 'O', 'Offset'],
  ['s', 'S', 'Voltage coefficient'],
  ['i', 'I', 'Current offset'],
  ['ug', 'UG', 'Range gain'],
];

export function defaultModifiers() {
  return {
    r: [1031.64, 101.65, 10.15, 0.94, 0.043],
    gs: [1, 1, 1, 1, 1],
    gi: [1, 1, 1, 1, 1],
    o: [0, 0, 0, 0, 0],
    s: [0, 0, 0, 0, 0],
    i: [0, 0, 0, 0, 0],
    ug: [1, 1, 1, 1, 1],
  };
}

/** Calibration with no quadratic term, so current is linear in the ADC value (simulator, tests). */
export function linearModifiers() {
  return { ...defaultModifiers(), gs: [0, 0, 0, 0, 0] };
}

export const DEFAULT_SPIKE_FILTER = Object.freeze({ samples: 3, alpha: 0.18, alpha5: 0.06 });

/**
 * Parse the text block returned by GetMetadata. It looks like:
 *   Calibrated: 0\nR0: 1003.3804\nGS0: 0.0000\n ... VDD: 3000\nHW: 9173\nmode: 2\nIA: 56\nEND
 * Per-range keys (R, GS, GI, O, S, I, UG) end in a range digit. Values that
 * are missing or "nan" keep their defaults.
 */
export function parseMetadata(text) {
  const meta = { calibrated: null, hw: null, ia: null, vdd: null, mode: null, modifiers: defaultModifiers() };
  let shuntsSeen = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)(\d)?\s*:\s*(\S+)/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = Number.parseFloat(m[3]);
    if (!Number.isFinite(value)) continue;
    if (m[2] !== undefined) {
      const range = Number(m[2]);
      if (key in meta.modifiers && range < RANGE_COUNT) {
        meta.modifiers[key][range] = value;
        if (key === 'r') shuntsSeen |= 1 << range;
      }
    } else if (key in meta && key !== 'modifiers') {
      meta[key] = value;
    }
  }
  // Nordic's app ignores the "Calibrated" flag; what matters is whether the factory
  // constants arrived. Without the shunt values we'd fall back to generic defaults.
  meta.hasCalibration = shuntsSeen === (1 << RANGE_COUNT) - 1;
  return meta;
}

/**
 * Turns the raw byte stream into calibrated current samples (µA) plus digital
 * bits. Handles words split across reads, stream alignment, the sample
 * counter (lost samples become NaN) and the range-switch spike filter.
 */
export class SampleDecoder {
  constructor() {
    this._modifiers = defaultModifiers();
    this._vdd = 3000;
    this.spike = { ...DEFAULT_SPIKE_FILTER };
    // Per-range coefficients, derived from the calibration and supply voltage.
    this._scale = new Float64Array(RANGE_COUNT);
    this._offset = new Float64Array(RANGE_COUNT);
    this._recalc();
    this.reset();
  }

  get modifiers() {
    return this._modifiers;
  }

  set modifiers(m) {
    this._modifiers = structuredClone(m);
    this._recalc();
  }

  get vdd() {
    return this._vdd;
  }

  set vdd(mV) {
    this._vdd = mV;
    this._recalc();
  }

  setUserGain(range, gain) {
    this._modifiers.ug[range] = gain;
  }

  _recalc() {
    const m = this._modifiers;
    for (let r = 0; r < RANGE_COUNT; r++) {
      this._scale[r] = ADC_MULT / m.r[r];
      this._offset[r] = m.s[r] * (this._vdd / 1000) + m.i[r];
    }
  }

  reset() {
    this.resync();
    this.counterTrusted = true;
    this.recentMismatches = 0;
    this.rollingAvg = undefined;
    this.rollingAvg4 = undefined;
    this.prevRange = undefined;
    this.afterSpike = 0;
    this.consecutiveRangeSamples = 0;
    this.lostSamples = 0;
  }

  /** Call after the transport dropped bytes (e.g. a buffer overrun). */
  resync() {
    this.pending = EMPTY;
    this.aligned = false;
    this.expectedCounter = null;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {(uA: number, bits: number) => void} sink
   */
  decode(bytes, sink) {
    let buf = bytes;
    if (this.pending.length) {
      buf = new Uint8Array(this.pending.length + bytes.length);
      buf.set(this.pending);
      buf.set(bytes, this.pending.length);
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 0;

    // Each pass decodes from an aligned position; a misaligned stream restarts the loop.
    for (;;) {
      if (!this.aligned) {
        const offset = findAlignment(buf.subarray(pos));
        if (offset === null) {
          // Not enough data to decide yet; give up on the counter after 4 KiB.
          if (buf.length - pos < 4096) {
            this.pending = buf.slice(pos);
            return;
          }
          this.counterTrusted = false;
        } else {
          pos += offset;
        }
        this.aligned = true;
      }

      const end = buf.length - ((buf.length - pos) % 4);
      let realign = false;
      for (; pos < end; pos += 4) {
        const word = view.getUint32(pos, true);
        if (this.counterTrusted) {
          const counter = (word >>> 18) & COUNTER_MASK;
          if (this.expectedCounter !== null && counter !== this.expectedCounter) {
            this.recentMismatches += 8;
            if (this.recentMismatches > 24) {
              // Repeated mismatches mean we lost word alignment; find it again.
              this.aligned = false;
              this.expectedCounter = null;
              this.recentMismatches = 0;
              realign = true;
              break;
            }
            const missing = (counter - this.expectedCounter) & COUNTER_MASK;
            this.lostSamples += missing;
            for (let k = 0; k < missing; k++) sink(NaN, 0);
          } else if (this.recentMismatches > 0) {
            this.recentMismatches--;
          }
          this.expectedCounter = (counter + 1) & COUNTER_MASK;
        }
        const range = Math.min((word >>> 14) & 0x7, RANGE_COUNT - 1);
        sink(this.current(range, (word & 0x3fff) * 4) * 1e6, (word >>> 24) & 0xff);
      }
      if (realign) continue;
      this.pending = end < buf.length ? buf.slice(end) : EMPTY;
      return;
    }
  }

  /** Calibrated current in amperes, with the range-switch spike filter applied. */
  current(range, adcVal) {
    const m = this._modifiers;
    const withoutGain = (adcVal - m.o[range]) * this._scale[range];
    let adc = m.ug[range] * (withoutGain * (m.gs[range] * withoutGain + m.gi[range]) + this._offset[range]);

    const prevRollingAvg = this.rollingAvg;
    const prevRollingAvg4 = this.rollingAvg4;
    const spike = this.spike;
    this.rollingAvg = prevRollingAvg === undefined ? adc : spike.alpha * adc + (1 - spike.alpha) * prevRollingAvg;
    this.rollingAvg4 = prevRollingAvg4 === undefined ? adc : spike.alpha5 * adc + (1 - spike.alpha5) * prevRollingAvg4;
    if (this.prevRange === undefined) this.prevRange = range;

    if (this.prevRange !== range || this.afterSpike > 0) {
      if (this.prevRange !== range) {
        this.consecutiveRangeSamples = 0;
        this.afterSpike = spike.samples;
      } else {
        this.consecutiveRangeSamples++;
      }
      if (range === 4) {
        if (this.consecutiveRangeSamples < 2) {
          this.rollingAvg = prevRollingAvg;
          this.rollingAvg4 = prevRollingAvg4;
        }
        adc = this.rollingAvg4;
      } else {
        adc = this.rollingAvg;
      }
      this.afterSpike--;
    }
    this.prevRange = range;
    return adc;
  }
}

/**
 * Find the byte offset (0..3) at which consecutive words carry consecutive
 * counter values. Returns null if the buffer is too short to tell.
 */
export function findAlignment(buf, words = 12) {
  if (buf.length < (words + 1) * 4) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let offset = 0; offset < 4; offset++) {
    let ok = true;
    let prev = (view.getUint32(offset, true) >>> 18) & COUNTER_MASK;
    for (let k = 1; k < words; k++) {
      const c = (view.getUint32(offset + k * 4, true) >>> 18) & COUNTER_MASK;
      if (c !== ((prev + 1) & COUNTER_MASK)) {
        ok = false;
        break;
      }
      prev = c;
    }
    if (ok) return offset;
  }
  return null;
}

/** Encode one sample word; used by the simulator and tests. */
export function encodeWord(adc14, range, counter, bits) {
  return ((adc14 & 0x3fff) | ((range & 0x7) << 14) | ((counter & COUNTER_MASK) << 18) | ((bits & 0xff) << 24)) >>> 0;
}

/**
 * Raw ADC reading and range for a current, as the PPK2 would report it under
 * `modifiers`. Only exact for calibrations without a quadratic term (gs = 0,
 * see linearModifiers). Returns `range << 16 | adc` to avoid allocating.
 */
export function rawForCurrent(amps, modifiers) {
  for (let range = 0; range < RANGE_COUNT; range++) {
    const adcVal =
      ((amps - modifiers.i[range]) / (modifiers.gi[range] * modifiers.ug[range])) * (modifiers.r[range] / ADC_MULT) +
      modifiers.o[range];
    const raw = Math.round(adcVal / 4);
    if (raw <= 15000 || range === RANGE_COUNT - 1) return (range << 16) | clamp(raw, 0, 0x3fff);
  }
}
