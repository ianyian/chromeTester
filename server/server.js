// PCB Tester Result Collector — REST API + static host for the demo tester pages.
// Zero dependencies: uses Node's built-in http and node:sqlite (Node >= 22.13).
//
//   node server.js            -> http://localhost:3000
//   PORT=8080 DB_FILE=./x.db node server.js

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'test_results.db');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const VALID_STATUS = new Set(['PASSED', 'FAILED']);

// ---------------------------------------------------------------- database
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS test_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id       TEXT    NOT NULL UNIQUE,      -- idempotency key from the extension
    serial_number  TEXT    NOT NULL,
    status         TEXT    NOT NULL CHECK (status IN ('PASSED','FAILED')),
    tester_id      TEXT,                         -- machine-level ID from extension config, e.g. PCB-TESTER-001
    machine_name   TEXT,                         -- Linux hostname / machine name
    tab_id         INTEGER,                      -- Chrome tab that ran the tester program
    station        TEXT,                         -- tester program/station inside the tab, e.g. ICT-01
    station_name   TEXT,
    program        TEXT,
    failed_steps   TEXT,                         -- JSON array of strings
    cycle_time_ms  INTEGER,
    page_url       TEXT,
    start_time     TEXT,                         -- test start seen by the extension (ISO)
    end_time       TEXT,                         -- verdict seen by the extension (ISO)
    received_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_results_serial ON test_results(serial_number);
  CREATE INDEX IF NOT EXISTS idx_results_tester ON test_results(tester_id);
  CREATE INDEX IF NOT EXISTS idx_results_station ON test_results(station);
`);

const stmt = {
  insert: db.prepare(`
    INSERT OR IGNORE INTO test_results
      (event_id, serial_number, status, tester_id, machine_name, tab_id, station, station_name,
       program, failed_steps, cycle_time_ms, page_url, start_time, end_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  byEvent: db.prepare('SELECT * FROM test_results WHERE event_id = ?'),
  byId: db.prepare('SELECT * FROM test_results WHERE id = ?'),
  stats: db.prepare(`
    SELECT tester_id, machine_name, station, station_name,
           COUNT(*) AS total,
           SUM(status='PASSED') AS passed,
           SUM(status='FAILED') AS failed,
           MAX(received_at) AS last_at
      FROM test_results GROUP BY tester_id, machine_name, station, station_name ORDER BY tester_id, station`),
  clear: db.prepare('DELETE FROM test_results'),
};

function rowOut(r) {
  if (!r) return r;
  let failed = [];
  try { failed = r.failed_steps ? JSON.parse(r.failed_steps) : []; } catch { /* keep [] */ }
  return { ...r, failed_steps: failed };
}

// ---------------------------------------------------------------- helpers
function send(res, code, body, extraHeaders = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders,
  });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const str = (v, max = 256) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

function validateResult(b) {
  const errors = [];
  const serial = str(b.serialNumber, 128);
  const status = str(b.status, 16)?.toUpperCase();
  if (!serial) errors.push('serialNumber is required');
  if (!VALID_STATUS.has(status)) errors.push('status must be PASSED or FAILED');
  const failed = Array.isArray(b.failedSteps) ? b.failedSteps.slice(0, 100).map((s) => String(s).slice(0, 200)) : [];
  const cycle = Number.isFinite(Number(b.cycleTimeMs)) ? Math.round(Number(b.cycleTimeMs)) : null;
  return {
    errors,
    value: {
      eventId: str(b.eventId, 128) || `srv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      serial, status,
      testerId: str(b.testerId, 64),
      machineName: str(b.machineName, 128),
      tabId: Number.isInteger(Number(b.tabId)) ? Number(b.tabId) : null,
      station: str(b.station, 64),
      stationName: str(b.stationName, 128),
      program: str(b.program, 128),
      failed: JSON.stringify(failed),
      cycle,
      pageUrl: str(b.pageUrl, 1024),
      startTime: str(b.startTime, 40),
      endTime: str(b.endTime ?? b.timestamp, 40),
    },
  };
}

// ---------------------------------------------------------------- API
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204);

  if (p === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'pcb-test-collector', time: new Date().toISOString() });
  }

  // POST /api/tester/completed  (primary)  — POST /api/test-results (alias)
  if ((p === '/api/tester/completed' || p === '/api/test-results') && req.method === 'POST') {
    const body = await readJson(req);
    const { errors, value: v } = validateResult(body);
    if (errors.length) return send(res, 400, { error: 'validation_failed', details: errors });
    const info = stmt.insert.run(v.eventId, v.serial, v.status, v.testerId, v.machineName, v.tabId,
      v.station, v.stationName, v.program, v.failed, v.cycle, v.pageUrl, v.startTime, v.endTime);
    const row = rowOut(stmt.byEvent.get(v.eventId));
    const duplicate = info.changes === 0;
    console.log(`${duplicate ? 'DUP ' : 'SAVE'} ${v.status.padEnd(6)} ${v.serial}  [${v.testerId || '?'} / tab ${v.tabId ?? '?'} / ${v.station || '?'}]`);
    return send(res, duplicate ? 200 : 201, { duplicate, result: row });
  }

  if (p === '/api/test-results' && req.method === 'GET') {
    const where = [];
    const args = [];
    const q = url.searchParams;
    if (q.get('status')) { where.push('status = ?'); args.push(q.get('status').toUpperCase()); }
    if (q.get('tester')) { where.push('tester_id = ?'); args.push(q.get('tester')); }
    if (q.get('station')) { where.push('station = ?'); args.push(q.get('station')); }
    if (q.get('serial')) { where.push('serial_number LIKE ?'); args.push(`%${q.get('serial')}%`); }
    if (q.get('sinceId')) { where.push('id > ?'); args.push(Number(q.get('sinceId')) || 0); }
    const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000);
    const sql = `SELECT * FROM test_results ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT ${limit}`;
    return send(res, 200, { results: db.prepare(sql).all(...args).map(rowOut) });
  }

  if (p === '/api/test-results' && req.method === 'DELETE') {
    const info = stmt.clear.run();
    return send(res, 200, { deleted: Number(info.changes) });
  }

  const m = p.match(/^\/api\/test-results\/(\d+)$/);
  if (m && req.method === 'GET') {
    const row = stmt.byId.get(Number(m[1]));
    return row ? send(res, 200, rowOut(row)) : send(res, 404, { error: 'not_found' });
  }

  if (p === '/api/stats' && req.method === 'GET') {
    const testers = stmt.stats.all().map((r) => ({
      ...r,
      yield: r.total ? Math.round((r.passed / r.total) * 1000) / 10 : null,
    }));
    const total = testers.reduce((a, t) => a + t.total, 0);
    const passed = testers.reduce((a, t) => a + t.passed, 0);
    return send(res, 200, { total, passed, failed: total - passed, yield: total ? Math.round((passed / total) * 1000) / 10 : null, testers });
  }

  return send(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message || 'internal_error' });
  }
});

server.listen(PORT, () => {
  console.log(`PCB Tester Collector listening on http://localhost:${PORT}`);
  console.log(`  Testers   : http://localhost:${PORT}/`);
  console.log(`  Dashboard : http://localhost:${PORT}/dashboard.html`);
  console.log(`  API       : POST http://localhost:${PORT}/api/tester/completed`);
  console.log(`  SQLite DB : ${DB_FILE}`);
});
