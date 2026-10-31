// Round-trips recordings through the session format and CSV export.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportCsv, loadSession, saveSession } from '../js/fileio.js';
import { SampleStore } from '../js/store.js';

// Without showSaveFilePicker, fileio falls back to a download; capture the blob it creates.
let lastBlob = null;
globalThis.window = {};
globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } };
URL.createObjectURL = (blob) => ((lastBlob = blob), 'blob:test');
URL.revokeObjectURL = () => {};

function sampleStore() {
  const store = new SampleStore(1000, 0);
  for (let i = 0; i < 2500; i++) store.append(i === 7 ? NaN : i * 0.5, i & 0xff);
  return store;
}

test('session files round-trip samples, gaps, bits and header', async () => {
  const store = sampleStore();
  await saveSession(store, { mode: 2, vdd: 3300, startedAt: '2026-01-01T00:00:00Z' });
  const file = new File([await lastBlob.arrayBuffer()], 'x.wppk2');
  const { store: loaded, header } = await loadSession(file, 0);
  assert.equal(header.vdd, 3300);
  assert.equal(header.mode, 2);
  assert.equal(loaded.sampleRate, 1000);
  assert.equal(loaded.length, 2500);
  assert.ok(Number.isNaN(loaded.valueAt(7)));
  assert.equal(loaded.valueAt(2499), 2499 * 0.5);
  assert.equal(loaded.bitsAt(300), 300 & 0xff);
});

test('rejects files that are not sessions', async () => {
  await assert.rejects(loadSession(new File(['hello world, not a session'], 'a.txt'), 0), /not a session/);
});

test('CSV export uses nRF Connect columns', async () => {
  const store = sampleStore();
  await exportCsv(store, 5, 9, { digital: true });
  const lines = (await lastBlob.text()).trim().split('\n');
  assert.equal(lines[0], 'Timestamp(ms),Current(uA),D0-D7');
  assert.equal(lines[1], '5,2.5000,10100000');
  assert.equal(lines[3], '7,,11100000', 'lost sample has an empty current');
  assert.equal(lines.length, 5);
});
