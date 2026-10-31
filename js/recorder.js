// Turns the 100 kHz sample stream into a recording: optional averaging down to
// a lower rate, a duration limit and a software trigger.

import { SAMPLE_RATE } from './protocol.js';
import { SampleStore } from './store.js';

export const SAMPLE_RATES = [100_000, 50_000, 20_000, 10_000, 1_000, 100, 10, 1];

export class Trigger {
  constructor() {
    this.level = 1000; // µA
    this.edge = 'rising';
    this.windowSec = 0.01;
    this.prePercent = 10;
    this.mode = 'single'; // or 'continuous'
    this.state = 'off'; // off | armed | capturing
    this.captures = 0;
    this.last = null; // most recent capture: { trigger, from, to }
    this.oncapture = null; // (capture, { final }) => void
    this._prev = NaN;
    this._pending = null;
  }

  /** Apply UI settings: { level (µA), edge, windowMs, prePercent, mode }. */
  configure({ level, edge, windowMs, prePercent, mode }) {
    Object.assign(this, { level, edge, windowSec: windowMs / 1000, prePercent, mode });
  }

  get active() {
    return this.state !== 'off';
  }

  arm() {
    this.state = 'armed';
    this.captures = 0;
    this.last = null;
    this._prev = NaN;
  }

  /** Stop looking for triggers; the last capture stays available. */
  disarm() {
    this.state = 'off';
  }

  feed(index, value, rate) {
    if (this.state === 'armed') {
      const prev = this._prev;
      this._prev = value;
      if (prev !== prev || value !== value) return;
      const crossed =
        this.edge === 'rising' ? prev < this.level && value >= this.level : prev > this.level && value <= this.level;
      if (!crossed) return;
      const total = Math.max(2, Math.round(this.windowSec * rate));
      const pre = Math.round((total * this.prePercent) / 100);
      this._pending = { trigger: index, from: index - pre, to: index + (total - pre) };
      this.state = 'capturing';
    } else if (this.state === 'capturing' && index + 1 >= this._pending.to) {
      const final = this.mode === 'single';
      this.last = this._pending;
      this.captures++;
      this.state = final ? 'off' : 'armed';
      this._prev = value;
      this.oncapture?.(this.last, { final });
    }
  }
}

export class Recorder {
  constructor() {
    this.store = null;
    this.trigger = new Trigger();
    this.rate = SAMPLE_RATE;
    this.onlimit = null;
    this._limitIndex = Infinity;
    this._factor = 1;
    this._sum = 0;
    this._cnt = 0;
    this._n = 0;
    this._bits = 0;
    this.sink = (uA, bits) => this.push(uA, bits);
  }

  begin({ rate, maxBytes, limitSec, triggerEnabled }) {
    this.rate = rate;
    this._factor = Math.max(1, Math.round(SAMPLE_RATE / rate));
    this._limitIndex = limitSec > 0 ? limitSec * rate : Infinity;
    this.store = new SampleStore(rate, maxBytes);
    this._sum = this._cnt = this._n = this._bits = 0;
    if (triggerEnabled) this.trigger.arm();
    else this.trigger.disarm();
    return this.store;
  }

  /** Stop accepting samples; the store stays readable. */
  end() {
    this._limitIndex = -1;
    this.trigger.disarm();
  }

  push(uA, bits) {
    const store = this.store;
    if (!store || store.end >= this._limitIndex) return;
    let value = uA;
    if (this._factor > 1) {
      if (uA === uA) {
        this._sum += uA;
        this._cnt++;
      }
      this._bits |= bits;
      if (++this._n < this._factor) return;
      value = this._cnt ? this._sum / this._cnt : NaN;
      bits = this._bits;
      this._sum = this._cnt = this._n = this._bits = 0;
    }
    const index = store.end;
    store.append(value, bits);
    if (this.trigger.state !== 'off') this.trigger.feed(index, value, this.rate);
    if (store.end >= this._limitIndex) this.onlimit?.();
  }
}
