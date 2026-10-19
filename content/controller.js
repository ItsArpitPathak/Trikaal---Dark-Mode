// Trikaal controller: keeps one page's applied mode in sync with settings.
// Kept separate from content.js (the bootstrap) so it can be unit-tested with a
// fake host, a fake OS-theme source and a fake `apply`.
(() => {
  'use strict';
  const T = (window.Trikaal = window.Trikaal || {});

  // The real OS theme, with change notifications. `os` is injectable for tests.
  function systemTheme() {
    let mq = null;
    try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) { /* no matchMedia */ }
    return {
      isDark: () => !!(mq && mq.matches),
      onChange(cb) {
        if (!mq) return () => {};
        mq.addEventListener('change', cb);
        return () => mq.removeEventListener('change', cb);
      },
    };
  }

  // opts: { host, apply(mode, prevMode), log(...args),
  //         preload(s)?     warms caches after the first settings read (s = those settings)
  //         onSettings(s)?  called with fresh settings before apply() (engine/adjust config)
  //         os?             { isDark(), onChange(cb) } }
  T.createController = function createController(opts) {
    const { host, apply, log } = opts;
    const os = opts.os || systemTheme();
    let mode = null;
    let settings = null;       // null until the first read finishes
    let pending = [];          // live changes that arrived before the first read finished
    let listener = null;
    let unwatchOs = null;

    function set(next) {
      if (next === mode) return;
      const prev = mode;
      mode = next;
      log('mode for', host || '(no host)', '->', next);
      try {
        apply(next, prev);
      } catch (e) {
        log('apply failed', e);
      }
    }

    function refresh() {
      if (!settings) return;
      if (opts.onSettings) {
        try { opts.onSettings(settings); } catch (e) { log('onSettings failed', e); }
      }
      set(T.storage.resolveMode(settings, host, os.isDark()));
    }

    async function start() {
      if (listener) return;
      listener = (changes, area) => {
        if (!T.storage.changed(changes, area)) return;
        if (!settings) { pending.push([changes, area]); return; }
        const next = T.storage.applyChanges(settings, changes, area);
        if (next) { settings = next; refresh(); }
      };
      try {
        chrome.storage.onChanged.addListener(listener);
      } catch (e) {
        log('onChanged unavailable', e);
      }
      // "auto" mode follows the OS, so re-resolve whenever it flips.
      unwatchOs = os.onChange(() => refresh());

      // `preload` (optional) gets the settings just read and may warm caches, so the first
      // apply() already has them. It runs after the read so it can skip work the mode
      // does not need (most pages are Light).
      const loaded = await T.storage.load();
      if (opts.preload) await Promise.resolve(loaded).then(opts.preload).catch(() => {});
      // Changes that raced the initial read are newer than it: replay them on top.
      settings = loaded;
      for (const [c, a] of pending) settings = T.storage.applyChanges(settings, c, a) || settings;
      pending = [];
      refresh();
    }

    function stop() {
      if (listener) {
        try { chrome.storage.onChanged.removeListener(listener); } catch (e) { /* ignore */ }
        listener = null;
      }
      if (unwatchOs) { unwatchOs(); unwatchOs = null; }
    }

    return { start, stop, getMode: () => mode, getSettings: () => settings };
  };
})();
