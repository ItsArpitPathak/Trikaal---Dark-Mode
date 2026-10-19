// Trikaal shared settings module. Loaded by the content script, popup and service
// worker (via importScripts), so it is a classic script that attaches to a global
// `Trikaal.storage` namespace instead of using ES modules.
//
// In memory, settings look like:
//   { defaultMode:   "light"|"forced"|"auto",
//     siteOverrides: { [hostname]: "light"|"forced"|"auto" },
//     excludedSites: [hostname, ...],           // never darken here
//     forcedEngine:  "rewrite"|"filter",
//     forcedAdjust:  { brightness, contrast, sepia } }  // percentages, Dark only
// "forced" is the id of the mode the popup calls "Dark". Older versions also had a native
// "dark" mode; stored "dark" values are read as "forced". A site with no override (or the
// value "default") follows defaultMode. "auto" follows the OS theme (OS dark -> Dark, OS
// light -> Light) and is only offered in the popup's Advanced section.
//
// chrome.storage.sync allows 8 KB per item, so the two lists that can grow live under
// their own keys instead of one big object: nothing a user adds can push another
// setting over the limit.
(() => {
  'use strict';
  const root = globalThis;
  const T = (root.Trikaal = root.Trikaal || {});

  const KEY = 'trikaal';                 // core settings
  const KEY_SITES = 'trikaal.sites';     // per-site overrides
  const KEY_EXCLUDED = 'trikaal.excluded';
  const ALL_KEYS = [KEY, KEY_SITES, KEY_EXCLUDED];

  const MODES = Object.freeze(['light', 'forced']);               // the two main modes
  const SETTABLE = Object.freeze(MODES.concat('auto'));           // allowed stored values
  const ENGINES = Object.freeze(['rewrite', 'filter']);
  const ADJUST_LIMITS = Object.freeze({ brightness: [50, 150], contrast: [50, 150], sepia: [0, 100] });
  const ADJUST_DEFAULTS = Object.freeze({ brightness: 100, contrast: 100, sepia: 0 });
  // chrome.storage.sync limits each item to 8192 bytes (JSON length + key length). Each
  // list gets a byte budget below that, so it can never make a save fail.
  const BUDGET = 7600;

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isMode = (m) => MODES.includes(m);
  const isSettable = (m) => SETTABLE.includes(m);
  const legacy = (m) => (m === 'dark' ? 'forced' : m); // the removed native Dark mode
  const normalizeHost = (h) => String(h == null ? '' : h).trim().toLowerCase();
  const badHost = (h) => !h || h === '__proto__' || h.length > 253;

  function defaults() {
    return {
      defaultMode: 'light',
      siteOverrides: {},
      excludedSites: [],
      forcedEngine: 'rewrite',
      forcedAdjust: Object.assign({}, ADJUST_DEFAULTS),
    };
  }

  function clampNum(v, [lo, hi], fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(Math.min(hi, Math.max(lo, n)));
  }

  // Never trust stored data: coerce anything unexpected back to a valid shape.
  function sanitize(raw) {
    const out = defaults();
    if (!raw || typeof raw !== 'object') return out;
    if (isSettable(legacy(raw.defaultMode))) out.defaultMode = legacy(raw.defaultMode);
    if (ENGINES.includes(raw.forcedEngine)) out.forcedEngine = raw.forcedEngine;
    const adj = raw.forcedAdjust;
    if (adj && typeof adj === 'object') {
      for (const k of Object.keys(ADJUST_LIMITS)) out.forcedAdjust[k] = clampNum(adj[k], ADJUST_LIMITS[k], ADJUST_DEFAULTS[k]);
    }
    const overrides = raw.siteOverrides;
    if (overrides && typeof overrides === 'object') {
      let bytes = 2; // "{}"
      for (const host of Object.keys(overrides)) {
        const h = normalizeHost(host);
        const m = legacy(overrides[host]);
        if (badHost(h) || !isSettable(m)) continue;
        const isNew = !hasOwn(out.siteOverrides, h);
        const cost = isNew ? h.length + m.length + 6 : 0; // "host":"mode",
        if (isNew && bytes + cost > BUDGET) continue; // over budget: keep the entries seen first
        bytes += cost;
        out.siteOverrides[h] = m;
      }
    }
    if (Array.isArray(raw.excludedSites)) {
      const seen = new Set();
      let bytes = 2; // "[]"
      for (const host of raw.excludedSites) {
        const h = normalizeHost(host);
        if (badHost(h) || seen.has(h) || bytes + h.length + 3 > BUDGET) continue;
        bytes += h.length + 3; // "host",
        seen.add(h);
        out.excludedSites.push(h);
      }
    }
    return out;
  }

  // The override for a host, or null when the host follows the default.
  function siteMode(settings, host) {
    const h = normalizeHost(host);
    if (!h || !hasOwn(settings.siteOverrides, h)) return null;
    const m = legacy(settings.siteOverrides[h]);
    return isSettable(m) ? m : null;
  }

  // Override-or-default. May be "auto"; see resolveMode() for the concrete mode.
  function effectiveMode(settings, host) {
    return siteMode(settings, host) || settings.defaultMode;
  }

  // "example.com" excludes example.com and every subdomain of it.
  function isExcluded(settings, host) {
    const h = normalizeHost(host);
    if (!h) return false;
    return settings.excludedSites.some((e) => h === e || h.endsWith('.' + e));
  }

  // The mode to actually apply: "light" | "forced".
  function resolveMode(settings, host, osDark) {
    let m = effectiveMode(settings, host);
    if (m === 'auto') m = osDark ? 'forced' : 'light';
    if (m === 'forced' && isExcluded(settings, host)) m = 'light';
    return m;
  }

  // ---- pure updates: each returns a new settings object ----------------------
  //   scope "all"  -> sets defaultMode
  //   scope "site" -> sets an override; mode "default" removes it
  // Choosing Forced Dark for a site also removes it from the exclusion list, because
  // the user has just asked for exactly that.
  function applyChange(settings, scope, host, mode) {
    mode = legacy(mode);
    const next = sanitize(settings);
    if (scope === 'all') {
      if (isSettable(mode)) next.defaultMode = mode;
      return next;
    }
    const h = normalizeHost(host);
    if (scope !== 'site' || badHost(h)) return next;
    if (mode === 'default') {
      delete next.siteOverrides[h];
    } else if (isSettable(mode)) {
      next.siteOverrides[h] = mode;
      if (mode === 'forced') next.excludedSites = next.excludedSites.filter((e) => e !== h);
    }
    return sanitize(next); // drops the new entry again if the list is already at its byte budget
  }

  function setExcluded(settings, host, excluded) {
    const next = sanitize(settings);
    const h = normalizeHost(host);
    if (badHost(h)) return next;
    const without = next.excludedSites.filter((e) => e !== h);
    next.excludedSites = excluded ? without.concat(h) : without;
    return sanitize(next); // a full list silently refuses the new entry (see BUDGET)
  }

  function setForcedAdjust(settings, partial) {
    const next = sanitize(settings);
    const merged = Object.assign({}, next.forcedAdjust, partial || {});
    return sanitize(Object.assign({}, next, { forcedAdjust: merged }));
  }

  function setForcedEngine(settings, engine) {
    const next = sanitize(settings);
    if (ENGINES.includes(engine)) next.forcedEngine = engine;
    return next;
  }

  // Keyboard shortcut: light -> forced (Dark) -> light, as a per-site override.
  function nextMode(current) {
    const i = MODES.indexOf(current);
    return MODES[(i + 1) % MODES.length]; // unknown/auto (-1) starts at "light"
  }
  // Starts from what the page currently shows (an excluded site shows Light even if the
  // default is Forced; "auto" counts as Light because the OS theme isn't known here).
  // Forced Dark is skipped when it would have no effect: an exact exclusion is lifted by
  // choosing Forced, but one on a parent domain stays, so the cycle would look stuck.
  function cycleMode(settings, host) {
    const h = normalizeHost(host);
    let next = nextMode(resolveMode(settings, host, false));
    const rest = { excludedSites: settings.excludedSites.filter((e) => e !== h) };
    if (next === 'forced' && isExcluded(rest, h)) next = nextMode(next);
    return applyChange(settings, 'site', host, next);
  }

  // ---- early paint guard ------------------------------------------------------
  // Which sites should get the CSS-only "early" content scripts (see content/early-*.css),
  // as chrome.scripting match patterns. They are injected by Chrome before the first
  // paint, so the service worker must register them in advance, from the settings.
  // Only sites that will be darkened get one. "auto" depends on the OS theme, which the service worker cannot see, so it gets none.
  const HOST_OK = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
  // The hostname of an http(s) URL, or null for anything that cannot be themed.
  function hostFromUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
    } catch (e) {
      return null;
    }
  }

  const patternsFor = (host, withSubdomains) => {
    if (!HOST_OK.test(host)) return [];
    return withSubdomains ? [`*://${host}/*`, `*://*.${host}/*`] : [`*://${host}/*`];
  };

  function earlyGroups(settings) {
    const s = sanitize(settings);
    const concrete = (host) => (effectiveMode(s, host) === 'auto' ? null : resolveMode(s, host, false));
    const matches = [];
    const excludeMatches = [];
    if (s.defaultMode === 'forced') {
      matches.push('<all_urls>');
      for (const host of Object.keys(s.siteOverrides)) {
        if (concrete(host) !== 'forced') excludeMatches.push(...patternsFor(host, false));
      }
      for (const host of s.excludedSites) excludeMatches.push(...patternsFor(host, true));
    } else {
      for (const host of Object.keys(s.siteOverrides)) {
        if (concrete(host) === 'forced') matches.push(...patternsFor(host, false));
      }
    }
    return { forced: matches.length ? { matches, excludeMatches } : null };
  }

  const adjustIsDefault = (a) => a.brightness === 100 && a.contrast === 100 && a.sepia === 0;

  // ---- chrome.storage ---------------------------------------------------------
  const split = (s) => {
    const v = sanitize(s);
    return {
      [KEY]: { defaultMode: v.defaultMode, forcedEngine: v.forcedEngine, forcedAdjust: v.forcedAdjust },
      [KEY_SITES]: v.siteOverrides,
      [KEY_EXCLUDED]: v.excludedSites,
    };
  };
  const join = (core, sites, excluded) => sanitize(Object.assign({}, core && typeof core === 'object' ? core : {}, { siteOverrides: sites, excludedSites: excluded }));

  async function load() {
    try {
      const res = await chrome.storage.sync.get(ALL_KEYS);
      return join(res && res[KEY], res && res[KEY_SITES], res && res[KEY_EXCLUDED]);
    } catch (e) {
      return defaults();
    }
  }

  async function save(settings) {
    try {
      await chrome.storage.sync.set(split(settings));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Read-modify-write helper. `settings` is what is now stored (the unchanged previous
  // value if the write failed) and `ok` says whether the write succeeded.
  async function updateChecked(fn) {
    const next = sanitize(fn(await load()));
    const ok = await save(next);
    return { settings: ok ? next : await load(), ok };
  }

  async function update(fn) {
    return (await updateChecked(fn)).settings;
  }

  // True when a chrome.storage.onChanged payload touches Trikaal's keys.
  function changed(changes, area) {
    return area === 'sync' && !!changes && ALL_KEYS.some((k) => hasOwn(changes, k));
  }

  // Folds an onChanged payload into the settings we already hold (the payload only
  // contains the keys that changed). Returns null when the event isn't ours.
  function applyChanges(prev, changes, area) {
    if (!changed(changes, area)) return null;
    const p = sanitize(prev);
    const core = hasOwn(changes, KEY) ? changes[KEY].newValue : { defaultMode: p.defaultMode, forcedEngine: p.forcedEngine, forcedAdjust: p.forcedAdjust };
    const sites = hasOwn(changes, KEY_SITES) ? changes[KEY_SITES].newValue : p.siteOverrides;
    const excluded = hasOwn(changes, KEY_EXCLUDED) ? changes[KEY_EXCLUDED].newValue : p.excludedSites;
    return join(core, sites, excluded);
  }

  T.storage = {
    KEY, KEY_SITES, KEY_EXCLUDED, ALL_KEYS, MODES, SETTABLE, ENGINES, ADJUST_LIMITS, ADJUST_DEFAULTS,
    BUDGET, HOST_OK,
    defaults, sanitize, normalizeHost, hostFromUrl,
    siteMode, effectiveMode, isExcluded, resolveMode,
    applyChange, setExcluded, setForcedAdjust, setForcedEngine, nextMode, cycleMode, adjustIsDefault, earlyGroups,
    load, save, update, updateChecked, changed, applyChanges,
  };
})();
