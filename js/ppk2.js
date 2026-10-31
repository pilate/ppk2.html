// High-level PPK2 control over a byte transport.

import { PowerMode, SampleDecoder, clampVdd, command, parseMetadata } from './protocol.js';

const METADATA_TIMEOUT_MS = 2000;

const LATIN1 = new TextDecoder('latin1');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class Ppk2Device {
  /**
   * @param {import('./transport.js').SerialTransport | import('./transport.js').DemoTransport} transport
   */
  constructor(transport) {
    this.transport = transport;
    this.decoder = new SampleDecoder();
    this.metadata = null;
    this.mode = PowerMode.Source;
    this.vdd = 3000;
    this.dutPower = false;
    this.sampling = false;
    this.overruns = 0; // USB buffer overruns since sampling started
    this.onsample = null; // (uA, bits) at 100 kHz
    this.onclose = null;
    this._text = null;
    this._discard = false;
    this._writeChain = Promise.resolve();
  }

  get label() {
    return this.transport.label;
  }

  async open() {
    const t = this.transport;
    t.ondata = (bytes) => this._onData(bytes);
    t.onoverrun = () => {
      this.decoder.resync();
      this.overruns++;
    };
    t.onclose = (err) => {
      this.sampling = false;
      this.onclose?.(err);
    };
    await t.open();

    // The device may still be streaming from an earlier session.
    this._discard = true;
    await this._send(command.stop());
    await delay(150);
    this._discard = false;

    this.metadata = await this._readMetadata();
    this.decoder.modifiers = this.metadata.modifiers;
    if (this.metadata.vdd) this.vdd = this.metadata.vdd;
    if (this.metadata.mode === PowerMode.Ammeter || this.metadata.mode === PowerMode.Source) {
      this.mode = this.metadata.mode;
    }
    this.decoder.vdd = this.vdd;
  }

  /** Samples the device dropped since sampling started, per its sample counter. */
  get lostSamples() {
    return this.decoder.lostSamples;
  }

  /** Range gains currently applied (1 = no adjustment). */
  get userGains() {
    return [...this.decoder.modifiers.ug];
  }

  setSpikeFilter(spike) {
    this.decoder.spike = { ...spike };
  }

  async close() {
    if (this.sampling) await this.stop().catch(() => {});
    await this.transport.close();
  }

  _send(bytes) {
    // Serialise writes so commands never interleave.
    const p = this._writeChain.then(() => this.transport.write(bytes));
    this._writeChain = p.catch(() => {});
    return p;
  }

  _onData(bytes) {
    if (this._text !== null) {
      this._text += LATIN1.decode(bytes);
      return;
    }
    if (this._discard || !this.sampling || !this.onsample) return;
    this.decoder.decode(bytes, this.onsample);
  }

  async _readMetadata() {
    for (let attempt = 0; attempt < 3; attempt++) {
      this._text = '';
      await this._send(command.getMetadata());
      const started = performance.now();
      while (performance.now() - started < METADATA_TIMEOUT_MS) {
        await delay(25);
        const end = this._text.indexOf('END');
        if (end >= 0) {
          const text = this._text.slice(0, end);
          this._text = null;
          return parseMetadata(text);
        }
      }
    }
    this._text = null;
    throw new Error('The device did not send its calibration data. Unplug the PPK2, plug it back in and connect again.');
  }

  async setMode(mode) {
    this.mode = mode;
    await this._send(command.powerMode(mode));
  }

  async setVdd(mV) {
    this.vdd = clampVdd(mV);
    this.decoder.vdd = this.vdd;
    await this._send(command.vdd(this.vdd));
  }

  async setDutPower(on) {
    this.dutPower = on;
    await this._send(command.dutPower(on));
  }

  async setUserGain(range, gain) {
    this.decoder.setUserGain(range, gain);
    await this._send(command.userGain(range, gain));
  }

  async start() {
    this.decoder.reset();
    this.overruns = 0;
    this.sampling = true;
    try {
      await this._send(command.start());
    } catch (e) {
      this.sampling = false;
      throw e;
    }
  }

  async stop() {
    this.sampling = false;
    await this._send(command.stop());
  }
}
