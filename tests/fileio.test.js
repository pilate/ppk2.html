// Round-trips recordings through the .ppk2 format and CSV export.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writeCsv } from '../js/fileio.js';
import { FoldingBuffer, readPpk2, writePpk2 } from '../js/ppk2file.js';
import { SampleStore } from '../js/store.js';
import { ZipWriter, memorySink, openZipEntry, readZipDirectory, readZipText } from '../js/zip.js';

function sampleStore() {
  const store = new SampleStore(1000, 0);
  for (let i = 0; i < 2500; i++) store.append(i === 7 ? NaN : i * 0.5, i & 0xff);
  return store;
}

async function ppk2(store, info = {}) {
  const sink = memorySink();
  await writePpk2(sink, store, info);
  return new File([sink.blob()], 'x.ppk2');
}

/** A ZIP of [name, bytes, sizeHint?] entries, built directly. */
async function zipFile(entries, name = 'test.ppk2') {
  const sink = memorySink();
  const zip = new ZipWriter(sink);
  for (const [entry, bytes, sizeHint] of entries) await zip.add(entry, [bytes], sizeHint);
  await zip.finish();
  return new File([sink.blob()], name);
}

const json = (value) => new TextEncoder().encode(JSON.stringify(value));

test('.ppk2 files round-trip samples, gaps, bits and recording details', async () => {
  const file = await ppk2(sampleStore(), { mode: 2, vdd: 3300, startedAt: '2026-01-01T00:00:00.000Z', source: 'PPK2' });
  const { store, info } = await readPpk2(file);
  assert.equal(store.sampleRate, 1000);
  assert.equal(store.length, 2500);
  assert.ok(Number.isNaN(store.valueAt(7)));
  assert.equal(store.valueAt(2499), 2499 * 0.5);
  assert.equal(store.bitsAt(300), 300 & 0xff);
  assert.deepEqual(info, { startedAt: '2026-01-01T00:00:00.000Z', mode: 2, vdd: 3300, source: 'PPK2' });
});

test('archive holds the three entries nRF Connect expects', async () => {
  const file = await ppk2(sampleStore(), { startedAt: '2026-01-01T00:00:00.000Z' });
  const entries = await readZipDirectory(file);
  assert.deepEqual([...entries.keys()], ['metadata.json', 'minimap.raw', 'session.raw']);
  const meta = JSON.parse(await readZipText(file, entries.get('metadata.json')));
  assert.equal(meta.formatVersion, 2);
  assert.deepEqual(meta.metadata, { samplesPerSecond: 1000, startSystemTime: Date.parse('2026-01-01T00:00:00Z') });
});

test('local headers are patched with the real CRC and sizes', async () => {
  const file = await ppk2(sampleStore());
  for (const [name, e] of await readZipDirectory(file)) {
    const local = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
    assert.notEqual(local.getUint32(14, true), 0, `${name} CRC`);
    assert.equal(local.getUint32(18, true), e.compSize, `${name} compressed size`);
    assert.equal(local.getUint32(22, true), e.size, `${name} size`);
  }
});

test('session.raw uses float32 LE current and uint16 BE bit pairs', async () => {
  const store = new SampleStore(100_000, 0);
  store.append(12.5, 0b00000101); // D0 and D2 high
  const file = await ppk2(store);
  const entry = (await readZipDirectory(file)).get('session.raw');
  const raw = new DataView(await new Response(await openZipEntry(file, entry)).arrayBuffer());
  assert.equal(raw.byteLength, 6);
  assert.equal(raw.getFloat32(0, true), 12.5);
  // Pairs from D7 down to D0: 01 01 01 01 01 10 01 10
  assert.equal(raw.getUint16(4, false), 0b0101010101100110);
});

test('minimap follows nRF Connect folding', () => {
  const m = new FoldingBuffer();
  for (let i = 0; i < 25_000; i++) m.add(i === 0 ? 0.05 : 1, i * 10);
  const out = JSON.parse(JSON.stringify(m));
  // Like nRF Connect, it folds as soon as the 10 000th bucket is created, even part-filled: after
  // sample 10 000 (to 2 per bucket) and after sample 19 999 (to 4, with that bucket holding 1). Samples
  // 20 002 on fill 1 249 buckets of 4 plus a last bucket of 2.
  assert.equal(out.numberOfTimesToFold, 4);
  assert.equal(out.data.length, 6250);
  assert.equal(out.lastElementFoldCount, 2);
  assert.equal(out.maxNumberOfElements, 10_000);
  assert.equal(out.data.min.length, 10_000);
  assert.equal(out.data.min[6250], null);
  assert.equal(out.data.min[0].y, 200, 'values below 200 nA are floored');
  assert.equal(out.data.max[6249].y, 1000);
  assert.equal(out.data.min[6249].x, ((24_998 + 24_999) / 2) * 10);
  assert.equal(out.data.max[6249].x, out.data.min[6249].x);
});

// Hand-built records, written the way nRF Connect writes them: no ppk2html extras, and a
// channel that toggled within a sample stored as 11.
const nrfRecords = (() => {
  const raw = new Uint8Array(12);
  const v = new DataView(raw.buffer);
  v.setFloat32(0, 3.25, true);
  v.setUint16(4, 0b0101010101010111, false); // D0 toggled, others low
  v.setFloat32(6, 0.2, true);
  v.setUint16(10, 0x5555, false); // all low
  return raw;
})();
const nrfMetadata = json({ metadata: { samplesPerSecond: 100000, startSystemTime: 1700000000000 }, formatVersion: 2 });

test('reads files written the way nRF Connect writes them', async () => {
  const file = await zipFile([
    ['session.raw', nrfRecords],
    ['minimap.raw', json({})],
    ['metadata.json', nrfMetadata],
  ]);
  const { store, info } = await readPpk2(file);
  assert.equal(store.length, 2);
  assert.equal(store.valueAt(0), 3.25);
  assert.equal(store.bitsAt(0), 1, 'toggled counts as high');
  assert.equal(store.bitsAt(1), 0);
  assert.equal(info.startedAt, new Date(1700000000000).toISOString());
  assert.equal(info.mode, undefined);
});

test('ZIP64 entries read back', async () => {
  const file = await zipFile([
    ['metadata.json', nrfMetadata],
    ['session.raw', nrfRecords, 2 ** 32],
  ]);
  const entries = await readZipDirectory(file);
  assert.equal(entries.get('session.raw').size, 12);
  const { store } = await readPpk2(file);
  assert.equal(store.length, 2);
  assert.equal(store.valueAt(0), 3.25);
});

test('rejects files that are not recordings', async () => {
  await assert.rejects(readPpk2(new File(['hello world, not a recording'], 'a.txt')), /a\.txt is not a \.ppk2 recording/);
});

test('CSV export uses nRF Connect columns', async () => {
  const sink = memorySink();
  await writeCsv(sink, sampleStore(), 5, 9, { digital: true });
  const lines = (await sink.blob().text()).trim().split('\n');
  assert.equal(lines[0], 'Timestamp(ms),Current(uA),D0-D7');
  assert.equal(lines[1], '5,2.5000,10100000');
  assert.equal(lines[3], '7,,11100000', 'lost sample has an empty current');
  assert.equal(lines.length, 5);
});
