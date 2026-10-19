// Trikaal content script bootstrap (runs at document_start in all frames).
// Resolves this page's effective mode and keeps it live as settings change.
(() => {
  'use strict';
  if (window.__trikaalLoaded) return; // guard against double injection
  window.__trikaalLoaded = true;

  const T = window.Trikaal;
  const DEBUG = false; // set to true to log each mode change to the page console
  const log = (...a) => { if (DEBUG) console.log('[Trikaal]', ...a); };

  try {
    const host = T.util.frameHost(window);
    T.createController({
      host,
      log,
      // Only Forced Dark (and Auto, which may become it) reads the remembered-sites cache.
      preload: (s) => (['forced', 'auto'].includes(T.storage.effectiveMode(s, host)) ? T.detect.loadCache() : null),
      // Engine choice and slider values are applied before the mode itself.
      onSettings: (s) => T.forced.configure({ engine: s.forcedEngine, adjust: s.forcedAdjust }),
      apply: (mode) => T.theme.apply(mode),
    }).start();
  } catch (e) {
    log('failed to start', e);
  }
})();
