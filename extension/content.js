// Content script: runs in every tab, but only activates when the background
// worker returns a profile for this URL. It watches the tester page DOM and
// reports exactly once per test cycle when the state moves into PASSED / FAILED.
(async () => {
  'use strict';
  if (window.top !== window) return;

  let profile;
  try {
    ({ profile } = await chrome.runtime.sendMessage({ type: 'getProfile', url: location.href }));
  } catch { return; }
  if (!profile) return;

  const norm = (s) => String(s ?? '').trim().toUpperCase();
  const PASS = new Set((profile.pass_values || ['PASSED']).map(norm));
  const FAIL = new Set((profile.fail_values || ['FAILED']).map(norm));
  const RUN = new Set((profile.running_values || []).map(norm));

  function read(selector, source, root = document) {
    if (!selector) return '';
    const el = root.querySelector(selector);
    if (!el) return null;
    return readElement(el, source);
  }

  function readElement(el, source) {
    source = source || 'text';
    if (source === 'value') return el.value ?? '';
    if (source.startsWith('attr:')) return el.getAttribute(source.slice(5)) ?? '';
    return el.textContent ?? '';
  }

  function readSerial(mapping = profile, root = document) {
    let raw = read(mapping.serial_selector, mapping.serial_source, root);
    if (raw == null) return '';
    raw = raw.trim();
    if (mapping.serial_regex) {
      const m = raw.match(new RegExp(mapping.serial_regex, 'i'));
      if (!m) return '';
      return (m[1] ?? m[0]).trim();
    }
    return raw;
  }

  function readFailed(mapping = profile, root = document) {
    if (!mapping.failed_selector) return [];
    const parts = [...root.querySelectorAll(mapping.failed_selector)].map((e) => {
      // failed_cells: 1-based cell indexes of a matched table row to join, e.g. [2, 3] -> "Resistor R1"
      if (Array.isArray(mapping.failed_cells) && e.cells) {
        return mapping.failed_cells.map((i) => e.cells[i - 1]?.textContent.trim()).filter(Boolean).join(' ');
      }
      return e.textContent.trim();
    }).filter(Boolean);
    return [...new Set(parts)].slice(0, 50);
  }

  // Generic profile: only activate if the marker element actually exists.
  if (profile.require_element) {
    const deadline = Date.now() + 5000;
    while (!document.querySelector(profile.status_selector)) {
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  let lastRaw = null;
  // "armed" becomes true once we observe a non-final state. This avoids re-reporting a
  // verdict that was already on screen when the page (or extension) was reloaded, and it
  // allows the same serial to be reported again when it is re-tested.
  let armed = false;
  let runStart = null;
  let pendingFinal = null;

  function classify(raw) {
    const v = norm(raw);
    if (PASS.has(v)) return 'PASSED';
    if (FAIL.has(v)) return 'FAILED';
    return null;
  }

  const cellEnds = new Map();
  let cellError = '';
  let cellLastOverall = null;
  function checkCells(v) {
    const c = profile.cells;
    const roots = [...document.querySelectorAll(c.selector)];
    const pass = new Set((c.pass_values || ['PASSED']).map(norm));
    const fail = new Set((c.fail_values || ['FAILED']).map(norm));
    const skip = new Set((c.skip_values || ['MALFUNCTION', 'MULFUNCTION']).map(norm));
    const completed = new Set((profile.completion_values || []).map(norm));

    const previous = cellLastOverall;
    cellLastOverall = v;
    if (RUN.has(v) && !RUN.has(previous)) {
      armed = true;
      runStart = Date.now();
      cellEnds.clear();
    } else if (!RUN.has(v) && !classify(v) && !completed.has(v)) {
      armed = false;
      runStart = null;
      cellEnds.clear();
    }
    if (!armed) return;
    if (roots.length !== c.count) {
      if (cellError !== 'count') console.warn(`[PCB Collector] expected ${c.count} cell containers, found ${roots.length}; waiting`);
      cellError = 'count';
      return;
    }

    const ids = new Set();
    const serials = new Set();
    const results = [];
    const skippedCells = [];
    let waiting = false;
    for (const [index, root] of roots.entries()) {
      const cellId = c.id_source ? String(readElement(root, c.id_source)).trim() : String(index + 1);
      if (!cellId || ids.has(cellId)) {
        if (cellError !== 'ids') console.error('[PCB Collector] cell IDs must be nonempty and unique');
        cellError = 'ids';
        return;
      }
      ids.add(cellId);
      const rawStatus = norm(read(c.status_selector, c.status_source, root));
      const serialNumber = readSerial(c, root);
      if (skip.has(rawStatus)) {
        skippedCells.push({ cellId, status: 'MALFUNCTION', rawStatus, serialNumber: serialNumber || null });
        continue;
      }
      const status = pass.has(rawStatus) ? 'PASSED' : fail.has(rawStatus) ? 'FAILED' : null;
      if (!status || !serialNumber) {
        waiting = true;
        if (status && !serialNumber && cellError !== `serial:${cellId}`) {
          console.warn(`[PCB Collector] cell ${cellId} verdict without serial; waiting for valid serial`);
          cellError = `serial:${cellId}`;
        }
        continue;
      }
      if (serials.has(serialNumber)) {
        if (cellError !== 'serials') console.error('[PCB Collector] active cells must have different serial numbers; waiting');
        cellError = 'serials';
        return;
      }
      serials.add(serialNumber);
      const key = `${cellId}:${serialNumber}:${status}`;
      if (!cellEnds.has(key)) cellEnds.set(key, new Date().toISOString());
      const endTime = cellEnds.get(key);
      results.push({
        cellId, serialNumber, status, rawStatus, endTime,
        startTime: new Date(runStart).toISOString(),
        cycleTimeMs: Date.parse(endTime) - runStart,
        failedSteps: status === 'FAILED' ? readFailed(c, root) : [],
      });
    }
    if (waiting) return;
    if (profile.completion_mode === 'indicator' && !classify(v) && !completed.has(v)) return;
    armed = false;
    runStart = null;
    if (!results.length) {
      console.info('[PCB Collector] all cells malfunctioning; no board results to upload');
      return;
    }
    const msg = {
      type: 'verdictBatch',
      station: profile.station || document.title,
      stationName: profile.station_name,
      program: profile.program,
      overallStatus: results.some((r) => r.status === 'FAILED') ? 'FAILED' : 'PASSED',
      results, skippedCells, endTime: new Date().toISOString(), url: location.href,
    };
    chrome.runtime.sendMessage(msg).then(
      (r) => r?.ok ? console.info('[PCB Collector] completed cell batch queued', r)
        : console.error('[PCB Collector] batch was not queued', r),
      (e) => console.error('[PCB Collector] could not reach extension worker', e),
    );
  }

  function check() {
    const raw = read(profile.status_selector, profile.status_source);
    if (raw == null) return;
    const v = norm(raw);
    const final = classify(v);
    const serial = readSerial();

    if (v !== lastRaw) {
      lastRaw = v;
      chrome.runtime.sendMessage({ type: 'status', station: profile.station, status: v, normalized: final, serial }).catch(() => {});
    }

    if (profile.cells) { checkCells(v); return; }

    if (!final) {
      armed = true;
      pendingFinal = null;
      if (RUN.has(v)) { if (runStart == null) runStart = Date.now(); }
      else if (!RUN.size) runStart = runStart ?? Date.now();
      return;
    }

    if (!armed) return;
    if (!serial) {
      // verdict shown but serial not rendered yet — retry briefly on the next tick
      pendingFinal = pendingFinal || Date.now();
      if (Date.now() - pendingFinal < 3000) return;
      console.warn('[PCB Collector] verdict without serial number; reporting with UNKNOWN');
    }

    armed = false;
    const msg = {
      type: 'verdict',
      station: profile.station || document.title,
      stationName: profile.station_name,
      program: profile.program,
      status: v,
      normalized: final,
      serial: serial || 'UNKNOWN',
      failedSteps: final === 'FAILED' ? readFailed() : [],
      cycleTimeMs: runStart ? Date.now() - runStart : null,
      startTime: runStart ? new Date(runStart).toISOString() : null,
      endTime: new Date().toISOString(),
      url: location.href,
    };
    runStart = null;
    chrome.runtime.sendMessage(msg).then(
      (r) => console.info(`[PCB Collector] ${final} ${msg.serial} queued`, r),
      (e) => console.error('[PCB Collector] could not reach extension worker', e),
    );
  }

  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; check(); }, 150);
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  // Fallback poll: catches value changes on <input> (not visible to MutationObserver).
  setInterval(check, 1000);
  check();
  console.info(`[PCB Collector] monitoring "${profile.station || profile.id}" on this tab`);
})();
