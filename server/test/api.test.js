import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('batch API persists atomically, deduplicates retries, validates all cells, and migrates existing SQLite', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcb-collector-test-'));
  const dbFile = path.join(dir, 'results.db');
  // Create the existing schema before startup to exercise the additive migration.
  const oldDb = new DatabaseSync(dbFile);
  oldDb.exec(`CREATE TABLE test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, serial_number TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PASSED','FAILED')), tester_id TEXT, machine_name TEXT,
    tab_id INTEGER, station TEXT, station_name TEXT, program TEXT, failed_steps TEXT,
    cycle_time_ms INTEGER, page_url TEXT, start_time TEXT, end_time TEXT,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  oldDb.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', DB_FILE: dbFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000);
    child.once('error', (e) => { clearTimeout(timeout); reject(e); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/listening on (http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  async function post(body) {
    const res = await fetch(base + '/api/tester/completed?line=SMT-3', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  const rows = async () => (await (await fetch(base + '/api/test-results')).json()).results;
  const batch = {
    eventId: 'batch-1', completed: true, overallStatus: 'FAILED',
    testerId: 'PC-001', station: 'IMG-05',
    results: Array.from({ length: 7 }, (_, i) => ({
      eventId: `cell-event-${i + 1}`, cellId: String(i + 1), serialNumber: `IMG-${i + 1}`,
      status: i === 1 ? 'FAILED' : 'PASSED', failedSteps: i === 1 ? ['Image alignment'] : [],
    })),
    skippedCells: [{ cellId: '8', status: 'MALFUNCTION', rawStatus: 'MULFUNCTION' }],
  };
  const invalid = structuredClone(batch);
  invalid.results[6].status = 'TESTING';
  assert.equal((await post(invalid)).status, 400);
  assert.equal((await rows()).length, 0);
  const saved = await post(batch);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.results.length, 7);
  assert.equal(saved.body.results[1].status, 'FAILED');
  assert.equal(saved.body.results[0].overall_status, 'FAILED');
  assert.equal(saved.body.results[0].skipped_cells[0].status, 'MALFUNCTION');
  assert.equal((await rows()).length, 7);
  const retry = await post(batch);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal((await rows()).length, 7);

  const conflict = structuredClone(batch);
  conflict.eventId = 'batch-conflict';
  conflict.results[0].eventId = 'new-event';
  assert.equal((await post(conflict)).status, 409);
  assert.equal((await rows()).length, 7, 'no partial batch inserts on event conflict');
  const failureDb = new DatabaseSync(dbFile);
  failureDb.exec(`CREATE TRIGGER fail_test_cell BEFORE INSERT ON test_results
    WHEN NEW.serial_number = 'BREAK' BEGIN SELECT RAISE(ABORT, 'Forced cell storage failure'); END`);
  failureDb.close();
  const storageFailure = {
    ...batch, eventId: 'batch-rollback',
    results: [
      { eventId: 'rollback-cell-1', cellId: '1', serialNumber: 'ROLLBACK-1', status: 'PASSED' },
      { eventId: 'rollback-cell-2', cellId: '2', serialNumber: 'BREAK', status: 'FAILED' },
    ],
  };
  assert.equal((await post(storageFailure)).status, 500);
  assert.equal((await rows()).length, 7, 'storage failure in the second cell must roll back the first cell');
  const checkDb = new DatabaseSync(dbFile);
  assert.equal(checkDb.prepare('SELECT COUNT(*) AS n FROM test_batches WHERE event_id = ?').get('batch-rollback').n, 0);
  checkDb.exec('DROP TRIGGER fail_test_cell');
  checkDb.close();
  const skippedOnly = { ...batch, eventId: 'skip-only', results: [], overallStatus: 'PASSED' };
  assert.equal((await post(skippedOnly)).status, 400);
  const duplicateCell = structuredClone(batch);
  duplicateCell.skippedCells[0].cellId = '1';
  assert.equal((await post(duplicateCell)).status, 400);
  assert.equal((await post({ ...batch, overallStatus: 'PASSED' })).status, 400);
  assert.equal((await post({ eventId: 'single', serialNumber: 'SINGLE-1', status: 'PASSED' })).status, 201);
  const stats = await (await fetch(base + '/api/stats')).json();
  assert.equal(stats.total, 8);
  assert.equal(stats.passed, 7);
  assert.equal(stats.failed, 1);

  const imagePage = await fetch(base + '/testers/image.html');
  assert.equal(imagePage.status, 200);
  assert.match(await imagePage.text(), /imageOverall/);
  await fetch(base + '/api/test-results', { method: 'DELETE' });
  assert.equal((await rows()).length, 0);
  assert.equal((await post(batch)).status, 201, 'clearing results also clears batch dedupe state');
});
