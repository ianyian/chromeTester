import { validateProfiles } from './profiles.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['tester_id', 'machine_name', 'api_endpoint', 'demo_base_url', 'retry_interval_sec'];
const CHECKS = ['enabled', 'use_native_hostname'];
const send = (type) => chrome.runtime.sendMessage({ type });
const flash = (t) => { $('msg').textContent = t; setTimeout(() => ($('msg').textContent = ''), 3000); };

const MAPPING_FIELDS = [
  ['id', 'Profile ID'], ['url_pattern', 'URL pattern (regular expression)'],
  ['station', 'Station ID'], ['station_name', 'Station name'], ['program', 'Program'],
  ['status_selector', 'Overall status / completion CSS selector'],
  ['status_source', 'Overall status source'],
  ['pass_values', 'Overall PASSED words'], ['fail_values', 'Overall FAILED words'],
  ['running_values', 'Overall running words (required to start a multi-cell cycle)'],
  ['completion_values', 'Additional overall completion words (e.g. COMPLETE)'],
  ['serial_selector', 'Single-board serial CSS selector (unused for multi-cell)'],
  ['serial_source', 'Single-board serial source'], ['serial_regex', 'Single-board serial regex (optional)'],
  ['cells.selector', 'Cell container CSS selector'], ['cells.count', 'Expected number of cells (1-64)'],
  ['cells.id_source', 'Cell ID source on container (blank = position, or attr:data-cell-id)'],
  ['cells.status_selector', 'Cell result CSS selector'], ['cells.status_source', 'Cell result source'],
  ['cells.pass_values', 'Cell PASSED words'], ['cells.fail_values', 'Cell FAILED words'],
  ['cells.skip_values', 'Malfunction / skipped words'],
  ['cells.serial_selector', 'Cell serial CSS selector'], ['cells.serial_source', 'Cell serial source'],
  ['cells.serial_regex', 'Cell serial regex (optional)'], ['cells.failed_selector', 'Cell failed-step CSS selector (optional)'],
];
const modeLabel = document.createElement('label');
modeLabel.className = 'f';
modeLabel.htmlFor = 'mappingMode';
modeLabel.textContent = 'Completion trigger';
const mode = document.createElement('select');
mode.id = 'mappingMode';
for (const [value, text] of [
  ['single', 'Single-board overall PASSED / FAILED'],
  ['cells', 'Multi-cell: all active cells PASSED / FAILED'],
  ['indicator', 'Multi-cell: all active cells finished AND overall indicator complete'],
]) {
  const option = document.createElement('option');
  option.value = value; option.textContent = text; mode.appendChild(option);
}
$('profileFields').append(modeLabel, mode);
for (const [key, label] of MAPPING_FIELDS) {
  const wrapper = document.createElement('div');
  wrapper.dataset.cellField = String(key.startsWith('cells.'));
  const el = document.createElement('input');
  el.type = 'text'; el.id = `mapping-${key}`;
  const title = document.createElement('label');
  title.className = 'f'; title.htmlFor = el.id; title.textContent = label;
  wrapper.append(title, el); $('profileFields').appendChild(wrapper);
}
function showCellFields() {
  document.querySelectorAll('[data-cell-field="true"]').forEach((el) => { el.hidden = mode.value === 'single'; });
}
mode.onchange = showCellFields;

function editedProfiles() {
  const p = JSON.parse($('profiles').value);
  if (!Array.isArray(p)) throw new Error('Profiles must be an array');
  return p;
}
function renderMapping() {
  const p = editedProfiles()[Number($('profileChoice').value)];
  if (!p) return;
  mode.value = p.cells ? p.completion_mode || 'cells' : 'single';
  for (const [key] of MAPPING_FIELDS) {
    const [a, b] = key.split('.');
    const value = b ? p[a]?.[b] : p[a];
    $(`mapping-${key}`).value = Array.isArray(value) ? value.join(', ') : value ?? '';
  }
  showCellFields();
}
function renderChoices() {
  const selected = $('profileChoice').value;
  $('profileChoice').replaceChildren();
  editedProfiles().forEach((p, i) => {
    const option = document.createElement('option');
    option.value = i; option.textContent = p.station || p.id || p.url_pattern;
    $('profileChoice').appendChild(option);
  });
  if (selected && Number(selected) < $('profileChoice').options.length) $('profileChoice').value = selected;
  renderMapping();
}
function validateMappings(p) {
  validateProfiles(p);
  for (const profile of p) {
    for (const mapping of [profile, profile.cells].filter(Boolean)) {
      for (const key of ['selector', 'status_selector', 'serial_selector', 'failed_selector']) {
        if (mapping[key]) document.querySelector(mapping[key]);
      }
    }
  }
}

async function load() {
  const { config: c } = await send('getState');
  for (const f of FIELDS) { $(f).value = c[f] ?? ''; $(f).disabled = c._locked.includes(f); }
  for (const f of CHECKS) { $(f).checked = !!c[f]; $(f).disabled = c._locked.includes(f); }
  document.querySelectorAll('[data-lock]').forEach((el) => { el.textContent = c._locked.includes(el.dataset.lock) ? '🔒 policy' : ''; });
  $('profiles').value = JSON.stringify(c.profiles, null, 2);
  $('profiles').disabled = c._locked.includes('profiles');
  $('saveProfiles').disabled = $('defaultProfiles').disabled = $('profiles').disabled;
  $('saveMapping').disabled = $('addProfile').disabled = $('profileChoice').disabled = $('profiles').disabled;
  $('profileFields').querySelectorAll('input, select').forEach((el) => { el.disabled = $('profiles').disabled; });
  renderChoices();
  $('nativeInfo').textContent = c.use_native_hostname
    ? (c._native?.hostname ? `Native host: hostname = ${c._native.hostname}` : `Native host not available: ${c._native?.error || 'unknown'}`) : '';
  const { _sources, profiles, ...shown } = c;
  $('effective').textContent = JSON.stringify({ ...shown, profiles: `${c.profiles.length} profile(s)` }, null, 2);
}

async function saveLocal(patch) {
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  await chrome.storage.local.set({ localConfig: { ...localConfig, ...patch } });
  const r = await chrome.runtime.sendMessage({ type: 'refreshHostInfo' });
  if (r.error) throw new Error(r.error);
  await load();
}

$('save').onclick = async () => {
  try {
    const patch = {};
    for (const f of FIELDS) if (!$(f).disabled) patch[f] = f === 'retry_interval_sec' ? Number($(f).value) || 30 : $(f).value.trim();
    for (const f of CHECKS) if (!$(f).disabled) patch[f] = $(f).checked;
    if (patch.api_endpoint !== undefined) {
      const url = new URL(patch.api_endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API URL must be HTTP(S), without embedded credentials');
    }
    await saveLocal(patch); flash('Saved.');
  } catch (e) { alert('Could not save settings: ' + e.message); }
};
$('reset').onclick = async () => {
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  await chrome.storage.local.set({ localConfig: localConfig.profiles ? { profiles: localConfig.profiles } : {} });
  await load(); flash('Reset to bundled config.json');
};
$('test').onclick = async () => { const r = await send('testApi'); flash(r.ok ? `API OK (${r.status})` : `API error: ${r.error || r.status}`); };
$('saveProfiles').onclick = async () => {
  try {
    const p = editedProfiles();
    validateMappings(p);
    await saveLocal({ profiles: p }); alert('Profiles saved. Reload tester tabs to apply.');
  } catch (e) { alert('Invalid profiles JSON: ' + e.message); }
};
$('profileChoice').onchange = () => { try { renderMapping(); } catch (e) { alert('Invalid profiles JSON: ' + e.message); } };
$('saveMapping').onclick = async () => {
  try {
    const profiles = editedProfiles();
    const p = profiles[Number($('profileChoice').value)];
    if (!p) throw new Error('Select or add a profile first');
    if (mode.value === 'single') {
      delete p.cells; delete p.completion_mode;
    } else {
      p.cells = { ...p.cells };
      p.completion_mode = mode.value;
    }
    for (const [key] of MAPPING_FIELDS) {
      const [a, b] = key.split('.');
      if (b && !p.cells) continue;
      const target = b ? p[a] : p;
      const name = b || a;
      const value = $(`mapping-${key}`).value.trim();
      if (!value) { delete target[name]; continue; }
      target[name] = name.endsWith('_values') ? value.split(',').map((v) => v.trim())
        : name === 'count' ? Number(value) : value;
    }
    validateMappings(profiles);
    await saveLocal({ profiles });
    alert('Tester settings saved. Reload tester tabs to apply.');
  } catch (e) { alert('Could not save tester settings: ' + e.message); }
};
$('addProfile').onclick = () => {
  try {
    const profiles = editedProfiles();
    const index = profiles.findIndex((p) => p.require_element);
    const insertAt = index < 0 ? profiles.length : index;
    profiles.splice(insertAt, 0, {
      id: 'custom-tester', url_pattern: '^https?://tester-host/', station: 'CUSTOM',
      status_selector: '#overall-result', status_source: 'text',
      serial_selector: '#serial-number', serial_source: 'text',
      pass_values: ['PASSED'], fail_values: ['FAILED'], running_values: ['TESTING'],
    });
    $('profiles').value = JSON.stringify(profiles, null, 2);
    renderChoices();
    $('profileChoice').value = insertAt;
    renderMapping();
  } catch (e) { alert('Invalid profiles JSON: ' + e.message); }
};
$('defaultProfiles').onclick = async () => {
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  delete localConfig.profiles;
  await chrome.storage.local.set({ localConfig }); await load();
};

load();
