// Already-dark detection: should Forced Dark leave this page alone?
//
// Forcing a page that is already dark double-darkens it (a dark page turns light
// again), so before forcing we work out what the page really looks like.
//
// measure() decides in this order, the first rule that can answer wins:
//   1. Explicit background: the first opaque background walking UP from <body>
//      (through <html>); semi-transparent layers are composited over white.
//      Its relative luminance below DARK_LUMINANCE means "already dark".
//   2. The element in the middle of the viewport, walked up the same way. Many
//      apps leave <body> transparent and paint a full-height wrapper instead.
//   3. The canvas color implied by `color-scheme` (CSS property or
//      <meta name="color-scheme">): dark-only, or "light dark" while the OS is dark.
//   4. Light-colored body text with nothing else known: the author expects a dark
//      background.
//   5. Otherwise the default white canvas: light.
// Because forcing changes colors, callers must measure with forcing suspended.
(() => {
  'use strict';
  const T = (window.Trikaal = window.Trikaal || {});

  // Relative luminance (0..1) below which a background counts as dark.
  // #121212 ~ 0.006, #3b3b3b ~ 0.044, #777 ~ 0.18, mid-gray #808080 ~ 0.216, #fff = 1.
  const DARK_LUMINANCE = 0.2;
  const LIGHT_TEXT_LUMINANCE = 0.8;
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const OWN_ID = /^trikaal-/;

  // ---------- per-host verdict cache (chrome.storage.local) ----------
  // Lets us skip forcing on a known-dark site from the very first paint instead of
  // flashing an inverted page until the check can run. Never leaves the browser.
  const CACHE_KEY = 'trikaalDetect';
  const CACHE_MAX = 300;
  let memory = Object.create(null); // host -> { dark, t }
  let writeTimer = 0;

  // Valid entries of a stored cache object; anything else is dropped.
  function entries(raw) {
    const out = Object.create(null);
    if (raw && typeof raw === 'object') {
      for (const h of Object.keys(raw)) {
        if (h !== '__proto__' && raw[h] && typeof raw[h].dark === 'boolean') out[h] = { dark: raw[h].dark, t: +raw[h].t || 0 };
      }
    }
    return out;
  }

  async function loadCache() {
    try {
      const res = await chrome.storage.local.get(CACHE_KEY);
      memory = entries(res && res[CACHE_KEY]);
    } catch (e) { /* cache is optional */ }
  }

  function cachedVerdict(host) {
    const e = memory[String(host || '').toLowerCase()];
    return e ? (e.dark ? 'dark' : 'light') : null;
  }

  function remember(host, dark) {
    const h = String(host || '').toLowerCase();
    if (!h || h === '__proto__') return;
    const prev = memory[h];
    if (prev && prev.dark === dark) return;
    memory[h] = { dark, t: Date.now() };
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flushCache, 500);
  }

  // Merges into what is stored now, because other tabs write the same key and this
  // frame may not have loaded the cache at all (Light pages skip it). Newer entry wins.
  async function flushCache() {
    try {
      const res = await chrome.storage.local.get(CACHE_KEY);
      const merged = entries(res && res[CACHE_KEY]);
      for (const h of Object.keys(memory)) if (!merged[h] || memory[h].t >= merged[h].t) merged[h] = memory[h];
      const keys = Object.keys(merged);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => merged[a].t - merged[b].t);
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete merged[k];
      }
      memory = merged;
      await chrome.storage.local.set({ [CACHE_KEY]: Object.assign({}, merged) });
    } catch (e) { /* ignore */ }
  }

  // ---------- measuring ----------
  function safeMatch(win, query) {
    try { return !!win.matchMedia(query).matches; } catch (e) { return false; }
  }

  // Colors of `el` and its ancestors, nearest first, until an opaque one is found.
  function backgroundStack(win, el) {
    const layers = [];
    let opaque = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let c = null;
      try { c = T.color.parse(win.getComputedStyle(n).backgroundColor); } catch (e) { /* ignore */ }
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) { opaque = true; break; }
      }
    }
    return { layers, opaque };
  }

  function composite(layers) {
    let out = WHITE; // an unpainted canvas is white
    for (let i = layers.length - 1; i >= 0; i--) out = T.color.over(layers[i], out);
    return out;
  }

  // Tokens of the page's declared color schemes, from CSS and from the <meta>.
  function declaredSchemes(doc, rootStyle) {
    const tokens = new Set();
    const add = (s) => String(s || '').toLowerCase().split(/[\s,]+/).forEach((t) => { if (t) tokens.add(t); });
    add(rootStyle.colorScheme);
    try {
      const meta = doc.querySelector('meta[name="color-scheme" i]');
      if (meta) add(meta.getAttribute('content'));
    } catch (e) { /* ignore */ }
    return tokens;
  }

  function centerElement(doc, win) {
    try {
      const w = win.innerWidth, h = win.innerHeight;
      if (!w || !h) return null;
      let el = doc.elementFromPoint(w / 2, h / 2);
      while (el && el.id && OWN_ID.test(el.id)) el = el.parentElement;
      return el;
    } catch (e) {
      return null;
    }
  }

  // opts.prefersDark overrides the OS lookup (used by tests).
  // Returns { dark, final, reason, luminance }. `final` is false while <body> does not
  // exist yet: the answer is then only a guess and callers should wait.
  function measure(doc, opts) {
    doc = doc || document;
    opts = opts || {};
    const win = doc.defaultView || window;
    const root = doc.documentElement;
    const body = doc.body;
    if (!root) return { dark: false, final: false, reason: 'no-root', luminance: null };
    const done = (dark, reason, lum) => ({ dark, final: !!body, reason, luminance: lum == null ? null : lum });

    // 1. explicit background from <body> upwards
    const own = backgroundStack(win, body || root);
    if (own.opaque) {
      const lum = T.color.luminance(composite(own.layers));
      return done(lum < DARK_LUMINANCE, 'background', lum);
    }

    // 2. whatever is painted in the middle of the viewport
    if (body) {
      const el = centerElement(doc, win);
      if (el && el !== body && el !== root) {
        const mid = backgroundStack(win, el);
        if (mid.opaque) {
          const lum = T.color.luminance(composite(mid.layers));
          return done(lum < DARK_LUMINANCE, 'content-background', lum);
        }
      }
    }
    // Translucent layers over the default white canvas still say something.
    if (own.layers.length) {
      const lum = T.color.luminance(composite(own.layers));
      if (lum < DARK_LUMINANCE) return done(true, 'translucent-background', lum);
    }

    // 3. canvas color from color-scheme
    let rootStyle;
    try { rootStyle = win.getComputedStyle(root); } catch (e) { return done(false, 'style-error'); }
    const schemes = declaredSchemes(doc, rootStyle);
    const supportsDark = schemes.has('dark');
    const supportsLight = schemes.has('light') || schemes.has('normal') || schemes.size === 0;
    const prefersDark = opts.prefersDark != null ? opts.prefersDark : safeMatch(win, '(prefers-color-scheme: dark)');
    if (supportsDark && (!supportsLight || prefersDark)) return done(true, 'color-scheme');

    // 4. light text implies a dark design whose background we could not see
    if (body) {
      try {
        const text = T.color.parse(win.getComputedStyle(body).color);
        if (text && text.a > 0.5 && T.color.luminance(text) > LIGHT_TEXT_LUMINANCE) return done(true, 'light-text');
      } catch (e) { /* ignore */ }
    }

    // 5. default white canvas
    return done(false, 'default-canvas', 1);
  }

  T.detect = { measure, loadCache, cachedVerdict, remember, flushCache, DARK_LUMINANCE };
})();
