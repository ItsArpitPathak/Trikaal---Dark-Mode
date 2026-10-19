// Trikaal Forced Dark: makes a light page dark when the site has no dark mode.
//
// Engines (same enable()/disable() interface, so switching leaves no residue):
//   filter  - Phase 4: invert the whole page with a CSS filter, re-invert media.
//   rewrite - Phase 6: real color rewriting (content/rewrite.js).
(() => {
  'use strict';
  const T = (window.Trikaal = window.Trikaal || {});

  // ------------------------------------------------------------------ filter engine
  const FILTER_STYLE_ID = 'trikaal-forced-style';
  const KEEP_ATTR = 'data-trikaal-keep'; // marks elements with a CSS background image

  // invert(1) flips lightness; hue-rotate(180deg) puts hues back (so blue stays blue,
  // not orange). contrast(.92) lifts pure black to a soft near-black.
  const PAGE_FILTER = 'invert(1) hue-rotate(180deg) contrast(.92)';
  const MEDIA_FILTER = 'invert(1) hue-rotate(180deg)'; // exact inverse for media

  const FILTER_CSS = `
html { background-color: #fff; }
html { filter: ${PAGE_FILTER} var(--trikaal-adj, ) !important; }
/* Re-invert media so photos, video and embeds keep their natural colors. */
img, picture, video, canvas, iframe, embed, object, svg image, [${KEEP_ATTR}] {
  filter: ${MEDIA_FILTER} !important;
}
/* Anything already inside a re-inverted box must not be inverted a second time. */
picture img, picture source, [${KEEP_ATTR}] :is(img, picture, video, canvas, iframe, embed, object, svg image, [${KEEP_ATTR}]) {
  filter: none !important;
}
`;

  const SCAN_BUDGET_MS = 6; // max main-thread time per animation frame

  function createFilterEngine() {
    let gen = 0;
    let observer = null;
    let scheduled = false;
    let rootGuard = null;
    const queue = new Set();

    const hasBgImage = (el) => {
      try {
        const bi = getComputedStyle(el).backgroundImage;
        return !!bi && bi !== 'none' && bi.indexOf('url(') !== -1;
      } catch (e) {
        return false;
      }
    };

    function check(el) {
      if (el.nodeType !== 1 || el === document.documentElement) return;
      if (hasBgImage(el)) el.setAttribute(KEEP_ATTR, '');
      else if (el.hasAttribute(KEEP_ATTR)) el.removeAttribute(KEEP_ATTR);
    }

    function pump(myGen) {
      scheduled = false;
      if (myGen !== gen) return;
      const start = performance.now();
      for (const el of queue) {
        queue.delete(el);
        check(el);
        if (performance.now() - start > SCAN_BUDGET_MS) break;
      }
      schedule(myGen);
    }

    function schedule(myGen) {
      if (scheduled || !queue.size) return;
      scheduled = true;
      T.util.defer(() => pump(myGen));
    }

    function enqueueTree(node, myGen) {
      if (node.nodeType !== 1) return;
      queue.add(node);
      for (const el of node.querySelectorAll('*')) queue.add(el);
      schedule(myGen);
    }

    function enable() {
      // Only the top frame filters. The top page re-inverts <iframe> elements, so a
      // frame that also filtered itself would be flipped back to light.
      if (!T.forced.isTopFrame()) return;
      const myGen = ++gen;
      T.util.whenRoot((root) => {
        const ensure = () => {
          if (document.getElementById(FILTER_STYLE_ID)) return;
          const style = document.createElement('style');
          style.id = FILTER_STYLE_ID;
          style.textContent = FILTER_CSS;
          root.appendChild(style);
        };
        ensure();
        rootGuard = new MutationObserver(() => { if (!document.getElementById(FILTER_STYLE_ID)) ensure(); });
        rootGuard.observe(root, { childList: true });

        T.util.whenDomReady(() => {
          if (myGen !== gen) return;
          enqueueTree(document.documentElement, myGen);
          observer = new MutationObserver((records) => {
            for (const r of records) {
              if (r.type === 'childList') for (const n of r.addedNodes) enqueueTree(n, myGen);
              else if (r.target.nodeType === 1) { queue.add(r.target); schedule(myGen); }
            }
          });
          observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
          });
        });
      }, () => myGen !== gen);
    }

    function disable() {
      gen++;
      scheduled = false;
      queue.clear();
      if (observer) { observer.disconnect(); observer = null; }
      if (rootGuard) { rootGuard.disconnect(); rootGuard = null; }
      try {
        for (const el of document.querySelectorAll('#' + FILTER_STYLE_ID)) el.remove();
        for (const el of document.querySelectorAll('[' + KEEP_ATTR + ']')) el.removeAttribute(KEEP_ATTR);
      } catch (e) { /* ignore */ }
    }

    // Temporarily turns the page back to its original look (without touching the
    // DOM) so detection can measure real colors. Both calls run synchronously, so
    // nothing is painted in between.
    function suspend() {
      const s = document.getElementById(FILTER_STYLE_ID);
      if (s) s.disabled = true;
    }
    function resume() {
      const s = document.getElementById(FILTER_STYLE_ID);
      if (s) s.disabled = false;
    }
    const supported = () => T.forced.isTopFrame();

    return { enable, disable, suspend, resume, supported };
  }

  // ------------------------------------------------------------------ dispatcher
  // "Forced Dark" is a session: we force tentatively (so a light page never flashes
  // white), then keep checking whether the page is really already dark and drop or
  // restore forcing accordingly. See content/detect.js for how that is decided.
  const engines = { filter: createFilterEngine() };
  let active = null;     // engine in use for this session
  let forcing = false;   // is the engine currently applied?
  let gen = 0;           // session id; stale timers/observers compare against it
  let stopMonitor = null;

  // engine: "rewrite" (real color rewriting, default) or "filter" (invert fallback).
  const config = {
    // minEvalGapMs: pages that toggle attributes constantly (animations, scroll locks)
    // must not make us re-measure (two style recalcs) more than this often.
    debounceMs: 150, settleMs: 500, minEvalGapMs: 600, revealMs: 900, engine: 'rewrite',
    adjust: { brightness: 100, contrast: 100, sepia: 0 }, // percentages, from the sliders
  };
  const ADJUST_ID = 'trikaal-adjust';

  function pickEngine() {
    return (config.engine === 'filter' ? engines.filter : engines.rewrite) || engines.filter;
  }

  // Brightness / contrast / sepia sliders. They only exist as one CSS variable on <html>
  // that both engines feed into their root `filter`, and it is only present while
  // forcing and only when something differs from the neutral 100/100/0.
  function adjustFilter(a) {
    const parts = [];
    if (a.brightness !== 100) parts.push(`brightness(${a.brightness / 100})`);
    if (a.contrast !== 100) parts.push(`contrast(${a.contrast / 100})`);
    if (a.sepia > 0) parts.push(`sepia(${a.sepia / 100})`);
    return parts.join(' ');
  }

  function syncAdjust() {
    try {
      for (const el of document.querySelectorAll('#' + ADJUST_ID)) el.remove();
    } catch (e) { /* ignore */ }
    if (!forcing) return;
    const value = adjustFilter(config.adjust);
    if (!value) return;
    const myGen = gen;
    T.util.whenRoot((root) => {
      if (!forcing || document.getElementById(ADJUST_ID)) return;
      const st = document.createElement('style');
      st.id = ADJUST_ID;
      st.setAttribute('data-trikaal-dyn', 'adjust');
      st.textContent = `html { --trikaal-adj: ${value}; }`;
      root.appendChild(st);
    }, () => myGen !== gen || !forcing);
  }

  function startForcing() {
    if (forcing || !active) return;
    forcing = true;
    active.enable();
    syncAdjust();
  }

  function stopForcing() {
    if (!forcing || !active) return;
    forcing = false;
    active.disable();
    syncAdjust();
  }

  // Applies engine choice and slider values from settings. Switching engines while
  // forcing restarts the session so the new engine takes over cleanly.
  function configure(c) {
    let restart = false;
    if (c && (c.engine === 'rewrite' || c.engine === 'filter') && c.engine !== config.engine) {
      config.engine = c.engine;
      restart = !!active;
    }
    if (c && c.adjust) {
      const a = c.adjust;
      config.adjust = { brightness: +a.brightness || 100, contrast: +a.contrast || 100, sepia: +a.sepia || 0 };
    }
    if (restart) enable();
    else syncAdjust();
  }

  let lastEvalAt = -Infinity;

  // Measures the page as the AUTHOR made it. Two things of ours would otherwise be mistaken
  // for the page's own look: the engine's styles (suspended by the caller) and the early
  // paint guard, which paints <html> dark. The guard is switched off for the duration of the
  // measurement. Everything here is synchronous, so no frame can paint in between.
  function measurePage() {
    const root = document.documentElement;
    const guardWasOff = !root || root.hasAttribute('data-trikaal-off');
    if (!guardWasOff) root.setAttribute('data-trikaal-off', '');
    try {
      return T.detect.measure(document);
    } finally {
      if (!guardWasOff) root.removeAttribute('data-trikaal-off');
    }
  }

  // Measures the page and applies/removes forcing to match.
  function evaluate(myGen) {
    if (myGen !== gen || !active) return;
    lastEvalAt = performance.now();
    let verdict;
    try {
      if (forcing && active.suspend) {
        active.suspend();
        try { verdict = measurePage(); } finally { active.resume(); }
      } else {
        verdict = measurePage();
      }
    } catch (e) {
      return; // detection failure: keep the current state
    }
    T.forced.lastVerdict = verdict;
    if (!verdict.final) return; // <body> not parsed yet; wait for a later trigger
    // Only the top page is remembered: embedded ad/widget hosts would fill the 300-entry cache.
    if (T.forced.isTopFrame()) T.detect.remember(location.hostname, verdict.dark);
    if (verdict.dark) { stopForcing(); T.util.endEarly(); } // already dark: show it as it is
    else startForcing();
  }

  // Re-check at every moment the answer can change.
  function startMonitor(myGen) {
    const cleanups = [];
    let timer = 0;
    const schedule = () => {
      clearTimeout(timer);
      const wait = Math.max(config.debounceMs, lastEvalAt + config.minEvalGapMs - performance.now());
      timer = setTimeout(() => evaluate(myGen), wait);
    };
    cleanups.push(() => clearTimeout(timer));

    // Theme toggles in SPAs usually change attributes on <html>/<body> (class,
    // data-theme, style) or the <meta name="color-scheme"> tag.
    let attrObserver = null;
    function watchAttributes() {
      if (myGen !== gen || attrObserver) return;
      try {
        // Ignore changes that are only our own style elements being added or removed,
        // otherwise theming the page would keep triggering fresh "already dark?" checks.
        const isOurs = (n) => n.nodeType === 1 && (n.hasAttribute('data-trikaal-dyn') || (n.id && n.id.indexOf('trikaal-') === 0));
        attrObserver = new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === 'childList' && Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).every(isOurs)) continue;
            schedule();
            return;
          }
        });
        const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode', 'data-bs-theme', 'dark', 'theme'] };
        attrObserver.observe(document.documentElement, opts);
        if (document.body) attrObserver.observe(document.body, opts);
        if (document.head) attrObserver.observe(document.head, { childList: true, attributes: true, subtree: true, attributeFilter: ['content', 'name'] });
      } catch (e) { /* ignore */ }
    }
    cleanups.push(() => { if (attrObserver) attrObserver.disconnect(); });

    // The background is often unknown at document_start, so also check once the DOM
    // is parsed, after load, and shortly after that for late-applied styles.
    const onReady = () => { evaluate(myGen); watchAttributes(); };
    const onLoad = () => { evaluate(myGen); const t = setTimeout(() => evaluate(myGen), config.settleMs); cleanups.push(() => clearTimeout(t)); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
      cleanups.push(() => document.removeEventListener('DOMContentLoaded', onReady));
    } else {
      onReady();
    }
    if (document.readyState !== 'complete') {
      window.addEventListener('load', onLoad, { once: true });
      cleanups.push(() => window.removeEventListener('load', onLoad));
    } else {
      onLoad();
    }

    // OS theme flips matter for pages declaring `color-scheme: light dark`.
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', schedule);
      cleanups.push(() => mq.removeEventListener('change', schedule));
    } catch (e) { /* ignore */ }

    return () => cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
  }

  // The early paint guard keeps the page hidden on a dark canvas until this is called.
  // Wait for the DOM to be parsed and the engine to have worked through its first queue;
  // a timer covers pages whose parsing or engine run is slow (the guard's own CSS-only
  // timer is the final backstop).
  function scheduleReveal(myGen) {
    const reveal = () => { if (myGen === gen) T.util.endEarly(); };
    if (!forcing) { reveal(); return; }
    T.util.whenDomReady(() => {
      const e = active;
      if (e && e.whenIdle) e.whenIdle().then(reveal);
      else T.util.defer(reveal);
    });
    setTimeout(reveal, config.revealMs);
  }

  function enable() {
    disable();
    const myGen = ++gen;
    active = pickEngine();
    if (active.supported && !active.supported()) { T.util.endEarly(); return; } // e.g. filter engine in iframes
    // Known-dark sites are not forced even for the first paint.
    if (T.detect.cachedVerdict(location.hostname) !== 'dark') startForcing();
    stopMonitor = startMonitor(myGen);
    scheduleReveal(myGen);
  }

  function disable() {
    gen++;
    if (stopMonitor) { stopMonitor(); stopMonitor = null; }
    if (active) { try { active.disable(); } catch (e) { /* ignore */ } }
    active = null;
    forcing = false;
    syncAdjust();
  }

  T.forced = {
    enable, disable, configure, engines, config, KEEP_ATTR, STYLE_ID: FILTER_STYLE_ID, ADJUST_ID,
    isForcing: () => forcing,
    lastVerdict: null,
    evaluateNow: () => evaluate(gen),
    isTopFrame: () => window === window.top, // overridable seam for tests
  };
})();
