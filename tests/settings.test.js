// Settings: only what differs from the defaults is stored, and the old format is migrated.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, loadSettings, saveSettings } from '../js/settings.js';

function memoryStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

test('fresh settings are the defaults, and saving them stores nothing', () => {
  const storage = memoryStorage();
  const s = loadSettings(storage);
  assert.deepEqual(s, DEFAULTS);
  saveSettings(s, storage);
  assert.equal(storage.data.get('ppk2.html.settings.v2'), '{}');
});

test('only changed settings are stored, nested ones whole', () => {
  const storage = memoryStorage();
  const s = loadSettings(storage);
  s.rate = 1000;
  s.trigger.level = 5000;
  saveSettings(s, storage);
  const saved = JSON.parse(storage.data.get('ppk2.html.settings.v2'));
  assert.deepEqual(Object.keys(saved).sort(), ['rate', 'trigger']);
  assert.equal(loadSettings(storage).trigger.level, 5000);
  assert.equal(loadSettings(storage).trigger.windowMs, DEFAULTS.trigger.windowMs);
});

test('old settings migrate, dropping a 1 s window that was the old default', () => {
  const storage = memoryStorage({
    'ppk2.html.settings.v1': JSON.stringify({ rate: 1000, spanSec: 1, yLog: true, unknown: 1 }),
  });
  const s = loadSettings(storage);
  assert.equal(s.rate, 1000);
  assert.equal(s.yLog, true);
  assert.equal(s.spanSec, DEFAULTS.spanSec);
  assert.ok(!('unknown' in s));
  saveSettings(s, storage);
  assert.ok(!storage.data.has('ppk2.html.settings.v1'), 'old entry removed once saved');
});

test('an explicitly chosen window survives migration', () => {
  const storage = memoryStorage({ 'ppk2.html.settings.v1': JSON.stringify({ spanSec: 10 }) });
  assert.equal(loadSettings(storage).spanSec, 10);
});
