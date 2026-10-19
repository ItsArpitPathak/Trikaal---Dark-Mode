// Minimal test runner (no dependencies). Results land in window.__results.
(() => {
  'use strict';
  const tests = [];

  window.test = (name, fn) => tests.push({ name, fn });
  window.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const fmt = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
  window.assert = {
    ok(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${fmt(v)}`); },
    equal(a, b, msg) { if (a !== b) throw new Error(`${msg || 'equal'}: expected ${fmt(b)}, got ${fmt(a)}`); },
    deepEqual(a, b, msg) { if (fmt(a) !== fmt(b)) throw new Error(`${msg || 'deepEqual'}: expected ${fmt(b)}, got ${fmt(a)}`); },
    near(a, b, eps, msg) { if (Math.abs(a - b) > eps) throw new Error(`${msg || 'near'}: expected ${b}±${eps}, got ${a}`); },
    async rejects(p, msg) { try { await p; } catch (e) { return; } throw new Error(msg || 'expected rejection'); },
  };

  // Loads popup.html into an iframe with a mock `chrome` injected before its scripts run.
  window.mountPopup = async function mountPopup(mockChrome) {
    const html = await (await fetch('/popup/popup.html', { cache: 'no-store' })).text();
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:340px;height:420px;border:1px solid #888';
    document.body.appendChild(iframe);
    window.__popupChrome = mockChrome;
    const injected = html.replace(
      '<head>',
      '<head><base href="/popup/"><script>window.chrome = parent.__popupChrome;<\/script>'
    );
    iframe.contentDocument.open();
    iframe.contentDocument.write(injected);
    iframe.contentDocument.close();
    // 'load' can fire before we listen (cached scripts), so poll readyState instead.
    await sleep(20);
    for (let i = 0; i < 100 && iframe.contentDocument.readyState !== 'complete'; i++) await sleep(20);
    await sleep(60); // let init() resolve its async storage/tab reads
    return { iframe, win: iframe.contentWindow, doc: iframe.contentDocument, destroy: () => iframe.remove() };
  };

  // Measures main-thread blocking: pings the event loop through a MessageChannel for
  // `ms` milliseconds and counts gaps longer than `thresholdMs`. Unlike rAF or timers this
  // keeps working when the page is hidden.
  window.blockedTicks = (ms, thresholdMs = 60) => new Promise((resolve) => {
    const ch = new MessageChannel();
    const end = performance.now() + ms;
    let last = performance.now(), blocked = 0, worst = 0;
    ch.port1.onmessage = () => {
      const now = performance.now();
      const gap = now - last;
      if (gap > thresholdMs) blocked++;
      worst = Math.max(worst, gap);
      last = now;
      // Re-post directly (no timers): timers are throttled heavily in hidden tabs.
      if (now < end) ch.port2.postMessage(0); else resolve({ blocked, worst: Math.round(worst) });
    };
    ch.port2.postMessage(0);
  });

  // Cost of one full-document style recalculation on this machine: a baseline to judge
  // our own main-thread blocking against (the browser has to pay it for any style change).
  window.recalcCost = () => {
    const s = document.createElement('style');
    s.textContent = 'html{--tk-probe:' + Math.random() + '}';
    document.head.appendChild(s);
    const t0 = performance.now();
    getComputedStyle(document.body).color;
    document.body.offsetHeight;
    const d = performance.now() - t0;
    s.remove();
    return d;
  };

  // Loads <script> files sequentially.
  window.loadScripts = async (srcs) => {
    for (const src of srcs) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src + (src.includes('?') ? '&' : '?') + 't=' + Date.now(); s.onload = resolve; s.onerror = () => reject(new Error('failed to load ' + src));
        document.head.appendChild(s);
      });
    }
  };

  window.runTests = async () => {
    const results = { passed: 0, failed: 0, failures: [], names: [] };
    for (const t of tests) {
      window.__current = t.name; // handy when a test hangs
      try {
        await t.fn();
        results.passed++;
        results.names.push('PASS ' + t.name);
      } catch (e) {
        results.failed++;
        results.failures.push({ name: t.name, error: String(e && e.message || e) });
        results.names.push('FAIL ' + t.name);
      }
    }
    window.__results = results;
    const out = document.getElementById('out');
    if (out) out.textContent = results.names.join('\n') + `\n\n${results.passed} passed, ${results.failed} failed`;
    return results;
  };
})();
