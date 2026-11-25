(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const steps = ['Camera capture', 'Image alignment', 'Component presence', 'Solder inspection', 'Label verification', 'Final image review'];
  const cells = [];
  let running = false;
  let aborted = false;
  let sequence = Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function log(text) {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    $('log').appendChild(line);
    while ($('log').children.length > 100) $('log').firstChild.remove();
    $('log').scrollTop = $('log').scrollHeight;
  }
  function status(cell, value) {
    cell.state = value;
    cell.root.dataset.state = value;
    cell.root.querySelector('.cell-status').textContent = value;
  }
  function overall(value, text = value) {
    $('imageOverall').dataset.state = value;
    $('imageOverall').textContent = text;
    $('imageOverall').className = 'verdict ' + ({
      TESTING: 'st-testing', COMPLETE: cells.some((c) => c.state === 'FAILED') ? 'st-fail' : 'st-pass',
    }[value] || 'st-idle');
  }
  for (let i = 1; i <= 8; i++) {
    const root = document.createElement('section');
    root.className = 'image-cell'; root.dataset.cellId = String(i);
    root.innerHTML = `<h2>Cell ${i}</h2><input class="ro cell-serial" aria-label="Cell ${i} serial number">
      <div class="camera"><span>CAM ${i}</span></div><div class="cell-status"></div><div class="cell-step"></div><div class="cell-failure"></div>
      <label class="cell-control"><input class="malfunction" type="checkbox"> Cell malfunction</label>
      <label class="cell-control"><input class="force-fail" type="checkbox"> Force early failure</label>`;
    const cell = { root, state: 'IDLE' };
    const malfunction = root.querySelector('.malfunction');
    malfunction.checked = i === 8;
    root.querySelector('.force-fail').checked = i === 2;
    malfunction.onchange = () => {
      root.querySelector('.cell-serial').disabled = malfunction.checked;
      root.querySelector('.force-fail').disabled = malfunction.checked;
      status(cell, malfunction.checked ? 'MALFUNCTION' : 'IDLE');
    };
    malfunction.onchange();
    cells.push(cell); $('cells').appendChild(root);
  }
  async function testCell(cell, index) {
    const root = cell.root;
    const fail = root.querySelector('.force-fail').checked || Math.random() < Number($('failRate').value) / 100;
    const failAt = root.querySelector('.force-fail').checked ? 1 : Math.floor(Math.random() * steps.length);
    for (let i = 0; i < steps.length; i++) {
      root.querySelector('.cell-step').textContent = `${i + 1}/${steps.length}: ${steps[i]}`;
      await sleep((550 + index * 120) / Number($('speed').value));
      if (aborted) return;
      if (fail && i === failAt) {
        root.querySelector('.cell-failure').textContent = steps[i];
        status(cell, 'FAILED');
        log(`Cell ${index + 1} FAILED; remaining steps terminated`);
        return;
      }
    }
    status(cell, 'PASSED');
    log(`Cell ${index + 1} PASSED`);
  }
  async function runBatch() {
    if (running) return;
    const active = cells.filter((c) => !c.root.querySelector('.malfunction').checked);
    if (!active.length) { overall('IDLE'); $('summary').textContent = 'All cells malfunctioning - no test or upload'; return; }
    const serials = new Set();
    for (const cell of active) {
      const input = cell.root.querySelector('.cell-serial');
      input.value = input.value.trim() || `IMG-${++sequence}`;
      if (serials.has(input.value)) { $('summary').textContent = 'Active cells need different serial numbers'; return; }
      serials.add(input.value);
    }
    running = true; aborted = false;
    $('start').disabled = true; $('abort').disabled = false;
    for (const cell of cells) {
      cell.root.querySelectorAll('input').forEach((el) => { el.disabled = true; });
      cell.root.querySelector('.cell-failure').textContent = '';
      cell.root.querySelector('.cell-step').textContent = '';
      status(cell, active.includes(cell) ? 'TESTING' : 'MALFUNCTION');
    }
    overall('TESTING');
    $('summary').textContent = `${active.length} active / ${8 - active.length} malfunction`;
    log('Batch started; no results uploaded until every active cell finishes');
    try {
      await Promise.all(cells.map((cell, index) => active.includes(cell) ? testCell(cell, index) : Promise.resolve()));
      if (aborted) {
        active.forEach((c) => status(c, 'IDLE'));
        overall('IDLE'); $('summary').textContent = 'Batch aborted - not uploaded';
      } else {
        const failed = active.filter((c) => c.state === 'FAILED').length;
        overall('COMPLETE', failed ? 'FAILED' : 'PASSED');
        $('summary').textContent = `Complete: ${active.length - failed} passed / ${failed} failed / ${8 - active.length} malfunction`;
        log(`Batch COMPLETE - overall ${failed ? 'FAILED' : 'PASSED'}`);
      }
    } catch (e) {
      overall('IDLE');
      $('summary').textContent = 'Tester error - batch not completed';
      console.error('Image tester error', e);
      log(`Tester error: ${e.message}`);
    } finally {
      running = false; $('start').disabled = false; $('abort').disabled = true;
      cells.forEach((cell) => {
        const malfunction = cell.root.querySelector('.malfunction');
        malfunction.disabled = false;
        cell.root.querySelector('.cell-serial').disabled = malfunction.checked;
        cell.root.querySelector('.force-fail').disabled = malfunction.checked;
      });
    }
  }
  $('start').onclick = runBatch;
  $('abort').onclick = () => { aborted = true; };
  $('failRate').oninput = () => { $('failRateOut').textContent = $('failRate').value + '%'; };
  $('speed').oninput = () => { $('speedOut').textContent = $('speed').value + 'x'; };
  async function loop() {
    await sleep(2000);
    while (true) {
      if ($('auto').checked && !running) {
        cells.forEach((c) => { if (!c.root.querySelector('.malfunction').checked) c.root.querySelector('.cell-serial').value = ''; });
        await runBatch();
        await sleep(6000);
      } else await sleep(500);
    }
  }
  loop().catch((e) => { console.error('Image tester auto-cycle stopped', e); log(`Auto-cycle stopped: ${e.message}`); });
})();
