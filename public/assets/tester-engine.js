/* Simulated PCB tester engine.
 *
 * Each tester page supplies a config (steps, timing, board model) and a small `ui`
 * adapter that writes the status / serial into the page's OWN markup. That way every
 * tester page looks like a different vendor's program, and the Chrome extension has to
 * be configured per tester (selectors) instead of relying on one fixed DOM.
 *
 * Life-cycle of one board:  IDLE -> LOADING -> TESTING -> PASSED|FAILED -> (hold) -> UNLOADING -> IDLE
 */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  function storageGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

  // Deterministic RNG so each tester's board artwork stays the same between reloads.
  function seeded(seed) {
    let s = 0; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function fmtVal(v, unit) {
    if (unit === 'bool') return v ? 'OK' : 'NG';
    if (unit === 'hex') return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const a = Math.abs(v);
    const pref = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
    if (a === 0) return '0 ' + unit;
    for (const [m, p] of pref) if (a >= m * 0.9999) return (v / m).toFixed(a / m >= 100 ? 1 : a / m >= 10 ? 2 : 3) + ' ' + p + unit;
    return v.toExponential(2) + ' ' + unit;
  }

  // ------------------------------------------------------------------ PCB drawing
  const COMP_STYLE = {
    U: { w: 70, h: 70, fill: '#1c1c1c', pins: true },
    Q: { w: 22, h: 26, fill: '#202020' },
    R: { w: 26, h: 11, fill: '#3b2a1a' },
    C: { w: 22, h: 12, fill: '#b38b4d' },
    E: { w: 30, h: 30, fill: '#1d3c8f', round: true }, // electrolytic
    D: { w: 24, h: 11, fill: '#333' },
    L: { w: 30, h: 30, fill: '#555' },
    Y: { w: 34, h: 14, fill: '#c0c6cc' },
    J: { w: 60, h: 22, fill: '#e8e8e8' },
    K: { w: 46, h: 34, fill: '#123d8a' },
    T: { w: 12, h: 12, fill: '#d4a017', round: true }, // test point / net
    P: { w: 40, h: 40, fill: '#2b2b2b' },               // power block / board-level
  };

  function buildPcb(svgHost, steps, seed, boardModel) {
    const W = 640, H = 400, rng = seeded(seed);
    const refs = [...new Set(steps.map((s) => s.ref))];
    const NS = 'http://www.w3.org/2000/svg';
    const el = (n, a, parent) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); parent && parent.appendChild(e); return e; };

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
    const defs = el('defs', {}, svg);
    const pat = el('pattern', { id: 'grid' + seed, width: 16, height: 16, patternUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M16 0H0V16', fill: 'none', stroke: 'rgba(255,255,255,.035)', 'stroke-width': 1 }, pat);

    el('rect', { x: 4, y: 4, width: W - 8, height: H - 8, rx: 14, fill: '#0e5a32', stroke: '#c9a227', 'stroke-width': 3 }, svg);
    el('rect', { x: 4, y: 4, width: W - 8, height: H - 8, rx: 14, fill: `url(#grid${seed})` }, svg);
    for (const [x, y] of [[22, 22], [W - 22, 22], [22, H - 22], [W - 22, H - 22]]) {
      el('circle', { cx: x, cy: y, r: 9, fill: '#d6b14a' }, svg); el('circle', { cx: x, cy: y, r: 4.5, fill: '#0b0f12' }, svg);
    }
    const txt = el('text', { x: W - 40, y: H - 16, 'text-anchor': 'end', fill: '#e9f5ec', 'font-family': 'monospace', 'font-size': 11, opacity: .8 }, svg);
    txt.textContent = boardModel + '  REV C';

    // place components on a jittered grid
    const cols = Math.ceil(Math.sqrt(refs.length * 1.6));
    const rows = Math.ceil(refs.length / cols);
    const cellW = (W - 80) / cols, cellH = (H - 80) / rows;
    const pos = {};
    const order = refs.map((r) => [r, rng()]).sort((a, b) => a[1] - b[1]).map((a) => a[0]);
    order.forEach((ref, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const st = COMP_STYLE[ref[0]] || COMP_STYLE.T;
      const cx = 40 + cellW * (c + .5) + (rng() - .5) * cellW * .3;
      const cy = 40 + cellH * (r + .5) + (rng() - .5) * cellH * .3;
      pos[ref] = { cx, cy, st };
    });

    // traces between neighbours (orthogonal routing)
    const traces = el('g', { stroke: '#d8b448', 'stroke-width': 1.6, fill: 'none', opacity: .55 }, svg);
    order.forEach((ref, i) => {
      for (const j of [i + 1, i + cols]) {
        const other = order[j]; if (!other || rng() < .25) continue;
        const a = pos[ref], b = pos[other];
        const mx = rng() < .5 ? `H${b.cx}V${b.cy}` : `V${b.cy}H${b.cx}`;
        el('path', { d: `M${a.cx} ${a.cy}${mx}` }, traces);
        el('circle', { cx: b.cx, cy: a.cy, r: 2.2, fill: '#d8b448', stroke: 'none' }, traces);
      }
    });

    const comps = {};
    const cg = el('g', {}, svg);
    order.forEach((ref) => {
      const { cx, cy, st } = pos[ref];
      const g = el('g', {}, cg);
      let shape;
      if (st.round) shape = el('circle', { cx, cy, r: st.w / 2, fill: st.fill, stroke: '#9aa', 'stroke-width': 1, class: 'pcb-comp' }, g);
      else shape = el('rect', { x: cx - st.w / 2, y: cy - st.h / 2, width: st.w, height: st.h, rx: 2, fill: st.fill, stroke: '#9aa', 'stroke-width': 1, class: 'pcb-comp' }, g);
      if (st.pins) {
        for (let k = 0; k < 8; k++) {
          const o = -st.w / 2 + 6 + k * ((st.w - 12) / 7);
          el('rect', { x: cx + o - 1.5, y: cy - st.h / 2 - 5, width: 3, height: 5, fill: '#bbb' }, g);
          el('rect', { x: cx + o - 1.5, y: cy + st.h / 2, width: 3, height: 5, fill: '#bbb' }, g);
          el('rect', { x: cx - st.w / 2 - 5, y: cy + o - 1.5, width: 5, height: 3, fill: '#bbb' }, g);
          el('rect', { x: cx + st.w / 2, y: cy + o - 1.5, width: 5, height: 3, fill: '#bbb' }, g);
        }
        el('circle', { cx: cx - st.w / 2 + 8, cy: cy - st.h / 2 + 8, r: 2.5, fill: '#555' }, g);
      } else if (!st.round) {
        el('rect', { x: cx - st.w / 2 - 3, y: cy - st.h / 2 + 1, width: 4, height: st.h - 2, fill: '#cfcfcf' }, g);
        el('rect', { x: cx + st.w / 2 - 1, y: cy - st.h / 2 + 1, width: 4, height: st.h - 2, fill: '#cfcfcf' }, g);
      }
      const t = el('text', { x: cx, y: cy - st.h / 2 - (st.pins ? 9 : 4), 'text-anchor': 'middle', fill: '#f2f2f2', 'font-family': 'monospace', 'font-size': 9 }, g);
      t.textContent = ref;
      comps[ref] = { shape, cx, cy };
    });

    // probe crosshair
    const probe = el('g', { class: 'probe', transform: `translate(${W / 2},${-30})` }, svg);
    el('circle', { r: 11, fill: 'none', stroke: '#ff5252', 'stroke-width': 2 }, probe);
    el('path', { d: 'M-17 0H-5M5 0H17M0 -17V-5M0 5V17', stroke: '#ff5252', 'stroke-width': 2 }, probe);
    el('circle', { r: 2, fill: '#ff5252' }, probe);

    svgHost.innerHTML = '';
    svgHost.appendChild(svg);

    return {
      reset() { for (const c of Object.values(comps)) c.shape.classList.remove('testing', 'pass', 'fail'); probe.setAttribute('transform', `translate(${W / 2},-30)`); },
      probe(ref) {
        const c = comps[ref]; if (!c) return;
        for (const o of Object.values(comps)) o.shape.classList.remove('testing');
        c.shape.classList.add('testing');
        probe.setAttribute('transform', `translate(${c.cx},${c.cy})`);
      },
      mark(ref, ok) {
        const c = comps[ref]; if (!c) return;
        c.shape.classList.remove('testing');
        if (!ok) { c.shape.classList.remove('pass'); c.shape.classList.add('fail'); }
        else if (!c.shape.classList.contains('fail')) c.shape.classList.add('pass');
      },
      park() { probe.setAttribute('transform', `translate(${W / 2},-30)`); for (const o of Object.values(comps)) o.shape.classList.remove('testing'); },
    };
  }

  // ------------------------------------------------------------------ engine
  function TesterEngine(cfg) {
    const $ = (s) => document.querySelector(s);
    const m = cfg.mount;
    const statsKey = 'tester-stats:' + cfg.testerId;
    const state = {
      status: 'IDLE', auto: true, running: false, abort: false,
      failRate: cfg.failRate ?? 0.2, speed: 1,
      stats: storageGet(statsKey) || { total: 0, pass: 0, fail: 0, lastCycle: 0 },
      seq: (storageGet(statsKey + ':seq') || Math.floor(rand(1000, 9000))),
    };

    const pcb = buildPcb($(m.pcb), cfg.steps, cfg.testerId, cfg.boardModel);
    const logEl = $(m.log);

    function log(msg, cls = '') {
      const d = new Date();
      const line = document.createElement('div');
      line.innerHTML = `<span class="t">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}</span> <span class="${cls}"></span>`;
      line.lastChild.textContent = msg;
      logEl.appendChild(line);
      while (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(st, info = {}) {
      state.status = st;
      cfg.ui.setStatus(st, info);
    }

    function renderStats() {
      const s = state.stats;
      const y = s.total ? ((s.pass / s.total) * 100).toFixed(1) + '%' : '--';
      $(m.stats).innerHTML = `
        <div class="stat"><b>${s.total}</b><small>Tested</small></div>
        <div class="stat ok"><b>${s.pass}</b><small>Pass</small></div>
        <div class="stat ng"><b>${s.fail}</b><small>Fail</small></div>
        <div class="stat y"><b>${y}</b><small>Yield</small></div>`;
      if (m.cycle) $(m.cycle).textContent = s.lastCycle ? (s.lastCycle / 1000).toFixed(1) + ' s' : '--';
    }

    function progress(done, total) {
      const pct = total ? Math.round((done / total) * 100) : 0;
      const p = $(m.progress);
      p.querySelector('i').style.width = pct + '%';
      p.querySelector('span').textContent = `${done}/${total}  ${pct}%`;
    }

    function renderSteps() {
      const tb = $(m.steps);
      tb.innerHTML = '';
      cfg.steps.forEach((s, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${pad(i + 1, 3)}</td><td></td><td></td><td class="num"></td><td class="num"></td><td class="num"></td><td></td>`;
        tr.children[1].textContent = s.name;
        tr.children[2].textContent = s.ref;
        tr.children[3].textContent = s.unit === 'bool' ? '-' : fmtVal(s.lo, s.unit);
        tr.children[5].textContent = s.unit === 'bool' ? '-' : fmtVal(s.hi, s.unit);
        tb.appendChild(tr);
      });
    }

    function nextSerial() {
      state.seq += 1; storageSet(statsKey + ':seq', state.seq);
      const d = new Date();
      const yy = String(d.getFullYear()).slice(2);
      const wk = pad(Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 864e5 + 1) / 7));
      return `${cfg.serialPrefix}-${yy}${wk}-${pad(state.seq % 1000000, 6)}`;
    }

    function measure(s, makeFail) {
      if (s.unit === 'bool' || s.unit === 'hex') return { value: makeFail ? 0 : 1, ok: !makeFail };
      const nominal = s.nominal ?? (s.lo + s.hi) / 2;
      const span = (s.hi - s.lo) / 2;
      let v;
      if (makeFail) {
        const dir = Math.random() < .5 ? -1 : 1;
        v = dir < 0 ? s.lo - span * rand(.1, .8) : s.hi + span * rand(.1, 1.5);
        if (s.lo === 0 && dir < 0) v = s.hi + span * rand(.2, 2);
      } else {
        v = nominal + gauss() * span * 0.22;
        v = Math.min(s.hi - span * 0.02, Math.max(s.lo + span * 0.02, v));
      }
      return { value: v, ok: v >= s.lo && v <= s.hi };
    }

    async function wait(ms) {
      const end = Date.now() + ms / state.speed;
      while (Date.now() < end) { if (state.abort) throw new Error('aborted'); await sleep(Math.min(100, end - Date.now())); }
    }

    async function runBoard() {
      if (state.running) return;
      state.running = true; state.abort = false;
      const t = cfg.timing;
      const rows = $(m.steps).children;
      try {
        // ---- LOADING
        pcb.reset(); renderSteps(); progress(0, cfg.steps.length);
        cfg.ui.setSerial('');
        setStatus('LOADING');
        log('Fixture closing, vacuum ON ...', 'i');
        await wait(t.load * .5);
        const serial = nextSerial();
        cfg.ui.setSerial(serial);
        log(`Barcode scanned: ${serial}`, 'i');
        await wait(t.load * .5);

        // decide failures for this board
        const willFail = Math.random() < state.failRate;
        const failIdx = new Set();
        if (willFail) {
          const n = Math.random() < .7 ? 1 : 2;
          while (failIdx.size < n) failIdx.add(Math.floor(rand(0, cfg.steps.length)));
        }

        // ---- TESTING
        const started = Date.now();
        setStatus('TESTING', { serial });
        log(`Program ${cfg.program} started on ${serial}`, 'i');
        const failedSteps = [];
        let done = 0;
        for (let i = 0; i < cfg.steps.length; i++) {
          const s = cfg.steps[i];
          const tr = rows[i];
          tr.classList.add('running');
          tr.scrollIntoView({ block: 'nearest' });
          pcb.probe(s.ref);
          await wait(rand(t.stepMin, t.stepMax));
          const r = measure(s, failIdx.has(i));
          tr.classList.remove('running');
          tr.children[4].textContent = fmtVal(r.value, s.unit);
          tr.children[6].textContent = r.ok ? 'PASS' : 'FAIL';
          tr.children[6].className = r.ok ? 'r-pass' : 'r-fail';
          if (!r.ok) { tr.classList.add('fail'); failedSteps.push(`${s.name} (${s.ref})`); log(`FAIL  ${s.name} ${s.ref} = ${fmtVal(r.value, s.unit)}`, 'e'); }
          pcb.mark(s.ref, r.ok);
          done++; progress(done, cfg.steps.length);
          setStatus('TESTING', { serial, step: s.name, done, total: cfg.steps.length });
          if (!r.ok && cfg.stopOnFail) { log('Stop-on-fail enabled: aborting remaining steps', 'w'); break; }
        }
        pcb.park();

        // ---- VERDICT
        const cycle = Date.now() - started;
        const ok = failedSteps.length === 0;
        state.stats.total++; ok ? state.stats.pass++ : state.stats.fail++;
        state.stats.lastCycle = cycle; storageSet(statsKey, state.stats); renderStats();
        setStatus(ok ? 'PASSED' : 'FAILED', { serial, failedSteps, cycle });
        log(`RESULT ${ok ? 'PASSED' : 'FAILED'}  ${serial}  cycle=${(cycle / 1000).toFixed(1)}s`, ok ? '' : 'e');
        await wait(t.hold);

        // ---- UNLOAD
        setStatus('UNLOADING');
        log('Fixture opening, board ejected', 'i');
        await wait(t.unload);
        setStatus('IDLE');
        cfg.ui.setSerial('');
      } catch (e) {
        if (e.message !== 'aborted') throw e;
        pcb.park(); setStatus('IDLE'); log('Test aborted by operator', 'w');
      } finally {
        state.running = false;
      }
    }

    async function loop() {
      while (true) {
        if (state.auto && !state.running) {
          await runBoard();
          await sleep(cfg.timing.idle / state.speed);
        } else await sleep(250);
      }
    }

    // ---- wiring standard controls (optional elements)
    const bind = (sel, ev, fn) => { const e = sel && $(sel); if (e) e.addEventListener(ev, fn); return e; };
    bind(m.btnStart, 'click', () => runBoard());
    bind(m.btnAbort, 'click', () => { state.abort = true; });
    const autoEl = bind(m.chkAuto, 'change', (e) => { state.auto = e.target.checked; log(`Auto cycle ${state.auto ? 'ON' : 'OFF'}`, 'w'); });
    if (autoEl) autoEl.checked = state.auto;
    const frEl = bind(m.failRate, 'input', (e) => { state.failRate = e.target.value / 100; if (m.failRateOut) $(m.failRateOut).textContent = e.target.value + '%'; });
    if (frEl) { frEl.value = Math.round(state.failRate * 100); if (m.failRateOut) $(m.failRateOut).textContent = frEl.value + '%'; }
    const spEl = bind(m.speed, 'input', (e) => { state.speed = Number(e.target.value); if (m.speedOut) $(m.speedOut).textContent = state.speed + 'x'; });
    if (spEl) { spEl.value = state.speed; if (m.speedOut) $(m.speedOut).textContent = state.speed + 'x'; }
    bind(m.btnReset, 'click', () => { state.stats = { total: 0, pass: 0, fail: 0, lastCycle: 0 }; storageSet(statsKey, state.stats); renderStats(); log('Counters reset', 'w'); });

    if (m.clock) setInterval(() => { const d = new Date(); $(m.clock).textContent = d.toLocaleDateString() + ' ' + d.toLocaleTimeString(); }, 1000);

    renderSteps(); renderStats(); progress(0, cfg.steps.length);
    setStatus('IDLE'); cfg.ui.setSerial('');
    log(`${cfg.testerName} ready. Program ${cfg.program} loaded (${cfg.steps.length} steps).`, 'i');
    setTimeout(loop, 800 + Math.random() * 1500); // stagger tabs

    return { state, runBoard, log };
  }

  window.TesterEngine = TesterEngine;
})();
