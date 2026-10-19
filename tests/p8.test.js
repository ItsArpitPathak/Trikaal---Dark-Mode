// Phase 8: release checks, throttling, frames, CSP fallback and extra robustness scenarios.
window.__suitePending = (async () => {
  await loadScripts(['/shared/storage.js', '/content/util.js', '/content/color.js', '/content/detect.js', '/content/forced-dark.js', '/content/rewrite.js', '/content/theme.js', '/content/controller.js']);
  const T = Trikaal, S = T.storage, C = T.color, F = T.forced;
  const engine = F.engines.rewrite;
  const get = async (path) => { const r = await fetch(path, { cache: 'no-store' }); assert.equal(r.status, 200, path); return r.text(); };
  const fresh = () => (window.chrome = createMockChrome());
  const residue = () => document.querySelectorAll('#trikaal-rw-base, [data-trikaal-dyn], [data-trikaal-i], #trikaal-forced-style, #trikaal-style, #trikaal-adjust, [data-trikaal-keep], [data-trikaal-scheme]').length;
  const lum = (el) => C.luminance(C.parse(getComputedStyle(el).backgroundColor));
  const cleanup = () => { engine.disable(); F.disable(); T.theme.teardown(); F.isTopFrame = () => true; F.config.engine = 'rewrite'; F.config.debounceMs = 25; F.config.minEvalGapMs = 0; F.config.settleMs = 60; document.body.style.cssText = ''; document.querySelectorAll('[data-p8]').forEach((e) => e.remove()); };
  const add = (html) => { const d = document.createElement('div'); d.dataset.p8 = '1'; d.innerHTML = html; document.body.appendChild(d); return d; };

  // ===================================================== release artefacts
  test('docs: TESTING.md covers every required scenario', async () => {
    const t = (await get('/TESTING.md')).toLowerCase();
    for (const topic of ['text-heavy', 'web apps', 'image-heavy', 'already-dark', 'pdf', 'chrome://', 'flash of white', 'persistence', 'restart', 'prefers-color-scheme', 'devtools', 'profil']) {
      assert.ok(t.includes(topic), 'TESTING.md should mention: ' + topic);
    }
    assert.ok((t.match(/- \[ \]/g) || []).length >= 40, 'a real checklist, not a stub');
    assert.ok(t.includes('all.html'), 'explains how to run the automated suite');
    for (const s of ['run-headless.py', 'e2e-headless.py', 'extensions.loadunpacked', 'flash', 'strict csp', 'restart']) assert.ok(t.includes(s), 'TESTING.md should mention: ' + s);
  });
  test('docs: PRIVACY.md states no collection / no transmission and lists what is stored', async () => {
    const t = (await get('/PRIVACY.md')).toLowerCase();
    for (const s of ['does not collect', 'transmit', 'no network requests', 'chrome.storage.sync', 'chrome.storage.local', 'forget remembered sites', 'no analytics', 'eval', '<all_urls>', 'scripting', 'white flash']) assert.ok(t.includes(s), 'PRIVACY.md should mention: ' + s);
  });
  test('docs: README has load-unpacked instructions, modes, shortcut and limitations', async () => {
    const t = (await get('/README.md')).toLowerCase();
    for (const s of ['load unpacked', 'developer mode', 'two modes', 'alt+shift+d', 'known limitations', 'privacy.md', 'testing.md', 'packaging.md', 'no white flash', 'early-forced.css', '`scripting`', 'data-trikaal-off']) assert.ok(t.includes(s), 'README should mention: ' + s);
  });
  test('docs: PACKAGING.md has zip contents, listing text, justifications and screenshot plan', async () => {
    const t = (await get('/PACKAGING.md')).toLowerCase();
    for (const s of ['manifest.json', 'dist/trikaal-', 'summary', 'detailed description', 'permission justifications', 'screenshot', '1280', 'privacy policy', 'single purpose', '`scripting`', 'e2e-headless.py']) assert.ok(t.includes(s), 'PACKAGING.md should mention: ' + s);
    const summary = (await get('/PACKAGING.md')).match(/\*\*Summary[^\n]*\n\n?([^\n]+)/);
    assert.ok(summary && summary[1].length <= 132, 'store summary must be <= 132 chars: ' + (summary && summary[1].length));
  });
  test('packaging scripts exist, ship only the extension folders, and use forward-slash zip entries', async () => {
    const ps = await get('/scripts/package.ps1'), sh = await get('/scripts/package.sh');
    for (const s of ['manifest.json', 'background', 'content', 'popup', 'shared', 'icons']) assert.ok(ps.includes(`'${s}'`) && sh.includes(s), s);
    assert.ok(!/tests|\.claude/.test(ps.replace(/#[^\n]*/g, '')), 'tests are never packaged');
    assert.ok(ps.includes(".Replace('\\', '/')"), 'forward slashes');
  });
  test('release flags: logging off, version 1.0.0, about:blank/srcdoc frames covered', async () => {
    assert.ok(/const DEBUG = false;/.test(await get('/content/content.js')), 'DEBUG must be false in release');
    const m = JSON.parse(await get('/manifest.json'));
    assert.equal(m.version, '1.0.0');
    const iso = m.content_scripts.find((c) => !c.world);
    assert.equal(iso.match_about_blank, true);
    assert.equal(iso.match_origin_as_fallback, true);
  });
  test('shipped files stay small (no accidental bundling of test data)', async () => {
    let total = 0;
    for (const f of ['manifest.json', 'shared/storage.js', 'content/util.js', 'content/color.js', 'content/detect.js', 'content/forced-dark.js', 'content/rewrite.js', 'content/theme.js', 'content/controller.js', 'content/content.js', 'content/main-world.js', 'background/service-worker.js', 'popup/popup.html', 'popup/popup.css', 'popup/popup.js']) total += (await get('/' + f)).length;
    assert.ok(total < 150000, 'source size ' + total);
  });

  // ===================================================== frame host
  test('frameHost: normal pages use their hostname', () => {
    assert.equal(T.util.frameHost({ location: { hostname: 'a.com', origin: 'https://a.com' }, parent: null }), 'a.com');
  });
  test('frameHost: about:blank/srcdoc fall back to origin, then to the parent', () => {
    const parent = { location: { hostname: 'site.org', origin: 'https://site.org' } };
    parent.parent = parent;
    const blank = { location: { hostname: '', origin: 'null' }, parent };
    assert.equal(T.util.frameHost(blank), 'site.org');
    const blob = { location: { hostname: '', origin: 'https://blob-origin.net' }, parent };
    assert.equal(T.util.frameHost(blob), 'blob-origin.net');
    const deep = { location: { hostname: '', origin: 'null' }, parent: blank };
    assert.equal(T.util.frameHost(deep), 'site.org');
  });
  test('frameHost: cross-origin parents and opaque origins yield "" without throwing', () => {
    const throwing = { get location() { throw new DOMException('blocked', 'SecurityError'); } };
    const blank = { location: { hostname: '', origin: 'null' }, parent: throwing };
    assert.equal(T.util.frameHost(blank), '');
    const top = { location: { hostname: '', origin: 'null' } }; top.parent = top;
    assert.equal(T.util.frameHost(top), '');
    assert.equal(T.util.frameHost(), location.hostname);
  });
  test('frameHost: a real srcdoc iframe resolves to the embedding page host', async () => {
    const f = document.createElement('iframe');
    f.srcdoc = '<p>x</p>'; f.dataset.p8 = '1';
    document.body.appendChild(f);
    for (let i = 0; i < 100 && !f.contentDocument.body; i++) await sleep(20);
    await sleep(50);
    assert.equal(T.util.frameHost(f.contentWindow), location.hostname);
    f.remove();
  });

  // ===================================================== throttling
  test('churn: an element toggling a class 40x/second is not re-read 40 times, and still ends correct', async () => {
    cleanup();
    const box = add('<div id="churn" class="a" style="padding:2px">animated</div><style>.a{background:#fff}.b{background:#eee}.c{background:#ddd}</style>');
    engine.enable(); await engine.whenIdle(); await sleep(50); await engine.whenIdle();
    const el = box.querySelector('#churn');
    const before = engine.stats.elements;
    // Yield through the (unthrottled) task queue so every change lands inside one 1 s window,
    // whatever the timer resolution of the machine or a hidden tab.
    const tick = () => new Promise((r) => T.util.defer(r));
    for (let i = 0; i < 40; i++) { el.className = i % 2 ? 'b' : 'a'; await tick(); await tick(); }
    el.className = 'c';
    await sleep(1300); await engine.whenIdle();
    const processed = engine.stats.elements - before;
    assert.ok(processed <= 12, `processed ${processed} times for 41 changes`);
    assert.ok(processed >= 2, 'still re-checked at the end of the storm');
    assert.ok(lum(el) < 0.1, 'final state is themed: ' + getComputedStyle(el).backgroundColor);
    cleanup();
  });
  test('churn: ordinary single changes are never throttled', async () => {
    cleanup();
    const box = add('<div id="one" class="a">x</div><style>.a{background:#fff}.b{background:#eee}</style>');
    engine.enable(); await engine.whenIdle(); await sleep(50);
    const el = box.querySelector('#one');
    for (let i = 0; i < 4; i++) { el.className = i % 2 ? 'a' : 'b'; await engine.whenIdle(); await sleep(40); await engine.whenIdle(); assert.ok(lum(el) < 0.1, 'iteration ' + i); }
    cleanup();
  });
  test('detection re-checks are rate limited on pages that toggle attributes constantly', async () => {
    cleanup();
    document.body.style.background = '#fff';
    F.config.minEvalGapMs = 500; F.config.debounceMs = 20; F.config.settleMs = 60000; // isolate from the post-load re-check
    const real = T.detect.measure;
    const times = [];
    T.detect.measure = function () { times.push(performance.now()); return real.apply(this, arguments); };
    try {
      F.enable(); await engine.whenIdle();
      const base = times.length; // the immediate evaluations at enable
      // 40 attribute changes in a burst (task-queue ticks, so timer throttling cannot matter)
      const tick = () => new Promise((r) => T.util.defer(r));
      for (let i = 0; i < 40; i++) { document.body.style.outline = i % 2 ? '1px solid red' : ''; await tick(); }
      await sleep(1500); // generous: covers the gap even when timers are throttled
      const extra = times.slice(base);
      assert.ok(extra.length <= 1, 'burst coalesced into at most one re-check, got ' + extra.length);
      assert.ok(extra.length === 1, 'the burst is still re-checked once');
      assert.ok(extra[0] - times[base - 1] >= 450, 'honours the minimum gap: ' + Math.round(extra[0] - times[base - 1]) + 'ms');
    } finally { T.detect.measure = real; document.body.style.outline = ''; cleanup(); }
  });
  test('detection still reacts to a real theme change after the gap', async () => {
    cleanup();
    document.body.style.background = '#fff';
    F.config.minEvalGapMs = 300; F.config.debounceMs = 20;
    F.enable(); await engine.whenIdle();
    assert.equal(F.isForcing(), true);
    await sleep(350);
    document.body.style.background = '#101010';
    await sleep(500);
    assert.equal(F.isForcing(), false);
    cleanup();
  });

  // ===================================================== robustness
  test('rapid enable/disable races: nothing appears late after disable', async () => {
    cleanup();
    add('<p style="background:#fff;color:#000">race</p><div class="x">y</div><style>.x{background:#eee}</style>');
    for (let i = 0; i < 25; i++) { engine.enable(); if (i % 3 === 0) await sleep(1); engine.disable(); }
    await sleep(200);
    assert.equal(residue(), 0);
    engine.enable(); engine.disable();
    await sleep(200);
    assert.equal(residue(), 0);
  });
  test('theme mode flapping with the real dispatcher leaves no late residue', async () => {
    cleanup();
    add('<p style="background:#fff;color:#000">flap</p>');
    for (let i = 0; i < 30; i++) T.theme.apply(['forced', 'dark', 'light'][i % 3]);
    T.theme.apply('light');
    await sleep(300);
    assert.equal(residue(), 0);
    cleanup();
  });
  test('SPA route changes: replacing the whole view 40 times keeps theming correct and the queue drains', async () => {
    cleanup();
    const mount = add('<div id="view"></div>');
    engine.enable(); await engine.whenIdle();
    for (let i = 0; i < 40; i++) {
      mount.querySelector('#view').innerHTML = `<section style="background:#f${i % 10}f${i % 10}f${i % 10}"><h2 style="color:#111">Route ${i}</h2><p>${'text '.repeat(10)}</p></section>`;
      await sleep(8);
    }
    await sleep(100); await engine.whenIdle();
    const sec = mount.querySelector('section');
    assert.ok(lum(sec) < 0.1);
    assert.ok(C.luminance(C.parse(getComputedStyle(sec.querySelector('h2')).color)) > 0.5);
    cleanup();
  });
  test('CSP fallback: if injected <style> elements get no sheet, constructed sheets are used instead', async () => {
    cleanup();
    const proto = HTMLStyleElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'sheet') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), 'sheet');
    const owner = Object.getOwnPropertyDescriptor(proto, 'sheet') ? proto : Object.getPrototypeOf(proto);
    Object.defineProperty(owner, 'sheet', { configurable: true, get() { return this.hasAttribute('data-trikaal-dyn') ? null : desc.get.call(this); } });
    try {
      const box = add('<div id="csp" class="k" style="padding:2px">csp text</div><style>.k{background:#fff;color:#111}</style>');
      engine.enable(); await engine.whenIdle(); await sleep(60); await engine.whenIdle();
      const el = box.querySelector('#csp');
      assert.ok(document.adoptedStyleSheets.length >= 1, 'constructed sheets adopted');
      assert.ok(lum(el) < 0.1, 'still themed via adoptedStyleSheets: ' + getComputedStyle(el).backgroundColor);
      engine.disable();
      assert.equal(document.adoptedStyleSheets.length, 0, 'adopted sheets removed on disable');
      assert.equal(residue(), 0);
    } finally { Object.defineProperty(owner, 'sheet', desc); cleanup(); }
  });
  test('repeated enable/disable cycles do not accumulate style elements or adopted sheets', async () => {
    cleanup();
    add('<div class="m" style="background:#fff">m</div><style>.m{color:#000}</style>');
    const baseStyles = document.querySelectorAll('style').length;
    for (let i = 0; i < 30; i++) { engine.enable(); await sleep(3); engine.disable(); }
    assert.equal(document.querySelectorAll('style').length, baseStyles);
    assert.equal(document.adoptedStyleSheets.length, 0);
    assert.equal(residue(), 0);
    cleanup();
  });
  test('a stylesheet containing hostile / malformed values does not break theming', async () => {
    cleanup();
    const box = add(`<style>
      .h1{background:rgb(1,2);color:#zzz} .h2{background:var(--nope, rgb(999,999,999));color:url(x)}
      .h3{background:linear-gradient(}} .h4{background-color:calc(1px + 2px);border-color:#12}
      @media (((bad){.h5{background:#fff}} .ok{background:#fff;color:#000}
    </style><div class="h1 h2 h3 h4 ok" id="host8">hostile</div>`);
    engine.enable(); await engine.whenIdle(); await sleep(60);
    assert.ok(lum(box.querySelector('#host8')) < 0.1);
    cleanup();
  });
  test('huge flat sheet (3000 rules) is rewritten in slices and fully applied', async () => {
    cleanup();
    let css = '';
    for (let i = 0; i < 3000; i++) css += `.big${i}{background:#fff;color:#111}\n`;
    const box = add(`<style>${css}</style><div class="big0" id="b0">a</div><div class="big2999" id="b2999">b</div>`);
    const t0 = performance.now();
    engine.enable();
    const lat = await blockedTicks(1200);
    await engine.whenIdle();
    assert.ok(lum(box.querySelector('#b0')) < 0.1 && lum(box.querySelector('#b2999')) < 0.1, 'first and last rule themed');
    assert.ok(lat.worst < 400, 'no single block over 400 ms: ' + JSON.stringify(lat));
    assert.ok(performance.now() - t0 < 20000);
    cleanup();
  });
  test('same-origin iframe: the content scripts theme the frame independently (all_frames)', async () => {
    cleanup();
    const store = fresh();
    await store.storage.sync.set({ trikaal: { defaultMode: 'forced' } });
    const f = document.createElement('iframe');
    f.dataset.p8 = '1';
    f.style.cssText = 'width:300px;height:120px';
    f.srcdoc = '<!doctype html><html><head><style>body{background:#fff;color:#111}</style></head><body><p id="fp">frame text</p></body></html>';
    document.body.appendChild(f);
    for (let i = 0; i < 100 && !(f.contentDocument.body && f.contentDocument.getElementById('fp')); i++) await sleep(20);
    const w = f.contentWindow;
    w.chrome = store;
    for (const src of ['/shared/storage.js', '/content/util.js', '/content/color.js', '/content/detect.js', '/content/forced-dark.js', '/content/rewrite.js', '/content/theme.js', '/content/controller.js', '/content/content.js']) {
      await new Promise((res, rej) => { const s = w.document.createElement('script'); s.src = src + '?t=' + Date.now(); s.onload = res; s.onerror = rej; w.document.head.appendChild(s); });
    }
    await w.Trikaal.forced.engines.rewrite.whenIdle(); await sleep(150); await w.Trikaal.forced.engines.rewrite.whenIdle();
    const body = w.document.body;
    assert.ok(C.luminance(C.parse(w.getComputedStyle(body).backgroundColor)) < 0.1, 'frame body themed: ' + w.getComputedStyle(body).backgroundColor);
    assert.ok(C.luminance(C.parse(w.getComputedStyle(w.document.getElementById('fp')).color)) > 0.5);
    assert.equal(residue(), 0, 'the parent document was not touched');
    f.remove();
    cleanup();
  });

  // ===================================================== privacy control (popup)
  test('popup: "Forget remembered sites" clears the local verdict cache and confirms', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    c._local.trikaalDetect = { 'a.com': { dark: true, t: 1 }, 'b.com': { dark: false, t: 2 } };
    const p = await mountPopup(c);
    p.doc.getElementById('clear-cache').click();
    await sleep(60);
    assert.equal('trikaalDetect' in c._local, false);
    assert.ok(p.doc.getElementById('clear-note').textContent.includes('Forgotten'));
    const k = p.doc.getElementById('clear-note');
    assert.equal(k.getAttribute('role'), 'status');
    p.destroy();
  });
  test('popup: clearing survives a storage error and says so', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    c.storage.local.remove = async () => { throw new Error('nope'); };
    const p = await mountPopup(c);
    p.doc.getElementById('clear-cache').click();
    await sleep(60);
    assert.ok(p.doc.getElementById('clear-note').textContent.includes('Could not'));
    p.destroy();
  });
  test('popup: still passes its accessibility contract with the new privacy section', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    const p = await mountPopup(c);
    const btn = p.doc.getElementById('clear-cache');
    assert.ok(btn.textContent.trim().length > 0);
    assert.equal(p.doc.querySelector('section[aria-labelledby="privacy-title"] h2').id, 'privacy-title');
    assert.equal(p.doc.querySelectorAll('[tabindex]').length, 0);
    p.destroy();
  });
})();
