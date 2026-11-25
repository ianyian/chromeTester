const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = (t) => (t ? new Date(t).toLocaleTimeString() : '');

function render(st) {
  const c = st.config;
  $('testerId').textContent = c.tester_id || '(not set)';
  $('machine').textContent = c.machine_name || '(not set)';
  $('endpoint').textContent = c.api_endpoint;
  $('endpoint').title = c.api_endpoint;
  $('sent').textContent = st.sentCount;
  $('pending').textContent = st.queue.length;
  $('enPill').textContent = c.enabled ? 'ENABLED' : 'DISABLED';
  $('enPill').className = 'pill ' + (c.enabled ? 'ok' : 'ng');

  const tabs = Object.entries(st.tabs).sort((a, b) => Number(a[0]) - Number(b[0]));
  $('tabs').innerHTML = tabs.length ? tabs.map(([id, t]) => `
    <tr><td>#${esc(id)}</td><td>${esc(t.station)}</td><td class="${esc(t.normalized || '')}">${esc(t.status)}</td>
    <td>${esc(t.serial)}</td><td class="${esc(t.lastVerdict || '')}">${esc(t.lastVerdict || '')} ${esc(t.lastSerial || '')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No tester tabs detected. Open the demo testers.</td></tr>';

  $('hist').innerHTML = st.history.length ? st.history.slice(0, 50).map((h) => `
    <tr title="${esc(h.error || (h.results ? h.results.map((r) => `${r.cellId}: ${r.serialNumber} ${r.status}`).join(', ') : ''))}"><td>${time(h.endTime || h.timestamp)}</td><td>${esc(h.station)}</td><td>${esc(h.results ? `${h.results.length} cells (${h.skippedCells.length} malfunction)` : h.serialNumber)}</td>
    <td class="${esc(h.overallStatus || h.status)}">${esc(h.overallStatus || h.status)}</td><td class="${esc(h.state)}">${esc(h.state)}${h.http ? ' ' + h.http : ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">Nothing reported yet.</td></tr>';
}

async function refresh() { render(await send('getState')); }

async function checkApi() {
  const r = await send('testApi');
  $('apiPill').textContent = r.ok ? 'API ONLINE' : 'API OFFLINE';
  $('apiPill').className = 'pill ' + (r.ok ? 'ok' : 'ng');
  $('apiPill').title = r.error || r.body || '';
}

$('openDemo').onclick = () => send('openDemo');
$('dashboard').onclick = async () => {
  const { config } = await send('getState');
  chrome.tabs.create({ url: config.demo_base_url.replace(/\/$/, '') + '/dashboard.html' });
};
$('retry').onclick = async () => { render(await send('flushNow')); checkApi(); };
$('clear').onclick = async () => { await send('clearHistory'); refresh(); };
$('options').onclick = () => chrome.runtime.openOptionsPage();

refresh(); checkApi();
setInterval(refresh, 1000);
setInterval(checkApi, 5000);
