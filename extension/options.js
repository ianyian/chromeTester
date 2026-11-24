import { DEFAULT_PROFILES } from './profiles.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['tester_id', 'machine_name', 'api_endpoint', 'demo_base_url', 'retry_interval_sec'];
const CHECKS = ['enabled', 'use_native_hostname'];
const send = (type) => chrome.runtime.sendMessage({ type });
const flash = (t) => { $('msg').textContent = t; setTimeout(() => ($('msg').textContent = ''), 3000); };

async function load() {
  const { config: c } = await send('getState');
  for (const f of FIELDS) { $(f).value = c[f] ?? ''; $(f).disabled = c._locked.includes(f); }
  for (const f of CHECKS) { $(f).checked = !!c[f]; $(f).disabled = c._locked.includes(f); }
  document.querySelectorAll('[data-lock]').forEach((el) => { el.textContent = c._locked.includes(el.dataset.lock) ? '🔒 policy' : ''; });
  const custom = c._sources.local.profiles || c._sources.managed.profiles;
  $('profiles').value = JSON.stringify(custom || DEFAULT_PROFILES, null, 2);
  $('profiles').disabled = c._locked.includes('profiles');
  $('saveProfiles').disabled = $('defaultProfiles').disabled = $('profiles').disabled;
  $('nativeInfo').textContent = c.use_native_hostname
    ? (c._native?.hostname ? `Native host: hostname = ${c._native.hostname}` : `Native host not available: ${c._native?.error || 'unknown'}`) : '';
  const { _sources, profiles, ...shown } = c;
  $('effective').textContent = JSON.stringify({ ...shown, profiles: `${c.profiles.length} profile(s)` }, null, 2);
}

async function saveLocal(patch) {
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  await chrome.storage.local.set({ localConfig: { ...localConfig, ...patch } });
  await chrome.runtime.sendMessage({ type: 'refreshHostInfo' });
  await load();
}

$('save').onclick = async () => {
  const patch = {};
  for (const f of FIELDS) if (!$(f).disabled) patch[f] = f === 'retry_interval_sec' ? Number($(f).value) || 30 : $(f).value.trim();
  for (const f of CHECKS) if (!$(f).disabled) patch[f] = $(f).checked;
  await saveLocal(patch); flash('Saved.');
};
$('reset').onclick = async () => {
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  await chrome.storage.local.set({ localConfig: localConfig.profiles ? { profiles: localConfig.profiles } : {} });
  await load(); flash('Reset to bundled config.json');
};
$('test').onclick = async () => { const r = await send('testApi'); flash(r.ok ? `API OK (${r.status})` : `API error: ${r.error || r.status}`); };
$('saveProfiles').onclick = async () => {
  try {
    const p = JSON.parse($('profiles').value);
    if (!Array.isArray(p)) throw new Error('must be an array');
    for (const x of p) { if (!x.url_pattern || !x.status_selector || !x.serial_selector) throw new Error('each profile needs url_pattern, status_selector, serial_selector'); new RegExp(x.url_pattern); }
    await saveLocal({ profiles: p }); alert('Profiles saved. Reload tester tabs to apply.');
  } catch (e) { alert('Invalid profiles JSON: ' + e.message); }
};
$('defaultProfiles').onclick = async () => {
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  delete localConfig.profiles;
  await chrome.storage.local.set({ localConfig }); await load();
};

load();
