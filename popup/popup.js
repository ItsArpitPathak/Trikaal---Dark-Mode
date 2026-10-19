// Trikaal popup: pick a mode for this site or for all sites, plus advanced options.
(() => {
  'use strict';
  const T = window.Trikaal;
  const S = T.storage;

  const LABELS = { light: 'Light', forced: 'Dark', auto: 'Auto' };
  const $ = (sel) => document.querySelector(sel);
  const radios = (name) => Array.from(document.querySelectorAll(`input[name="${name}"]`));
  const SLIDERS = ['brightness', 'contrast', 'sepia'];
  const SLIDER_DEBOUNCE_MS = 250; // chrome.storage.sync is rate limited (120 writes/min)

  let settings = S.defaults();
  let host = null;      // null when the tab can't be themed (chrome://, new tab, ...)
  let scope = 'site';   // "site" | "all"
  let pendingAdjust = null;
  let adjustTimer = 0;
  let saveFailed = false;

  async function activeHost() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? S.hostFromUrl(tabs[0].url) : null;
    } catch (e) {
      return null;
    }
  }

  function osIsDark() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  // "https://www.Example.com/a?b" or "example.com" -> "www.example.com"; null if not a host.
  function parseSite(input) {
    let v = String(input || '').trim();
    if (!v) return null;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v);
      v = u.hostname.toLowerCase();
    } catch (e) {
      return null;
    }
    return S.HOST_OK.test(v) ? v : null;
  }

  function renderSliders() {
    for (const key of SLIDERS) {
      const input = $('#' + key);
      const value = pendingAdjust && key in pendingAdjust ? pendingAdjust[key] : settings.forcedAdjust[key];
      if (document.activeElement !== input) input.value = String(value);
      $('#' + key + '-out').textContent = value + '%';
    }
    $('#adjust-reset').disabled = S.adjustIsDefault(settings.forcedAdjust) && !pendingAdjust;
  }

  function renderExcluded() {
    const list = $('#excluded-list');
    list.textContent = '';
    for (const site of settings.excludedSites) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = site;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.setAttribute('aria-label', 'Remove ' + site + ' from the exclusion list');
      btn.addEventListener('click', () => save((s) => S.setExcluded(s, site, false)));
      li.append(name, btn);
      list.appendChild(li);
    }
    $('#excluded-empty').hidden = settings.excludedSites.length > 0;
  }

  function render() {
    $('#host').textContent = host || 'This page can’t be themed';

    for (const r of radios('scope')) {
      r.checked = r.value === scope;
      if (r.value === 'site') r.disabled = !host;
    }

    const override = host ? S.siteMode(settings, host) : null;
    const shown = scope === 'site' && host ? S.effectiveMode(settings, host) : settings.defaultMode;
    for (const r of radios('mode')) {
      r.checked = r.value === shown; // "auto" leaves all three unchecked on purpose
      // Without a themable page only the global default can be changed.
      r.disabled = !host && scope === 'site';
    }
    $('#auto').checked = shown === 'auto';
    $('#auto').disabled = !host && scope === 'site';
    $('#auto-hint').textContent = shown === 'auto'
      ? `Your system theme is ${osIsDark() ? 'dark, so Dark applies' : 'light, so Light applies'}.`
      : 'Dark system theme: Dark. Light system theme: Light.';

    // Exclusion toggle (only for a real site). An entry for a parent domain also
    // covers this host; that one has to be removed from the list below.
    const exact = !!host && settings.excludedSites.includes(host);
    const viaParent = !!host && !exact && S.isExcluded(settings, host);
    $('#exclude-row').hidden = !host;
    $('#exclude').checked = exact || viaParent;
    $('#exclude').disabled = viaParent;

    let note = '';
    if (saveFailed) note = 'Could not save your change (storage unavailable or full).';
    else if (!host) note = 'Showing the default for all sites.';
    else if (scope === 'site') note = override ? 'This site has its own setting.' : `Following the default (${LABELS[settings.defaultMode]}).`;
    else if (override) note = `This site overrides the default with ${LABELS[override]}.`;
    if (!saveFailed && viaParent) note = 'Dark is off here because a parent domain is excluded.';
    else if (!saveFailed && host && $('#exclude').checked && (shown === 'forced' || shown === 'auto')) note = 'Dark is excluded on this site.';
    $('#note').textContent = note;
    $('#note').classList.toggle('error', saveFailed);
    $('#reset').hidden = !(host && override);

    $('#engine').value = settings.forcedEngine;
    renderSliders();
    renderExcluded();
  }

  async function save(fn) {
    const r = await S.updateChecked(fn);
    settings = r.settings;
    saveFailed = !r.ok;
    render();
  }

  function flushAdjust() {
    clearTimeout(adjustTimer);
    adjustTimer = 0;
    if (!pendingAdjust) return Promise.resolve();
    const patch = pendingAdjust;
    pendingAdjust = null;
    return save((s) => S.setForcedAdjust(s, patch));
  }

  function wire() {
    for (const r of radios('scope')) {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        scope = r.value;
        render();
      });
    }
    for (const r of radios('mode')) {
      r.addEventListener('change', () => { if (r.checked) save((s) => S.applyChange(s, scope, host, r.value)); });
    }
    $('#auto').addEventListener('change', (e) => {
      // Unchecking Auto picks Light explicitly; the segmented control then takes over.
      save((s) => S.applyChange(s, scope, host, e.target.checked ? 'auto' : 'light'));
    });
    $('#reset').addEventListener('click', () => save((s) => S.applyChange(s, 'site', host, 'default')));
    $('#exclude').addEventListener('change', (e) => save((s) => S.setExcluded(s, host, e.target.checked)));
    $('#engine').addEventListener('change', (e) => save((s) => S.setForcedEngine(s, e.target.value)));

    for (const key of SLIDERS) {
      const input = $('#' + key);
      input.addEventListener('input', () => {
        pendingAdjust = Object.assign(pendingAdjust || {}, { [key]: Number(input.value) });
        $('#' + key + '-out').textContent = input.value + '%';
        clearTimeout(adjustTimer);
        adjustTimer = setTimeout(flushAdjust, SLIDER_DEBOUNCE_MS);
      });
      // 'change' (release / keyboard commit) writes immediately, using the slider's
      // current value even if no 'input' event preceded it.
      input.addEventListener('change', () => {
        pendingAdjust = Object.assign(pendingAdjust || {}, { [key]: Number(input.value) });
        flushAdjust();
      });
    }
    $('#adjust-reset').addEventListener('click', () => {
      clearTimeout(adjustTimer);
      pendingAdjust = null;
      save((s) => S.setForcedAdjust(s, S.ADJUST_DEFAULTS));
    });

    $('#excluded-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#excluded-input');
      const site = parseSite(input.value);
      if (!site) {
        $('#note').textContent = 'Enter a site like example.com.';
        $('#note').classList.add('error');
        return;
      }
      input.value = '';
      save((s) => S.setExcluded(s, site, true));
    });

    $('#clear-cache').addEventListener('click', async () => {
      let ok = true;
      try { await chrome.storage.local.remove('trikaalDetect'); } catch (e) { ok = false; }
      $('#clear-note').textContent = ok ? 'Forgotten. Sites are re-checked the next time you visit them.' : 'Could not clear the remembered sites.';
    });

    // Stay correct if settings change elsewhere (another popup, the shortcut, ...).
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        const next = S.applyChanges(settings, changes, area);
        if (next) { settings = next; render(); }
      });
    } catch (e) { /* ignore */ }

    // Closing the popup must not lose a slider move that is still debouncing.
    window.addEventListener('pagehide', flushAdjust);
  }

  async function init() {
    host = await activeHost();
    if (!host) scope = 'all';
    settings = await S.load();
    wire();
    render();
  }

  init();
})();
