// Small helpers shared by the content-script modules.
(() => {
  'use strict';
  const T = (window.Trikaal = window.Trikaal || {});

  // At document_start <html> may not exist yet in some frames. Calls fn(root) as
  // soon as it does; `isStale()` lets the caller cancel (e.g. mode switched away).
  function whenRoot(fn, isStale) {
    if (document.documentElement) {
      if (!isStale || !isStale()) fn(document.documentElement);
      return;
    }
    const mo = new MutationObserver(() => {
      if (!document.documentElement) return;
      mo.disconnect();
      if (!isStale || !isStale()) fn(document.documentElement);
    });
    mo.observe(document, { childList: true });
  }

  // Runs `fn` once the DOM is parsed (immediately if it already is).
  function whenDomReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  // Runs `fn` in a later task. Unlike requestAnimationFrame or setTimeout this is not
  // paused or throttled in background tabs, and it lets the browser render between
  // slices of work (the same trick as React's scheduler).
  const channel = new MessageChannel();
  const pending = [];
  channel.port1.onmessage = () => { const list = pending.splice(0); for (const fn of list) { try { fn(); } catch (e) { /* ignore */ } } };
  function defer(fn) {
    pending.push(fn);
    channel.port2.postMessage(0);
  }

  // The site a frame belongs to. about:blank / srcdoc frames have no hostname of their
  // own, so they take it from their origin or, failing that, their (same-origin) parent;
  // otherwise per-site settings would not apply inside them.
  function frameHost(win) {
    win = win || window;
    try {
      let w = win;
      for (let i = 0; i < 10; i++) {
        if (w.location.hostname) return w.location.hostname;
        const origin = w.location.origin;
        if (origin && origin !== 'null') {
          const h = new URL(origin).hostname;
          if (h) return h;
        }
        if (w === w.parent) break;
        w = w.parent; // cross-origin parents throw on .location access: handled below
      }
    } catch (e) { /* cross-origin parent or opaque origin */ }
    return '';
  }

  // Ends the early paint guard (content/early-*.css) if this page has one: the guard keeps
  // the page on a dark canvas with the body hidden until Trikaal has made up its mind.
  // Marking <html> switches the guard's rules off. Pages without the guard (Light mode,
  // sites that were not registered) are left completely untouched.
  function endEarly() {
    try {
      const root = document.documentElement;
      if (!root || root.hasAttribute('data-trikaal-off')) return;
      if (getComputedStyle(root).getPropertyValue('--trikaal-early').trim()) root.setAttribute('data-trikaal-off', '');
    } catch (e) { /* ignore */ }
  }

  T.util = { whenRoot, whenDomReady, defer, frameHost, endEarly };
})();
