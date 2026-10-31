// User settings: their defaults, and loading and saving them in localStorage. Only settings
// that differ from the defaults are stored, so changing a default reaches everyone who hasn't
// picked their own value.

import { DEFAULT_SPIKE_FILTER } from './protocol.js';

export const DEFAULTS = {
  rate: 100_000,
  limit: 0,
  buffer: 536_870_912,
  spike: { ...DEFAULT_SPIKE_FILTER },
  trigger: { enabled: false, level: 1000, unit: 1000, edge: 'rising', windowMs: 10, prePercent: 10, mode: 'single' },
  yLog: false,
  showDigital: true,
  channels: 0xff,
  spanSec: 4,
  main: 'current', // signal in the big chart: 'current' or a digital channel number
  tool: 'pan',
  csvDigital: true,
  sideHidden: false,
};

const KEY = 'ppk2.html.settings.v2';
const OLD_KEY = 'ppk2.html.settings.v1'; // stored every setting, defaults included

/** Defaults overlaid with what was saved (or migrated from the old format). */
export function loadSettings(storage = globalThis.localStorage) {
  const s = structuredClone(DEFAULTS);
  try {
    let saved = JSON.parse(storage.getItem(KEY) || 'null');
    if (!saved) {
      saved = JSON.parse(storage.getItem(OLD_KEY) || '{}');
      // The old format can't tell a chosen 1 s window from the old default, so let the new default apply.
      if (saved.spanSec === 1) delete saved.spanSec;
    }
    for (const [k, v] of Object.entries(saved)) {
      if (k in s) s[k] = typeof s[k] === 'object' ? { ...s[k], ...v } : v;
    }
  } catch {}
  return s;
}

/** Store the settings that differ from the defaults. */
export function saveSettings(settings, storage = globalThis.localStorage) {
  const changed = Object.fromEntries(
    Object.entries(settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])),
  );
  try {
    storage.setItem(KEY, JSON.stringify(changed));
    storage.removeItem(OLD_KEY);
  } catch {}
}
