import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROFILES } from '../../extension/profiles.js';

for (const apiName of ['chrome', 'browser']) test(`${apiName}: concurrent batches survive enqueue and an in-flight upload; endpoint parameters are preserved`, async () => {
  const stored = { localConfig: { api_endpoint: 'https://mes.example.com/results?line=SMT-3' } };
  const session = {};
  const area = (data) => ({
    async get(keys) {
      await Promise.resolve();
      const wanted = typeof keys === 'string' ? [keys] : keys || Object.keys(data);
      return structuredClone(Object.fromEntries(wanted.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(patch) { await Promise.resolve(); Object.assign(data, structuredClone(patch)); },
    async remove(key) { delete data[key]; },
  });
  const noopEvent = { addListener() {} };
  let listener;
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const uploaded = [];
  const code = (await fs.readFile(new URL('../../extension/background.js', import.meta.url), 'utf8'))
    .replace("import { DEFAULT_PROFILES } from './profiles.js';", '')
    .replace('export async function getConfig()', 'async function getConfig()');
  const context = vm.createContext({
    DEFAULT_PROFILES, crypto: { randomUUID }, console, URL,
    [apiName]: {
      storage: { local: area(stored), session: area(session), managed: area({}), onChanged: noopEvent },
      tabs: { onRemoved: noopEvent },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      alarms: { onAlarm: noopEvent },
      runtime: {
        getURL: () => 'bundled-config',
        onInstalled: noopEvent, onStartup: noopEvent,
        onMessage: { addListener(fn) { listener = fn; } },
      },
    },
    fetch: async (url, options) => {
      if (url === 'bundled-config') return { json: async () => ({}) };
      uploaded.push({ url, payload: JSON.parse(options.body) });
      if (uploaded.length === 1) { firstStarted(); await firstResponse; }
      return { ok: true, status: 201 };
    },
  });
  if (apiName === 'browser') context.chrome = {};
  vm.runInContext(code, context);
  const send = (msg) => new Promise((resolve) => listener(msg, { tab: { id: 1, url: 'http://tester/image' } }, resolve));
  const msg = (serial) => ({
    type: 'verdictBatch', station: 'IMG-05',
    results: [
      { cellId: '1', serialNumber: serial, status: 'PASSED' },
      { cellId: '2', serialNumber: serial + '-2', status: 'FAILED' },
    ],
    skippedCells: [{ cellId: '3', status: 'MALFUNCTION' }],
  });
  const first = await send(msg('SN-1'));
  assert.equal(first.ok, true);
  await started;
  const responses = await Promise.all([send(msg('SN-3')), send(msg('SN-5'))]);
  assert.ok(responses.every((r) => r.ok));
  assert.equal(stored.queue.length, 3, 'both concurrent arrivals must remain queued during upload');
  releaseFirst();
  await send({ type: 'flushNow' });
  assert.equal(stored.queue.length, 0);
  assert.equal(uploaded.length, 3);
  assert.ok(uploaded.every((u) => u.url === stored.localConfig.api_endpoint));
  assert.equal(new Set(uploaded.map((u) => u.payload.eventId)).size, 3);
  assert.equal(stored.history.length, 3);
  assert.ok(stored.history.every((h) => h.state === 'sent'));
  assert.equal(stored.sentCount, 6, 'count active board results, not batches or skipped cells');
});
