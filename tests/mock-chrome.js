// In-memory stand-in for the parts of the `chrome` API Trikaal uses, so the
// extension's logic can be tested in a plain page (no extension install needed).
(() => {
  'use strict';
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  window.createMockChrome = function createMockChrome(opts = {}) {
    const data = {};
    const listeners = new Set();
    const mock = { fail: { get: false, set: false, scripting: false }, delayGet: 0, tabs: opts.tabs || [] };

    const sync = {
      async get(keys) {
        if (mock.fail.get) throw new Error('storage get failed');
        if (mock.delayGet) await new Promise((r) => setTimeout(r, mock.delayGet));
        if (keys == null) return clone(data);
        const out = {};
        let list;
        if (typeof keys === 'string') list = [keys];
        else if (Array.isArray(keys)) list = keys;
        else { Object.assign(out, clone(keys)); list = Object.keys(keys); }
        for (const k of list) if (k in data) out[k] = clone(data[k]);
        return out;
      },
      async set(items) {
        if (mock.fail.set) throw new Error('storage set failed');
        // Real chrome.storage.sync limit: 8192 bytes per item (JSON length + key length).
        if (mock.quota !== false) {
          for (const [k, v] of Object.entries(items)) {
            if (JSON.stringify(v).length + k.length > 8192) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
          }
        }
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
          data[k] = clone(v);
        }
        for (const l of Array.from(listeners)) l(clone(changes), 'sync');
      },
      async clear() { for (const k of Object.keys(data)) delete data[k]; },
    };

    // Separate area (chrome.storage.local) with its own data and no cross-talk.
    const localData = {};
    const local = {
      async get(keys) {
        const out = {};
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(localData);
        for (const k of list) if (k in localData) out[k] = clone(localData[k]);
        return out;
      },
      async set(items) { for (const [k, v] of Object.entries(items)) localData[k] = clone(v); },
      async clear() { for (const k of Object.keys(localData)) delete localData[k]; },
      async remove(keys) { for (const k of [].concat(keys)) delete localData[k]; },
    };
    mock._local = localData;

    mock.storage = {
      sync,
      local,
      onChanged: {
        addListener: (l) => listeners.add(l),
        removeListener: (l) => listeners.delete(l),
        hasListener: (l) => listeners.has(l),
      },
    };
    mock.tabs = { query: async () => opts.tabs || [] };
    // Pieces used by the service worker (keyboard shortcut) tests.
    const commandListeners = [];
    mock.commands = { onCommand: { addListener: (l) => commandListeners.push(l) } };
    mock.badges = [];
    mock.action = {
      setBadgeText: async (d) => { mock.badges.push(d); },
      setBadgeBackgroundColor: async () => {},
    };
    mock._runCommand = (name) => Promise.all(commandListeners.map((l) => l(name)));
    // chrome.scripting dynamic content scripts, with Chrome's real rules: ids are unique,
    // update() only touches the fields it is given, unknown ids reject.
    const scripts = new Map();
    const validPattern = (p) => p === '<all_urls>' || /^(\*|https?|file):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/.test(p);
    const check = (s) => {
      if (!s || typeof s.id !== 'string' || !s.id) throw new Error('Content script must have an id');
      for (const p of [].concat(s.matches || [], s.excludeMatches || [])) if (!validPattern(p)) throw new Error('Invalid match pattern: ' + p);
      if (!(s.js && s.js.length) && !(s.css && s.css.length)) throw new Error('Content script must specify js or css');
    };
    mock.scripting = {
      getRegisteredContentScripts: async () => Array.from(scripts.values()).map(clone),
      registerContentScripts: async (list) => {
        if (mock.fail.scripting) throw new Error('scripting failed');
        for (const s of list) { check(s); if (scripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`); }
        for (const s of list) scripts.set(s.id, clone(s));
      },
      updateContentScripts: async (list) => {
        if (mock.fail.scripting) throw new Error('scripting failed');
        for (const s of list) if (!scripts.has(s.id)) throw new Error(`Nonexistent script ID '${s.id}'`);
        for (const s of list) { const merged = Object.assign(scripts.get(s.id), clone(s)); check(merged); scripts.set(s.id, merged); }
      },
      unregisterContentScripts: async (filter) => {
        if (mock.fail.scripting) throw new Error('scripting failed');
        for (const id of (filter && filter.ids) || Array.from(scripts.keys())) {
          if (!scripts.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
          scripts.delete(id);
        }
      },
    };
    mock._scripts = scripts;
    const startupListeners = [], installListeners = [];
    mock.executed = [];
    mock.scripting.executeScript = async (d) => { if (mock.fail.scripting) throw new Error('scripting failed'); mock.executed.push(clone(Object.assign({}, d, { func: d.func ? d.func.name : undefined }))); return []; };
    mock.runtime = { id: 'mock', getManifest: () => mock._manifest, onInstalled: { addListener: (l) => installListeners.push(l) }, onStartup: { addListener: (l) => startupListeners.push(l) } };
    mock._fireStartup = () => startupListeners.forEach((l) => l());
    mock._fireInstalled = () => installListeners.forEach((l) => l({ reason: 'install' }));
    mock._data = data;
    mock._listenerCount = () => listeners.size;
    // Simulates another browser profile/device changing sync storage.
    mock._emitExternal = (items) => sync.set(items);
    return mock;
  };
})();
