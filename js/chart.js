// Canvas chart for current and digital channels, plus the overview strip.

import * as fmt from './format.js';
import { DIGITAL_CHANNELS, clamp } from './protocol.js';
import { Agg } from './store.js';

const AXIS_W = 76;
const RIGHT_PAD = 16;
const TOP_PAD = 12;
const TIME_AXIS_H = 28;
const LANE_H = 18;
const LANE_GAP = 10;
const LOG_FLOOR = 1e-3; // µA (1 nA)
const LOG_CEIL = 1e8; // µA (100 A)
const MIN_SPAN = 10; // samples

function cssVar(el, name, fallback) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

function popcount(x) {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

/** Size a canvas's backing store to its CSS box at device resolution. */
function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  return { cssW: Math.max(1, rect.width), cssH: Math.max(1, rect.height), dpr };
}

const toLog = (v) => Math.log10(Math.max(LOG_FLOOR, v));

/** One set of summary bins; see BinCache. */
class Bins {
  constructor(n) {
    this.min = new Float64Array(n);
    this.max = new Float64Array(n);
    this.mean = new Float64Array(n);
    this.or = new Uint8Array(n);
    this.and = new Uint8Array(n);
    this.first = 0; // index of bins[0] on the grid
    this.count = 0;
    this.spp = 0;
    this.store = null;
    this.storeStart = 0;
    this.complete = 0; // bins with an index below this had all their samples
  }

  /** Fill bins first..first+count-1, reusing complete bins from `prev` where possible. */
  fill(store, first, count, spp, prev, agg) {
    const reusable = prev.store === store && prev.spp === spp && prev.storeStart === store.start;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < count; k++) {
      const j = first + k;
      const p = j - prev.first;
      if (reusable && p >= 0 && p < prev.count && j < prev.complete) {
        this.min[k] = prev.min[p];
        this.max[k] = prev.max[p];
        this.mean[k] = prev.mean[p];
        this.or[k] = prev.or[p];
        this.and[k] = prev.and[p];
      } else {
        store.aggregate(j * spp, (j + 1) * spp, agg.reset());
        this.min[k] = agg.validMin;
        this.max[k] = agg.validMax;
        this.mean[k] = agg.mean;
        this.or[k] = agg.n ? agg.or : 0;
        this.and[k] = agg.n ? agg.and : 0;
      }
      if (this.min[k] < lo) lo = this.min[k];
      if (this.max[k] > hi) hi = this.max[k];
    }
    Object.assign(this, { first, count, spp, store, storeStart: store.start });
    // One bin of margin, since bin edges are fractional sample indices.
    this.complete = Math.floor(store.end / spp) - 1;
    return { lo, hi };
  }
}

/**
 * Summary bins on a fixed sample grid: bin j holds samples [j·size, (j+1)·size). A sample always
 * lands in the same bin, so a trace drawn from them doesn't shimmer as the view scrolls or the
 * recording grows, and each update re-summarises only the bins that weren't complete last time
 * (it keeps two sets of bins and swaps them). Used for the chart's pixel columns and the overview.
 */
export class BinCache {
  constructor() {
    this.bins = new Bins(0);
    this._spare = new Bins(0);
    this._agg = new Agg();
  }

  /** Summarise bins first..first+count-1 of a `size`-sample grid; returns the overall { lo, hi }. */
  update(store, first, count, size) {
    if (this._spare.min.length < count) {
      // Grow (with headroom); the old bins can still be reused for this update.
      this._spare = new Bins(Math.max(count, 2 * this._spare.min.length));
    }
    const next = this._spare;
    const range = next.fill(store, first, count, size, this.bins, this._agg);
    this._spare = this.bins;
    this.bins = next;
    return range;
  }
}

export class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = null;
    this.rate = 100_000;
    this.viewStart = -100_000;
    this.viewSpan = 100_000;
    this.live = true;
    this.selection = null; // { a, b } sample indices, a <= b
    this.tool = 'pan';
    this.yAuto = true;
    this.yMin = 0;
    this.yMax = 1000;
    this.yLog = false;
    this.showDigital = true;
    this.channels = 0xff;
    this.triggerLevel = null; // µA, drawn as a dashed line while armed
    this.triggerMarker = null; // sample index
    this.hover = null; // { x, y } css px
    this.onselect = null;
    this.onviewchange = null;
    this.minimap = null;

    this._columns = new BinCache(); // one bin per device pixel column
    this._raw = { v: new Float64Array(0), b: new Uint8Array(0), from: 0, n: 0 };
    this._liveEnd = 0; // right edge of the live view, advanced smoothly by the clock
    this._seenEnd = -1;
    this._lastGrowth = 0;
    this._lastTick = 0;
    this._agg = new Agg();
    this._dataKey = '';
    this._lo = Infinity;
    this._hi = -Infinity;
    this._drag = null;
    this._dirty = true;
    this._unseen = false; // data arrived that the chart hasn't drawn yet
    this._lastFrame = 0;

    this.readColors();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.readColors();
      this.invalidate();
    });

    new ResizeObserver(() => {
      Object.assign(this, fitCanvas(canvas));
      this.invalidate();
    }).observe(canvas);
    Object.assign(this, fitCanvas(canvas));
    this._bindInput();
    const loop = (now) => {
      this._frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  readColors() {
    const el = this.canvas;
    this.colors = {
      bg: cssVar(el, '--plot-bg', '#fff'),
      grid: cssVar(el, '--grid', '#e3e8eb'),
      axis: cssVar(el, '--axis-text', '#5d6a73'),
      trace: cssVar(el, '--trace', '#0b5cad'),
      select: cssVar(el, '--select', '#c77700'),
      selectFill: cssVar(el, '--select-fill', 'rgba(199,119,0,.12)'),
      trigger: cssVar(el, '--trigger', '#b3261e'),
      digital: cssVar(el, '--digital', '#2f7d5b'),
      laneBg: cssVar(el, '--lane-bg', '#f3f6f7'),
      cursor: cssVar(el, '--cursor', '#1a2126'),
      font: cssVar(el, '--chart-font', '12px sans-serif'),
    };
  }

  /**
   * Change display options and redraw: tool, yLog, showDigital, channels,
   * triggerLevel, triggerMarker. Switching the axis scale refits it.
   */
  configure(patch) {
    if ('yLog' in patch && patch.yLog !== this.yLog) this.yAuto = true;
    Object.assign(this, patch);
    this.invalidate();
  }

  setStore(store) {
    this.store = store;
    this.rate = store?.sampleRate ?? this.rate;
    this._liveEnd = store?.end ?? 0;
    this.selection = null;
    this.triggerMarker = null;
    this.invalidate();
  }

  invalidate() {
    this._dirty = true;
  }

  // ---- view ---------------------------------------------------------------

  get dataStart() {
    return this.store ? this.store.start : 0;
  }

  get dataEnd() {
    return this.store ? this.store.end : 0;
  }

  get spanSeconds() {
    return this.viewSpan / this.rate;
  }

  _viewChanged() {
    this._clampView();
    this.invalidate();
    this.onviewchange?.();
  }

  setLive(on) {
    this.live = on;
    this._liveEnd = this.dataEnd;
    this._viewChanged();
  }

  setSpanSeconds(seconds) {
    this._setSpan(Math.max(MIN_SPAN, seconds * this.rate), 0.5);
  }

  setView(from, to) {
    this.live = false;
    this.viewStart = from;
    this.viewSpan = Math.max(MIN_SPAN, to - from);
    this._viewChanged();
  }

  fitAll() {
    if (!this.store || this.store.length < 2) return;
    this.setView(this.dataStart, this.dataEnd);
  }

  zoom(factor, anchorFrac = 0.5) {
    this._setSpan(this._clampSpan(this.viewSpan * factor), anchorFrac);
  }

  /** Change the span keeping the point at `anchorFrac` of the width fixed (or the right edge when live). */
  _setSpan(span, anchorFrac) {
    if (!this.live) this.viewStart += anchorFrac * (this.viewSpan - span);
    this.viewSpan = span;
    this._viewChanged();
  }

  pan(fraction) {
    this.live = false;
    this.viewStart += fraction * this.viewSpan;
    this._viewChanged();
  }

  visibleRange() {
    const from = this.live ? this._liveEnd - this.viewSpan : this.viewStart;
    return [from, from + this.viewSpan];
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.invalidate();
    this.onselect?.(null);
  }

  _clampSpan(span) {
    const len = this.store ? this.store.length : 0;
    const max = this.live ? Math.max(len, this.rate * 3600) : Math.max(len, MIN_SPAN * 10);
    return Math.min(max, Math.max(MIN_SPAN, span));
  }

  _clampView() {
    if (this.live) return;
    const lo = this.dataStart;
    const hi = this.dataEnd;
    const span = this.viewSpan;
    if (span >= hi - lo) this.viewStart = Math.min(lo, Math.max(hi - span, this.viewStart));
    else this.viewStart = Math.min(hi - span, Math.max(lo, this.viewStart));
  }

  // ---- layout and scales --------------------------------------------------

  layout() {
    const lanes = this.showDigital ? popcount(this.channels) : 0;
    const digitalH = lanes ? lanes * LANE_H + LANE_GAP : 0;
    const plot = {
      x: AXIS_W,
      y: TOP_PAD,
      w: Math.max(10, this.cssW - AXIS_W - RIGHT_PAD),
      h: Math.max(40, this.cssH - TOP_PAD - TIME_AXIS_H - digitalH),
    };
    const digital = { x: plot.x, y: plot.y + plot.h + LANE_GAP, w: plot.w, h: lanes * LANE_H, lanes };
    const bottom = lanes ? digital.y + digital.h : plot.y + plot.h;
    return { plot, digital, bottom, axisY: this.cssH - TIME_AXIS_H };
  }

  indexAtX(x) {
    const { plot } = this.layout();
    return this.visibleRange()[0] + ((x - plot.x) / plot.w) * this.viewSpan;
  }

  /** Visible current range in axis units (log10 µA in log mode). */
  _yDomain() {
    return this.yLog ? [toLog(this.yMin), toLog(this.yMax)] : [this.yMin, this.yMax];
  }

  _yMap(plot) {
    const [lo, hi] = this._yDomain();
    const k = plot.h / (hi - lo);
    const bottom = plot.y + plot.h;
    return this.yLog ? (v) => bottom - (toLog(v) - lo) * k : (v) => bottom - (v - lo) * k;
  }

  _valueAtY(y, plot) {
    const [lo, hi] = this._yDomain();
    const u = lo + ((plot.y + plot.h - y) / plot.h) * (hi - lo);
    return this.yLog ? 10 ** u : u;
  }

  /** Set the current axis, keeping it finite, non-empty and (in log mode) between 1 nA and 100 A. */
  _setY(min, max) {
    if (this.yLog) {
      min = Math.min(LOG_CEIL / 10, Math.max(LOG_FLOOR, min || LOG_FLOOR));
      max = Math.min(LOG_CEIL, Math.max(min * 2, max || 0));
    } else if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }
    this.yMin = min;
    this.yMax = max;
  }

  _fitY(lo, hi) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      if (this.yLog) this._setY(this.yMin, this.yMax); // make sure an empty log axis is valid
      return;
    }
    if (this.yLog) {
      this._setY(10 ** Math.floor(toLog(lo)), 10 ** Math.ceil(toLog(hi)));
      return;
    }
    const span = Math.max(hi - lo, Math.abs(hi) * 0.05, 0.05);
    const tlo = lo - span * 0.08;
    const thi = hi + span * 0.08;
    const fits = this.yMin <= tlo && this.yMax >= thi && thi - tlo > (this.yMax - this.yMin) * 0.45;
    if (fits) return;
    const step = fmt.niceStep(thi - tlo, 5);
    const max = Math.ceil(thi / step) * step;
    // Current that never goes negative shouldn't get a negative axis, just a little room below zero.
    const min = lo >= 0 ? Math.max(Math.floor(tlo / step) * step, -0.03 * max) : Math.floor(tlo / step) * step;
    this._setY(min, max);
  }

  // ---- rendering ----------------------------------------------------------

  /**
   * Move the live view's right edge. Samples arrive in bursts (USB reads), so instead of
   * jumping to the newest sample the edge advances with the clock at the sample rate and
   * eases toward the newest data minus a short lag, which hides the bursts.
   * @returns {boolean} whether the edge moved
   */
  _advanceLive(now) {
    const end = this.dataEnd;
    this._grew = end !== this._seenEnd;
    if (this._grew) {
      this._seenEnd = end;
      this._lastGrowth = now;
    }
    const dt = this._lastTick ? Math.min(0.1, (now - this._lastTick) / 1000) : 0;
    this._lastTick = now;
    if (!this.live) return false;
    const prev = this._liveEnd;
    if (now - this._lastGrowth > 250) {
      // Not sampling: glide the rest of the way to the last sample.
      const next = prev + (end - prev) * 0.25;
      this._liveEnd = Math.abs(end - next) < 0.5 ? end : next;
    } else {
      const target = end - Math.max(0.06 * this.rate, 2);
      let next = prev + dt * this.rate;
      next += (target - next) * 0.08;
      if (Math.abs(target - next) > 0.5 * this.rate) next = target; // start, or a long stall
      this._liveEnd = Math.min(next, end);
    }
    return this._liveEnd !== prev;
  }

  _frame(now) {
    const moved = this._advanceLive(now);
    if (this._grew) this._unseen = true;
    // The overview is cheap to redraw, so it follows every frame in which anything changed.
    if (this.minimap && (moved || this._dirty || this._grew)) this.minimap.render();
    // A scrolling live view redraws every frame; new data elsewhere at most 10 times a second.
    if (!this._dirty && !moved && !(this._unseen && now - this._lastFrame >= 100)) return;
    this._lastFrame = now;
    this._unseen = false;
    this._dirty = false;
    this.render();
  }

  /** Summarise (or gather raw samples for) the visible range, unless nothing changed since last time. */
  _gather(from, to, cols, spp) {
    const store = this.store;
    const key = `${store?.version}|${from}|${to}|${cols}`;
    if (key === this._dataKey) return;
    this._dataKey = key;
    this._lo = Infinity;
    this._hi = -Infinity;
    if (!store || !store.length) return;
    if (spp >= 1) {
      ({ lo: this._lo, hi: this._hi } = this._columns.update(store, Math.floor(from / spp), cols + 2, spp));
    } else {
      const raw = this._raw;
      const [a, b] = store.clampRange(from, to + 1);
      if (raw.v.length < b - a) {
        raw.v = new Float64Array(b - a);
        raw.b = new Uint8Array(b - a);
      }
      raw.from = a;
      raw.n = 0;
      for (const seg of store.segments(a, b)) {
        for (let k = 0; k < seg.cur.length; k++) {
          const v = seg.cur[k];
          raw.v[raw.n] = v;
          raw.b[raw.n++] = seg.bits[k];
          if (v < this._lo) this._lo = v;
          if (v > this._hi) this._hi = v;
        }
      }
    }
  }

  render() {
    const ctx = this.ctx;
    const c = this.colors;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.font = c.font;
    const { plot, digital, bottom, axisY } = this.layout();
    const [from, to] = this.visibleRange();

    ctx.fillStyle = c.bg;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    const cols = Math.max(1, Math.floor(plot.w * this.dpr));
    const spp = this.viewSpan / cols;
    this._gather(from, to, cols, spp);
    if (this.yAuto) this._fitY(this._lo, this._hi);

    // Everything the draw steps need, computed once per frame.
    const f = {
      plot,
      digital,
      bottom,
      from,
      colW: 1 / this.dpr, // one device pixel per bin
      // x of bin k is plot.x + (k + shift) · colW. The shift is rounded to a whole device pixel:
      // at fractional positions anti-aliasing would make thin spikes pulse as they scroll.
      shift: spp >= 1 ? Math.round(this._columns.bins.first - from / spp) : 0,
      raw: spp < 1,
      pxPerSample: plot.w / this.viewSpan,
      ymap: this._yMap(plot),
      hasData: !!this.store?.length,
    };
    f.xOf = (i) => plot.x + (i - from) * f.pxPerSample;

    this._drawYGrid(f);
    this._drawTimeGrid(f, axisY, from, to);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (f.hasData) {
      if (f.raw) this._drawRaw(f);
      else this._drawBands(f);
    }
    if (this.triggerLevel !== null) {
      const y = Math.round(f.ymap(this.triggerLevel)) + 0.5;
      ctx.strokeStyle = c.trigger;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    if (digital.lanes) this._drawDigital(f);
    this._drawOverlays(f);
    this._drawHover(f);
  }

  _drawYGrid({ plot, ymap }) {
    const ctx = this.ctx;
    const c = this.colors;
    ctx.fillStyle = c.axis;
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let values;
    let label;
    if (this.yLog) {
      values = [];
      for (let v = 10 ** Math.floor(toLog(this.yMin)); v <= this.yMax * 1.0001; v *= 10) values.push(v);
      label = (v) => fmt.current(v, 1);
    } else {
      const t = fmt.ticks(this.yMin, this.yMax, Math.max(2, Math.round(plot.h / 48)));
      values = t.values;
      const [scale, prefix] = fmt.prefixFor(Math.max(Math.abs(this.yMin), Math.abs(this.yMax)) * 1e-6);
      label = (v) => fmt.tickLabel(v * 1e-6, t.step * 1e-6, 'A', scale, prefix);
    }
    for (const v of values) {
      const y = Math.round(ymap(v)) + 0.5;
      if (y < plot.y - 1 || y > plot.y + plot.h + 1) continue;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.fillText(label(v), plot.x - 8, y);
    }
  }

  _drawTimeGrid({ plot, bottom }, axisY, from, to) {
    const ctx = this.ctx;
    const t0 = this._time(from);
    const t1 = this._time(to);
    const t = fmt.ticks(t0, t1, Math.max(2, Math.round(plot.w / 110)));
    ctx.strokeStyle = this.colors.grid;
    ctx.fillStyle = this.colors.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of t.values) {
      const x = Math.round(plot.x + ((v - t0) / (t1 - t0)) * plot.w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
      const label = fmt.timeLabel(v, t.step);
      const half = ctx.measureText(label).width / 2;
      if (x - half >= 0 && x + half <= this.cssW) ctx.fillText(label, x, axisY + 8);
    }
    ctx.beginPath();
    ctx.moveTo(plot.x, bottom + 0.5);
    ctx.lineTo(plot.x + plot.w, bottom + 0.5);
    ctx.stroke();
  }

  _time(index) {
    return this.store ? this.store.timeOf(index) : index / this.rate;
  }

  _drawBands({ plot, ymap, colW: w, shift }) {
    const ctx = this.ctx;
    const { min, max, count } = this._columns.bins;
    ctx.fillStyle = this.colors.trace;
    ctx.beginPath();
    let prevMin = NaN;
    let prevMax = NaN;
    for (let k = 0; k < count; k++) {
      let mn = min[k];
      let mx = max[k];
      if (mn !== mn) {
        prevMin = prevMax = NaN;
        continue;
      }
      // Join each column to its neighbour so steps stay connected.
      if (prevMax === prevMax) {
        if (prevMax < mn) mn = prevMax;
        if (prevMin > mx) mx = prevMin;
      }
      prevMin = min[k];
      prevMax = max[k];
      const y1 = ymap(mx);
      ctx.rect(plot.x + (k + shift) * w, y1, w, Math.max(1 / this.dpr, ymap(mn) - y1));
    }
    ctx.fill();
  }

  _drawRaw({ ymap, xOf, pxPerSample }) {
    const ctx = this.ctx;
    const { v, from, n } = this._raw;
    const dots = pxPerSample > 7;
    ctx.strokeStyle = this.colors.trace;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let k = 0; k < n; k++) {
      if (v[k] !== v[k]) {
        pen = false;
        continue;
      }
      const x = xOf(from + k);
      const y = ymap(v[k]);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    if (!dots) return;
    ctx.fillStyle = this.colors.trace;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      if (v[k] !== v[k]) continue;
      const x = xOf(from + k);
      const y = ymap(v[k]);
      ctx.moveTo(x + 2.5, y);
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  _drawDigital({ digital: d, raw, colW: w, shift, xOf, hasData }) {
    const ctx = this.ctx;
    const c = this.colors;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let lane = 0;
    for (let ch = 0; ch < DIGITAL_CHANNELS; ch++) {
      if (!(this.channels & (1 << ch))) continue;
      const top = d.y + lane++ * LANE_H;
      const hiY = top + 3;
      const loY = top + LANE_H - 4;
      ctx.fillStyle = c.laneBg;
      ctx.fillRect(d.x, top + 1, d.w, LANE_H - 2);
      ctx.fillStyle = c.axis;
      ctx.fillText(`D${ch}`, d.x - 8, top + LANE_H / 2);
      if (!hasData) continue;
      ctx.fillStyle = c.digital;
      const mask = 1 << ch;

      // Runs of equal state are drawn as one rectangle. State: 0 low, 1 high, 2 toggling within a column.
      let runX = 0;
      let runState = -1;
      let endX = 0;
      const flush = (x) => {
        if (runState === 1) ctx.fillRect(runX, hiY, x - runX, loY - hiY);
        else if (runState === 0) ctx.fillRect(runX, loY - 1, x - runX, 1.5);
        else if (runState === 2) {
          ctx.globalAlpha = 0.45;
          ctx.fillRect(runX, hiY, x - runX, loY - hiY);
          ctx.globalAlpha = 1;
        }
      };
      const step = (x0, x1, state) => {
        if (state !== runState) {
          flush(x0);
          runX = x0;
          runState = state;
        }
        endX = x1;
      };

      if (raw) {
        const { b, from, n } = this._raw;
        for (let k = 0; k < n; k++) {
          const x0 = Math.max(d.x, xOf(from + k));
          const x1 = Math.min(d.x + d.w, xOf(from + k + 1));
          if (x1 > x0) step(x0, x1, b[k] & mask ? 1 : 0);
        }
      } else {
        const { mean, or, and, count } = this._columns.bins;
        for (let k = 0; k < count; k++) {
          const x0 = Math.max(d.x, d.x + (k + shift) * w);
          const x1 = Math.min(d.x + d.w, d.x + (k + 1 + shift) * w);
          if (x1 <= x0) continue;
          if (mean[k] !== mean[k] && !or[k] && !and[k]) {
            // No samples here (outside the buffer, or lost).
            flush(x0);
            runState = -1;
            continue;
          }
          step(x0, x1, and[k] & mask ? 1 : or[k] & mask ? 2 : 0);
        }
      }
      flush(endX);
    }
  }

  _drawOverlays({ plot, bottom, xOf }) {
    const ctx = this.ctx;
    const c = this.colors;
    const right = plot.x + plot.w;
    if (this.selection) {
      const xa = xOf(this.selection.a);
      const xb = xOf(this.selection.b);
      if (xb > plot.x && xa < right) {
        const x0 = Math.max(plot.x, xa);
        ctx.fillStyle = c.selectFill;
        ctx.fillRect(x0, plot.y, Math.max(1, Math.min(right, xb) - x0), bottom - plot.y);
        ctx.strokeStyle = c.select;
        ctx.lineWidth = 1.5;
        for (const x of [xa, xb]) {
          if (x < plot.x || x > right) continue;
          ctx.beginPath();
          ctx.moveTo(x, plot.y);
          ctx.lineTo(x, bottom);
          ctx.stroke();
        }
      }
    }
    if (this.triggerMarker !== null) {
      const x = xOf(this.triggerMarker);
      if (x >= plot.x && x <= right) {
        ctx.strokeStyle = c.trigger;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, plot.y);
        ctx.lineTo(x + 0.5, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = c.trigger;
        ctx.beginPath();
        ctx.moveTo(x - 5, plot.y);
        ctx.lineTo(x + 5, plot.y);
        ctx.lineTo(x, plot.y + 7);
        ctx.fill();
      }
    }
  }

  _drawHover({ plot, bottom, ymap, raw, colW, shift, from, pxPerSample, hasData }) {
    const h = this.hover;
    if (!h || this._drag || !hasData) return;
    if (h.x < plot.x || h.x > plot.x + plot.w) return;
    const ctx = this.ctx;
    const c = this.colors;
    const idx = from + (h.x - plot.x) / pxPerSample;
    let text;
    let value;
    if (raw) {
      value = this.store.valueAt(Math.round(idx));
      if (value !== value) return;
      text = fmt.current(value);
    } else {
      const { min, max, mean, count } = this._columns.bins;
      const k = clamp(Math.floor((h.x - plot.x) / colW - shift), 0, count - 1);
      value = mean[k];
      if (value !== value) return;
      text =
        max[k] - min[k] > Math.abs(value) * 0.02
          ? `${fmt.current(min[k], 3)} … ${fmt.current(max[k], 3)}`
          : fmt.current(value);
    }
    const t = fmt.duration(this._time(raw ? Math.round(idx) : idx), 6);
    ctx.strokeStyle = c.cursor;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(h.x) + 0.5, plot.y);
    ctx.lineTo(Math.round(h.x) + 0.5, bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.trace;
    ctx.beginPath();
    ctx.arc(h.x, ymap(value), 3.5, 0, Math.PI * 2);
    ctx.fill();
    const label = `${text}   ${t}`;
    const tw = ctx.measureText(label).width + 16;
    let bx = h.x + 10;
    if (bx + tw > plot.x + plot.w) bx = h.x - 10 - tw;
    const by = plot.y + 6;
    ctx.fillStyle = c.bg;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(bx, by, tw, 22);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.grid;
    ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 21);
    ctx.fillStyle = c.cursor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 8, by + 11);
  }

  // ---- input --------------------------------------------------------------

  _bindInput() {
    const el = this.canvas;
    const pos = (e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = pos(e);
      const { plot } = this.layout();
      el.setPointerCapture(e.pointerId);
      el.focus({ preventScroll: true });
      if (p.x < plot.x) {
        this.yAuto = false;
        this._drag = { kind: 'y', y: p.y, domain: this._yDomain(), plot };
        return;
      }
      if ((this.tool === 'select') !== e.shiftKey) {
        const i = this._clampIndex(this.indexAtX(p.x));
        this._drag = { kind: 'select', anchor: i, x: p.x };
        this.selection = { a: i, b: i };
      } else {
        this.viewStart = this.visibleRange()[0];
        this.live = false;
        this._drag = { kind: 'pan', x: p.x, start: this.viewStart, plot };
        this.onviewchange?.();
      }
      this.invalidate();
    });

    el.addEventListener('pointermove', (e) => {
      const p = pos(e);
      this.hover = p;
      const d = this._drag;
      if (d?.kind === 'pan') {
        this.viewStart = d.start - ((p.x - d.x) / d.plot.w) * this.viewSpan;
        this._clampView();
        this.onviewchange?.();
      } else if (d?.kind === 'select') {
        const i = this._clampIndex(this.indexAtX(p.x));
        this.selection = { a: Math.min(d.anchor, i), b: Math.max(d.anchor, i) };
        this.onselect?.(this.selection);
      } else if (d?.kind === 'y') {
        // Shift the axis in its own units (log10 µA in log mode).
        const [lo, hi] = d.domain;
        const shift = ((p.y - d.y) / d.plot.h) * (hi - lo);
        const back = this.yLog ? (u) => 10 ** u : (u) => u;
        this._setY(back(lo + shift), back(hi + shift));
      }
      this.invalidate();
    });

    const end = (e) => {
      const d = this._drag;
      this._drag = null;
      if (d?.kind === 'select') {
        if (Math.abs(pos(e).x - d.x) < 3) this.clearSelection();
        else this.onselect?.(this.selection);
      }
      this.invalidate();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => {
      this.hover = null;
      this.invalidate();
    });

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = pos(e);
        const { plot } = this.layout();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const dy = e.deltaY * unit;
        const dx = e.deltaX * unit;
        if (p.x < plot.x) this._zoomY(Math.exp(dy * 0.002), (plot.y + plot.h - p.y) / plot.h);
        else if (Math.abs(dx) > Math.abs(dy)) this.pan(dx / plot.w);
        else this.zoom(Math.exp(dy * 0.002), (p.x - plot.x) / plot.w);
        this.invalidate();
      },
      { passive: false },
    );

    el.addEventListener('dblclick', (e) => {
      if (pos(e).x < this.layout().plot.x) this.yAuto = true;
      else this.clearSelection();
      this.invalidate();
    });

    el.addEventListener('keydown', (e) => {
      const keys = {
        ArrowLeft: () => this.pan(-0.15),
        ArrowRight: () => this.pan(0.15),
        '+': () => this.zoom(0.5),
        '=': () => this.zoom(0.5),
        '-': () => this.zoom(2),
        Escape: () => this.clearSelection(),
        l: () => this.setLive(true),
        f: () => this.fitAll(),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    });
  }

  /** Zoom the current axis around the point `frac` of the way up the plot. */
  _zoomY(factor, frac) {
    this.yAuto = false;
    const [lo, hi] = this._yDomain();
    const a = lo + frac * (hi - lo);
    const back = this.yLog ? (u) => 10 ** u : (u) => u;
    this._setY(back(a - (a - lo) * factor), back(a + (hi - a) * factor));
  }

  _clampIndex(i) {
    return Math.min(this.dataEnd, Math.max(this.dataStart, Math.round(i)));
  }
}

/**
 * Overview of the whole recording with the visible window marked; click or drag to navigate.
 *
 * The recording is summarised in buckets of a power-of-two number of samples on a fixed grid
 * (a BinCache), at most two per pixel, so the bucket size only changes when the recording
 * doubles. Every frame the buckets are projected onto pixel columns, so new data flows in
 * continuously and the trace only moves as the strip compresses.
 */
export class Minimap {
  constructor(canvas, chart) {
    this.canvas = canvas;
    this.chart = chart;
    this.ctx = canvas.getContext('2d');
    this.range = [0, 1]; // sample range the strip spans, edge to edge
    this._buckets = new BinCache();
    this._colMin = new Float64Array(0);
    this._colMax = new Float64Array(0);
    chart.minimap = this;
    new ResizeObserver(() => {
      fitCanvas(canvas);
      chart.invalidate();
    }).observe(canvas);

    let dragging = false;
    const go = (e) => {
      if (!chart.store?.length) return;
      const r = canvas.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      const [a, b] = this.range;
      const i = a + frac * (b - a);
      chart.setView(i - chart.viewSpan / 2, i + chart.viewSpan / 2);
    };
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      go(e);
    });
    canvas.addEventListener('pointermove', (e) => dragging && go(e));
    canvas.addEventListener('pointerup', () => (dragging = false));
    canvas.addEventListener('pointercancel', () => (dragging = false));
  }

  render() {
    const store = this.chart.store;
    const { width: W, height: H } = this.canvas;
    const ctx = this.ctx;
    const c = this.chart.colors;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = c.laneBg;
    ctx.fillRect(0, 0, W, H);
    if (!store || store.length < 2) return;

    let size = 1;
    while (store.length / size > 2 * W) size *= 2;
    const first = Math.floor(store.start / size);
    this._buckets.update(store, first, Math.floor((store.end - 1) / size) - first + 1, size);
    const { min, max, count } = this._buckets.bins;

    // The strip spans the recording up to the newest sample, or, when following live, up to the
    // view's right edge, so the window stays pinned there.
    const [from, to] = this.chart.visibleRange();
    const a0 = store.start;
    const a1 = this.chart.live ? Math.max(to, a0 + 1) : store.end;
    this.range = [a0, a1];
    const px = W / (a1 - a0);

    // Project buckets onto pixel columns: a narrow bucket goes to the column under its centre,
    // a wide one (early in a recording) fills every column it covers.
    if (this._colMin.length !== W) {
      this._colMin = new Float64Array(W);
      this._colMax = new Float64Array(W);
    }
    const colMin = this._colMin;
    const colMax = this._colMax;
    colMin.fill(NaN);
    colMax.fill(NaN);
    let lo = Infinity;
    let hi = -Infinity;
    const bucketPx = size * px;
    for (let k = 0; k < count; k++) {
      const mn = min[k];
      if (mn !== mn) continue;
      const x = ((first + k) * size - a0) * px;
      let c0 = bucketPx < 1 ? Math.floor(x + bucketPx / 2) : Math.floor(x);
      let c1 = bucketPx < 1 ? c0 : Math.ceil(x + bucketPx) - 1;
      if (c1 < 0 || c0 >= W) continue;
      c0 = Math.max(c0, 0);
      c1 = Math.min(c1, W - 1);
      const mx = max[k];
      for (let col = c0; col <= c1; col++) {
        if (!(colMin[col] <= mn)) colMin[col] = mn;
        if (!(colMax[col] >= mx)) colMax[col] = mx;
      }
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
    }

    if (Number.isFinite(lo)) {
      const f = this.chart.yLog ? toLog : (v) => v;
      const flo = f(lo);
      const fhi = f(hi) === flo ? flo + 1 : f(hi);
      const pad = H * 0.12;
      const y = (v) => H - pad - ((f(v) - flo) / (fhi - flo)) * (H - 2 * pad);
      ctx.fillStyle = c.trace;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      for (let col = 0; col < W; col++) {
        if (colMin[col] !== colMin[col]) continue;
        const y1 = y(colMax[col]);
        ctx.rect(col, y1, 1, Math.max(1, y(colMin[col]) - y1));
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    const x0 = (from - a0) * px;
    const x1 = (to - a0) * px;
    ctx.fillStyle = c.selectFill;
    ctx.strokeStyle = c.select;
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.25);
    const a = Math.max(0, x0);
    const b = Math.min(W, Math.max(a + 2, x1));
    ctx.fillRect(a, 0, b - a, H);
    ctx.strokeRect(a + 0.5, 0.5, b - a - 1, H - 1);
  }
}
