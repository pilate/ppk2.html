// Number formatting with SI prefixes, and axis tick helpers.

const PREFIXES = [
  [1e-9, 'n'],
  [1e-6, 'µ'],
  [1e-3, 'm'],
  [1, ''],
  [1e3, 'k'],
];

/** Pick the SI prefix for a magnitude, e.g. 0.0042 → [1e-3, 'm']. */
export function prefixFor(magnitude) {
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return PREFIXES[1];
  return PREFIXES.findLast((q) => magnitude >= q[0] * 0.99995) ?? PREFIXES[0];
}

/** Split a value into a number string and a unit, keeping `digits` significant figures. */
export function siParts(value, unit, digits = 4) {
  if (!Number.isFinite(value)) return { num: '—', unit };
  const [scale, prefix] = prefixFor(Math.abs(value));
  const scaled = value / scale;
  const mag = scaled === 0 ? 0 : Math.floor(Math.log10(Math.abs(scaled)));
  const decimals = Math.max(0, digits - 1 - mag);
  return { num: scaled.toFixed(decimals), unit: prefix + unit };
}

export function si(value, unit, digits = 4) {
  const { num, unit: u } = siParts(value, unit, digits);
  return num === '—' ? num : `${num} ${u}`;
}

/** Current stored in µA → "1.234 mA". */
export const current = (uA, digits) => si(uA * 1e-6, 'A', digits);
export const currentParts = (uA, digits) => siParts(uA * 1e-6, 'A', digits);
export const duration = (s, digits) => si(s, 's', digits);
export const charge = (uC, digits) => si(uC * 1e-6, 'C', digits);
export const energy = (uJ, digits) => si(uJ * 1e-6, 'J', digits);

/** A 1/2/5 × 10^n step giving about `target` ticks across `range`. */
export function niceStep(range, target) {
  if (!(range > 0)) return 1;
  const raw = range / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}

export function ticks(min, max, target) {
  const step = niceStep(max - min, target);
  const out = [];
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  for (let k = first; k <= last && out.length < 1000; k++) out.push(k === 0 ? 0 : k * step);
  return { step, values: out };
}

/** Format an axis tick for a step size so neighbouring labels differ. */
export function tickLabel(value, step, unit, scale, prefix) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step / scale) + 1e-9));
  return `${(value / scale).toFixed(decimals)} ${prefix}${unit}`;
}

/** Time axis label: seconds, with mm:ss for long recordings. */
export function timeLabel(seconds, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  if (Math.abs(seconds) >= 60 && step >= 1) {
    const sign = seconds < 0 ? '-' : '';
    const t = Math.abs(seconds);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${sign}${m}:${s.toFixed(0).padStart(2, '0')}`;
  }
  return `${seconds.toFixed(decimals)} s`;
}

/** Long durations in words: "45 s", "13 min", "2.5 h". */
export function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 1) return si(seconds, 's', 3);
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

export function rateLabel(rate) {
  return rate >= 1000 ? `${rate / 1000} kHz` : `${rate} Hz`;
}
