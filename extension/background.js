// Service worker: configuration, profile matching, upload queue with retry.
import { DEFAULT_PROFILES } from './profiles.js';

const NATIVE_HOST = 'com.pcbtester.hostinfo';
const HISTORY_MAX = 200;
const DEFAULTS = {
  tester_id: '',
  machine_name: '',
  api_endpoint: 'http://localhost:3000/api/tester/completed',
  enabled: true,
  use_native_hostname: false,
  retry_interval_sec: 30,
  demo_base_url: 'http://localhost:3000',
  profiles: null,
};

// ------------------------------------------------------------------ config
// Priority (low -> high): built-in defaults < bundled config.json < Options page < Chrome managed policy.
let bundledCache = null;
async function loadBundled() {
  if (bundledCache) return bundledCache;
  try { bundledCache = await (await fetch(chrome.runtime.getURL('config.json'))).json(); }
  catch { bundledCache = {}; }
  return bundledCache;
}
async function loadManaged() {
  try { return (await chrome.storage.managed.get(null)) || {}; } catch { return {}; }
}
async function nativeHostInfo() {
  const cached = (await chrome.storage.session.get('hostInfo')).hostInfo;
  if (cached) return cached;
  try {
    const info = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'hostinfo' });
    await chrome.storage.session.set({ hostInfo: info });
    return info;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

export async function getConfig() {
  const [bundled, managed, { localConfig = {} }] = await Promise.all([
    loadBundled(), loadManaged(), chrome.storage.local.get('localConfig'),
  ]);
  let cfg = { ...DEFAULTS, ...bundled, ...localConfig, ...managed };
  let native = {};
  if (cfg.use_native_hostname) {
    // Native host: Linux hostname + optional /etc/pcb-tester/tester.json.
    // Its file config sits between bundled config.json and the Options page values.
    const info = await nativeHostInfo();
    native = info?.config || {};
    cfg = { ...DEFAULTS, ...bundled, ...native, ...localConfig, ...managed };
    cfg._native = info;
    if (info?.hostname) {
      if (!managed.machine_name && !localConfig.machine_name && !native.machine_name) cfg.machine_name = info.hostname;
      if (!managed.tester_id && !localConfig.tester_id && !native.tester_id) cfg.tester_id = info.hostname.toUpperCase();
    }
  }
  cfg._locked = Object.keys(managed);
  cfg._sources = { bundled, native, local: localConfig, managed };
  if (!Array.isArray(cfg.profiles) || !cfg.profiles.length) cfg.profiles = DEFAULT_PROFILES;
  return cfg;
}

function matchProfile(cfg, url) {
  for (const p of cfg.profiles) {
    try { if (new RegExp(p.url_pattern, 'i').test(url)) return p; } catch { /* bad regex, skip */ }
  }
  return null;
}

// ------------------------------------------------------------------ tab state (for popup)
async function updateTab(tabId, patch) {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  tabs[tabId] = { ...(tabs[tabId] || {}), ...patch, updated: Date.now() };
  await chrome.storage.session.set({ tabs });
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  if (tabs[tabId]) { delete tabs[tabId]; await chrome.storage.session.set({ tabs }); }
});

// ------------------------------------------------------------------ queue / upload
async function pushHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  const i = history.findIndex((h) => h.eventId === entry.eventId);
  if (i >= 0) history[i] = { ...history[i], ...entry }; else history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

async function enqueue(payload) {
  const { queue = [] } = await chrome.storage.local.get('queue');
  queue.push(payload);
  await chrome.storage.local.set({ queue });
  await pushHistory({ ...payload, state: 'pending' });
  await refreshBadge();
}

let flushing = null;
function flush() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  const cfg = await getConfig();
  let { queue = [] } = await chrome.storage.local.get('queue');
  while (queue.length) {
    const item = queue[0];
    let outcome;
    try {
      const res = await fetch(cfg.api_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.ok) outcome = { state: 'sent', http: res.status };
      else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        outcome = { state: 'rejected', http: res.status, error: (await res.text()).slice(0, 300) };
      } else outcome = { state: 'retry', http: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      outcome = { state: 'retry', error: String(e?.message || e) };
    }

    if (outcome.state === 'retry') {
      await pushHistory({ eventId: item.eventId, state: 'pending', error: outcome.error, lastTry: Date.now() });
      break; // keep order; retry on next alarm
    }
    queue = queue.slice(1);
    await chrome.storage.local.set({ queue });
    await pushHistory({ eventId: item.eventId, ...outcome, sentAt: Date.now() });
    if (outcome.state === 'sent') {
      const { sentCount = 0 } = await chrome.storage.local.get('sentCount');
      await chrome.storage.local.set({ sentCount: sentCount + 1 });
    }
  }
  await refreshBadge();
}

async function refreshBadge() {
  const cfg = await getConfig();
  const { queue = [], sentCount = 0 } = await chrome.storage.local.get(['queue', 'sentCount']);
  if (!cfg.enabled) {
    await chrome.action.setBadgeText({ text: 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#777' });
  } else if (queue.length) {
    await chrome.action.setBadgeText({ text: String(queue.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#d32f2f' });
  } else {
    await chrome.action.setBadgeText({ text: sentCount > 999 ? '999+' : String(sentCount || '') });
    await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  }
}

async function scheduleRetry() {
  const cfg = await getConfig();
  const period = Math.max(30, Number(cfg.retry_interval_sec) || 30) / 60;
  await chrome.alarms.create('flush', { periodInMinutes: period });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'flush') flush(); });
chrome.runtime.onInstalled.addListener(() => { scheduleRetry(); refreshBadge(); });
chrome.runtime.onStartup.addListener(() => { scheduleRetry(); flush(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed' || (area === 'local' && changes.localConfig)) { scheduleRetry(); refreshBadge(); }
});

// ------------------------------------------------------------------ messages
const handlers = {
  // content script asks whether this page is a tester program it should watch
  async getProfile(msg, sender) {
    const cfg = await getConfig();
    if (!cfg.enabled) return { profile: null };
    const profile = matchProfile(cfg, msg.url);
    return { profile };
  },

  async status(msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    await updateTab(tabId, { url: sender.tab.url, title: sender.tab.title, station: msg.station, status: msg.status, normalized: msg.normalized, serial: msg.serial });
    return {};
  },

  // content script detected a final verdict (transition into PASSED / FAILED)
  async verdict(msg, sender) {
    const cfg = await getConfig();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    const tabId = sender.tab?.id ?? null;
    const payload = {
      eventId: crypto.randomUUID(),
      testerId: cfg.tester_id || null,
      machineName: cfg.machine_name || null,
      tabId,
      station: msg.station || null,
      stationName: msg.stationName || null,
      program: msg.program || null,
      serialNumber: msg.serial,
      status: msg.normalized,           // PASSED | FAILED
      completed: true,
      rawStatus: msg.status,
      failedSteps: msg.failedSteps || [],
      cycleTimeMs: msg.cycleTimeMs ?? null,
      startTime: msg.startTime || null,
      endTime: msg.endTime || new Date().toISOString(),
      pageUrl: sender.tab?.url || msg.url,
      timestamp: new Date().toISOString(),
    };
    await updateTab(tabId, { lastVerdict: payload.status, lastSerial: payload.serialNumber, lastAt: Date.now() });
    await enqueue(payload);
    flush();
    return { ok: true, eventId: payload.eventId };
  },

  async getState() {
    const cfg = await getConfig();
    const s = await chrome.storage.local.get(['queue', 'history', 'sentCount']);
    const { tabs = {} } = await chrome.storage.session.get('tabs');
    return { config: cfg, queue: s.queue || [], history: s.history || [], sentCount: s.sentCount || 0, tabs };
  },

  async flushNow() { await flush(); return handlers.getState(); },

  async clearHistory() { await chrome.storage.local.set({ history: [], sentCount: 0 }); await refreshBadge(); return {}; },

  async testApi() {
    const cfg = await getConfig();
    try {
      const url = new URL('/api/health', cfg.api_endpoint);
      const res = await fetch(url, { cache: 'no-store' });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  },

  async openDemo() {
    const cfg = await getConfig();
    const base = cfg.demo_base_url.replace(/\/$/, '');
    for (const p of ['ict.html', 'fct.html', 'jtag.html', 'flying-probe.html']) {
      await chrome.tabs.create({ url: `${base}/testers/${p}`, active: false });
    }
    return {};
  },

  async refreshHostInfo() { await chrome.storage.session.remove('hostInfo'); return { config: await getConfig() }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true; // async
});
