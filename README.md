# ppk2.html

A power profiler for the Nordic **Power Profiler Kit II (PPK2)** in a single web page. It talks to the device
directly over the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API), so there's
nothing to install: no drivers, no desktop app, no backend, no dependencies.

Not affiliated with or endorsed by Nordic Semiconductor.

## Use it

Open **https://pilate.github.io/ppk2.html/** in a desktop browser
([try it with a simulated PPK2](https://pilate.github.io/ppk2.html/?demo)). Connecting a PPK2 needs Web Serial:
Chrome and Edge have it, and recent Firefox versions expose it too. Without it you can still open, view, save and
export recordings, and use the simulated device.

To get the app as a single file, download it from that page with your browser's *Save page as*, or build it:

```sh
python3 build.py          # writes dist/ppk2.html
```

`dist/ppk2.html` is the whole app: styles and code are inlined, so you can double-click it, email it or put it on
any static host. It works straight from disk (`file://`) as well as over `https://`. The only outside request is
for the Barlow web fonts; offline it falls back to system fonts.

**No PPK2 at hand?** Click *Use simulated device*, or add `?demo` to the URL to connect the simulator and start
sampling straight away.

> Close nRF Connect Power Profiler (or any serial terminal) first. Only one program can open the PPK2 at a time.

## Develop

The source is plain HTML, CSS and ES modules: `ppk2.html` loads `css/` and `js/` directly. Browsers won't load
modules from `file://`, so serve the folder while working on it:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/ppk2.html
```

On WSL, run the server inside WSL and open the page in Chrome or Edge on Windows; the PPK2 stays attached to
Windows, where the browser can see it. Run `python3 build.py` again to refresh `dist/ppk2.html` after changes.

Every push to `main` runs the tests, builds `dist/ppk2.html` and publishes it to GitHub Pages
(`.github/workflows/pages.yml`).

## Features

| | |
|---|---|
| **Modes** | Source meter (PPK2 supplies 0.8–5 V) and ammeter |
| **Power** | Set supply voltage, switch power output on and off |
| **Sampling** | 100 kHz native, or averaged down to 50k/20k/10k/1k/100/10/1 Hz for long recordings; optional stop-after duration |
| **Chart** | Live view, scroll to zoom, drag to pan, min/max envelope at any zoom down to individual samples, linear or log current axis, overview strip of the whole recording |
| **Digital** | D0–D7 logic lanes, each one can be shown or hidden |
| **Measure** | Average, max, duration, charge and energy for both the visible window and a selected range; live average and peak |
| **Trigger** | Rising or falling edge at a current level, capture length, pre-trigger percentage, single or continuous |
| **Files** | Save and open recordings as `.ppk2`, the same format as nRF Connect, so files open in either app; export everything or the selection as CSV with the same columns as nRF Connect; save the chart as PNG |
| **Advanced** | Spike-filter tuning, per-range gain adjustment (stored on the PPK2), calibration data viewer, memory limit |
| **Robustness** | Detects lost samples from the PPK2's sample counter and marks them as gaps; realigns the stream automatically after USB buffer overruns |

Keyboard (with the chart focused): `←`/`→` pan, `+`/`−` zoom, `F` show all, `L` follow live, `Esc` clear
selection. `Space` starts and stops sampling.

## How it works

```
ppk2.html, css/app.css       UI (source page)
build.py                     bundles everything into dist/ppk2.html
js/app.js                    wires controls, device, recorder and chart together
js/transport.js              Web Serial port, plus a simulated PPK2 (same byte protocol)
js/ppk2.js                   device commands, metadata/calibration readout, sample stream
js/protocol.js               command bytes, metadata parser, sample decoder and calibration
js/recorder.js               downsampling, stop-after limit, software trigger
js/store.js                  chunked sample storage with a min/max/sum pyramid
js/chart.js                  canvas chart and overview strip
js/ppk2file.js               the .ppk2 recording format (nRF Connect compatible)
js/fileio.js                 save dialog / download, .ppk2 save and open, CSV, PNG
js/zip.js                    ZIP reading and writing with the browser's deflate
js/format.js                 SI-prefixed number formatting and axis ticks
tests/                       unit, end-to-end and file-format tests (Node 20+)
```

**Protocol.** The PPK2 is a USB CDC device (VID `0x1915`, PID `0xC00A`). Commands are a few bytes each:
`0x19` returns the calibration block as text ending in `END`, `0x06`/`0x07` start and stop streaming,
`0x11` sets the mode, `0x0D` sets the supply in mV, `0x0C` switches power output, `0x25` sets a range gain.
While streaming, every sample is a little-endian 32-bit word: 14-bit ADC value, 3-bit range, 6-bit counter and
8 digital bits. Converting the ADC value to current uses the per-range calibration (`R`, `GS`, `GI`, `O`, `S`,
`I`, `UG`) the device reports, plus the same spike filter nRF Connect applies when the range switches.

**Storage.** Samples go into 1 Mi-sample chunks. Each chunk keeps min, max, sum and digital OR/AND for buckets
of 16, 256, 4 096 and 65 536 samples, so drawing a pixel column or computing statistics over any range touches
roughly a hundred values, however long the recording. Memory use is about 6.4 bytes per sample (512 MB holds
about 14 minutes at 100 kHz); when the limit is reached the oldest data is dropped.

**Recording files** use nRF Connect's `.ppk2` format: a ZIP archive (deflate, ZIP64 past 4 GiB) with
`metadata.json` (`{ metadata: { samplesPerSecond, startSystemTime }, formatVersion: 2 }`, plus a `ppk2html`
object with mode, supply voltage, source device and time offset that nRF Connect ignores), `minimap.raw` (the JSON overview
nRF Connect needs to open a file, built with a port of its folding algorithm) and `session.raw` (6 bytes per
sample: little-endian `float32` current in µA, NaN for lost samples, then a big-endian `uint16` with 2 bits per
digital channel: `01` low, `10` high, `11` toggled within the sample). The ZIP code (`js/zip.js`) uses the
browser's built-in deflate, so saving and opening work in Firefox too, where files save as downloads.

From the browser console, `ppk2.chart`, `ppk2.recorder`, `ppk2.device` and `ppk2.session` give access to the live
objects.

## Tests

```sh
npm test        # or: node --test tests/*.test.js
```

The tests cover metadata parsing, command encoding, decoding across ranges and split reads, lost-sample
detection, stream realignment, storage aggregates against brute force (including eviction), downsampling,
the trigger, session save/load and CSV export, and an end-to-end run against the simulated device.

## Not yet supported

- Opening the older `.ppk` files from nRF Connect versions before `.ppk2`
- Streaming very long recordings straight to disk (the recording lives in memory, up to the limit you set)
- Firmware update of the PPK2 (use nRF Connect)
