// Byte transports: a Web Serial port, or a simulated PPK2 for demos.

import {
  Cmd,
  MODIFIER_FIELDS,
  PowerMode,
  SAMPLE_RATE,
  USB_PRODUCT_ID,
  USB_VENDOR_ID,
  encodeWord,
  linearModifiers,
  rawForCurrent,
} from './protocol.js';

const NON_FATAL = new Set(['BufferOverrunError', 'BreakError', 'FramingError', 'ParityError']);

/**
 * Transports call these hooks:
 *   ondata(Uint8Array)   bytes received
 *   onoverrun()          bytes were dropped; the decoder must resync
 *   onclose(error?)      the device went away
 */
export class SerialTransport {
  static get supported() {
    return 'serial' in navigator;
  }

  static async request() {
    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: USB_VENDOR_ID, usbProductId: USB_PRODUCT_ID }],
    });
    return new SerialTransport(port);
  }

  /** Ports the user granted earlier; lets us reconnect without the picker. */
  static async known() {
    if (!SerialTransport.supported) return [];
    const ports = await navigator.serial.getPorts();
    return ports
      .filter((p) => {
        const info = p.getInfo();
        return info.usbVendorId === USB_VENDOR_ID && info.usbProductId === USB_PRODUCT_ID;
      })
      .map((p) => new SerialTransport(p));
  }

  constructor(port) {
    this.port = port;
    this.label = 'PPK2';
    this.ondata = null;
    this.onoverrun = null;
    this.onclose = null;
    this.closing = false;
    // Unplugging normally also ends the read loop with an error; this handles it directly.
    port.addEventListener('disconnect', () => {
      if (!this.closing) this.onclose?.(null);
      this.closing = true;
    });
  }

  async open() {
    // Baud rate is ignored by the CDC device; the large buffer absorbs main-thread stalls
    // (400 kB/s at full rate, so 8 MiB is about 20 s of slack).
    await this.port.open({ baudRate: 115200, bufferSize: 8 * 1024 * 1024 });
    try {
      // Like pyserial, assert DTR/RTS; some CDC firmware only streams when DTR is set.
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch {}
    this.writer = this.port.writable.getWriter();
    this.loop = this._readLoop();
  }

  async _readLoop() {
    let error = null;
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) this.ondata?.(value);
        }
      } catch (e) {
        if (NON_FATAL.has(e.name)) {
          this.onoverrun?.();
        } else {
          error = e;
          break;
        }
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closing) this.onclose?.(error);
  }

  async write(bytes) {
    await this.writer.write(Uint8Array.from(bytes));
  }

  async close() {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {}
    await this.loop?.catch(() => {});
    try {
      this.writer?.releaseLock();
    } catch {}
    try {
      await this.port.close();
    } catch {}
  }
}

/**
 * A software PPK2: answers commands and streams sample words with the same
 * encoding as the hardware. The simulated DUT sleeps at a few µA and wakes
 * every 100 ms for a radio event, toggling D0 while awake.
 */
export class DemoTransport {
  constructor() {
    this.label = 'Simulated PPK2';
    this.ondata = null;
    this.onoverrun = null;
    this.onclose = null;
    this.modifiers = linearModifiers();
    this.vdd = 3000;
    this.mode = PowerMode.Source;
    this.dutOn = false;
    this.sampling = false;
    this.t = 0; // sample index, also the sample counter
    this.timer = null;
  }

  async open() {}

  async write(bytes) {
    const b = Array.from(bytes);
    switch (b[0]) {
      case Cmd.GetMetadata:
        setTimeout(() => this._send(new TextEncoder().encode(this._metadata())), 20);
        break;
      case Cmd.AverageStart:
        this._start();
        break;
      case Cmd.AverageStop:
        this._stop();
        break;
      case Cmd.DeviceRunningSet:
        this.dutOn = b[1] === 1;
        break;
      case Cmd.RegulatorSet:
        this.vdd = (b[1] << 8) | b[2];
        break;
      case Cmd.SetPowerMode:
        this.mode = b[1];
        break;
      case Cmd.SetUserGains:
        this.modifiers.ug[b[1]] = new Float32Array(new Uint8Array(b.slice(2, 6)).buffer)[0];
        break;
    }
  }

  async close() {
    this._stop();
  }

  _send(bytes) {
    this.ondata?.(bytes);
  }

  _metadata() {
    const lines = ['Calibrated: 0'];
    for (const [key, name] of MODIFIER_FIELDS) {
      this.modifiers[key].forEach((v, k) => lines.push(`${name}${k}: ${v.toFixed(4)}`));
    }
    lines.push(`VDD: ${this.vdd}`, 'HW: 0', `mode: ${this.mode}`, 'IA: 0', 'END', '');
    return lines.join('\n');
  }

  _start() {
    if (this.sampling) return;
    this.sampling = true;
    let last = performance.now();
    let owed = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      owed += ((now - last) / 1000) * SAMPLE_RATE;
      last = now;
      const n = Math.min(Math.floor(owed), SAMPLE_RATE / 2);
      owed -= n;
      if (n > 0) this._send(this._generate(n));
    }, 15);
  }

  _stop() {
    this.sampling = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  _dutCurrent(t) {
    // Amperes for sample index t at 100 kHz.
    if (this.mode === PowerMode.Source && !this.dutOn) return 0;
    const scale = this.mode === PowerMode.Source ? this.vdd / 3000 : 1;
    const phase = t % 10_000; // 100 ms period
    let amps = 3.2e-6 + 0.4e-6 * Math.sin(t / 900);
    if (phase < 30) amps = 1.1e-3; // wake-up
    else if (phase < 180) amps = 2.4e-3;
    else if (phase < 380) amps = 6.8e-3 + 0.3e-3 * Math.sin(phase / 7); // radio TX/RX
    else if (phase < 420) amps = 1.4e-3;
    if (t % 50_000 > 20_000 && t % 50_000 < 20_400) amps += 18e-3; // 18 mA burst every 500 ms
    return amps * scale;
  }

  _generate(n) {
    const out = new Uint8Array(n * 4);
    const view = new DataView(out.buffer);
    for (let k = 0; k < n; k++) {
      const t = this.t++;
      const amps = this._dutCurrent(t);
      const noisy = amps * (1 + 0.02 * gauss()) + 0.08e-6 * gauss();
      const raw = rawForCurrent(noisy, this.modifiers);
      const awake = amps > 2e-3 ? 1 : 0;
      const d1 = (t >> 11) & 1; // ~24 Hz square wave
      const bits = awake | (d1 << 1) | ((t % 10_000 < 20 ? 1 : 0) << 2);
      view.setUint32(k * 4, encodeWord(raw & 0xffff, raw >> 16, t, bits), true);
    }
    return out;
  }
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.2;
}
