import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULT_PROFILES, validateProfiles } from '../../extension/profiles.js';

const source = await fs.readFile(new URL('../../extension/content.js', import.meta.url), 'utf8');
const image = DEFAULT_PROFILES.find((p) => p.id === 'demo-image');

async function collector(profile, initial = 'IDLE') {
  const messages = [];
  const overall = { textContent: initial, getAttribute: () => overall.textContent };
  const serial = { textContent: 'SN-123456', value: 'SN-123456' };
  const cells = Array.from({ length: 8 }, (_, i) => {
    const status = { textContent: i === 7 ? 'MALFUNCTION' : 'IDLE' };
    const serial = { value: i === 7 ? '' : `SN-${i + 1}` };
    const failure = { textContent: '' };
    return {
      id: String(i + 1), status, serial, failure,
      getAttribute() { return this.id; },
      querySelector(selector) { return selector === '.cell-status' ? status : selector === '.cell-serial' ? serial : null; },
      querySelectorAll() { return failure.textContent ? [failure] : []; },
    };
  });
  let check;
  const context = vm.createContext({
    window: {}, location: { href: 'http://localhost/testers/image.html' }, console,
    document: {
      title: 'Tester', documentElement: {},
      querySelector: (selector) => selector === profile.status_selector ? overall : serial,
      querySelectorAll: (selector) => selector === profile.cells?.selector ? cells : [],
    },
    chrome: { runtime: { sendMessage: async (msg) => {
      if (msg.type === 'getProfile') return { profile };
      messages.push(JSON.parse(JSON.stringify(msg)));
      return { ok: true };
    } } },
    MutationObserver: class { observe() {} },
    setInterval: (fn) => { check = fn; },
    setTimeout: (fn) => fn(),
  });
  context.window.top = context.window;
  await vm.runInContext(source, context);
  return {
    cells, overall, messages, serial,
    tick: async () => { check(); await Promise.resolve(); },
    batches: () => messages.filter((m) => m.type === 'verdictBatch'),
    finish: () => { cells.slice(0, 7).forEach((c) => { c.status.textContent = 'PASSED'; }); },
  };
}

test('waits for all eight cells and overall completion, excluding malfunction; retests once per cycle', async () => {
  const c = await collector(image);
  c.overall.textContent = 'TESTING';
  c.cells.slice(0, 7).forEach((cell) => { cell.status.textContent = 'TESTING'; });
  await c.tick();
  c.cells[1].status.textContent = 'FAILED';
  c.cells[1].failure.textContent = 'Image alignment';
  await c.tick();
  assert.equal(c.batches().length, 0);
  c.finish();
  c.cells[1].status.textContent = 'FAILED';
  await c.tick();
  assert.equal(c.batches().length, 0, 'configured overall indicator must finish too');
  c.overall.textContent = 'COMPLETE';
  await c.tick();
  const batch = c.batches()[0];
  assert.equal(batch.results.length, 7);
  assert.equal(batch.overallStatus, 'FAILED');
  assert.deepEqual(batch.results[1].failedSteps, ['Image alignment']);
  assert.deepEqual(batch.skippedCells, [{ cellId: '8', status: 'MALFUNCTION', rawStatus: 'MALFUNCTION', serialNumber: null }]);
  await c.tick();
  assert.equal(c.batches().length, 1);
  c.overall.textContent = 'TESTING';
  c.cells.slice(0, 7).forEach((cell) => { cell.status.textContent = 'TESTING'; });
  await c.tick();
  c.finish(); c.overall.textContent = 'COMPLETE';
  await c.tick();
  assert.equal(c.batches().length, 2, 'same serial may be retested');
  assert.equal(c.batches()[1].overallStatus, 'PASSED');
});

test('cells mode waits for full cell count and serials and does not rearm while overall still runs', async () => {
  const c = await collector({ ...image, completion_mode: 'cells' });
  c.overall.textContent = 'TESTING'; await c.tick();
  c.finish();
  const last = c.cells.pop();
  await c.tick();
  assert.equal(c.batches().length, 0, 'missing eighth cell must not be treated as skipped');
  c.cells.push(last);
  c.cells[0].serial.value = '';
  await c.tick();
  assert.equal(c.batches().length, 0, 'active serial must not be UNKNOWN');
  c.cells[0].serial.value = 'SN-1';
  c.cells[1].serial.value = 'SN-1';
  await c.tick();
  assert.equal(c.batches().length, 0, 'duplicate active serials must wait for correction');
  c.cells[1].serial.value = 'SN-2';
  await c.tick(); await c.tick();
  assert.equal(c.batches().length, 1);
});

test('initial final display, aborted cycles, and all-malfunction cycles do not upload', async () => {
  const c = await collector(image, 'COMPLETE');
  c.finish(); await c.tick();
  assert.equal(c.batches().length, 0);
  c.overall.textContent = 'TESTING'; await c.tick();
  c.overall.textContent = 'IDLE'; await c.tick();
  c.overall.textContent = 'COMPLETE'; await c.tick();
  assert.equal(c.batches().length, 0);
  c.overall.textContent = 'TESTING'; await c.tick();
  c.cells.forEach((cell) => { cell.status.textContent = 'MULFUNCTION'; });
  c.overall.textContent = 'COMPLETE'; await c.tick();
  assert.equal(c.batches().length, 0);
});

test('single-board profiles retain verdict and retest behavior', async () => {
  const c = await collector(DEFAULT_PROFILES.find((p) => p.id === 'demo-ict'), 'PASSED');
  await c.tick();
  assert.equal(c.messages.filter((m) => m.type === 'verdict').length, 0);
  c.overall.textContent = 'TESTING'; await c.tick();
  c.overall.textContent = 'FAILED'; await c.tick(); await c.tick();
  const verdicts = c.messages.filter((m) => m.type === 'verdict');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].serial, 'SN-123456');
  assert.equal(verdicts[0].normalized, 'FAILED');
});

test('profile validation rejects ambiguous cell words and missing lifecycle configuration', () => {
  validateProfiles(DEFAULT_PROFILES);
  assert.throws(() => validateProfiles([{ ...image, cells: { ...image.cells, skip_values: ['FAILED'] } }]), /overlap/);
  assert.throws(() => validateProfiles([{ ...image, cells: { ...image.cells, count: 0 } }]), /count/);
  assert.throws(() => validateProfiles([{ ...image, running_values: [] }]), /running_values/);
  assert.throws(() => validateProfiles([{ ...image, running_values: ['COMPLETE'] }]), /overlap/);
});
