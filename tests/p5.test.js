// Phase 5: color parsing, already-dark detection, and the forced-dark session logic.
window.__suitePending = (async () => {
  await loadScripts(['/shared/storage.js', '/content/util.js', '/content/color.js', '/content/detect.js', '/content/forced-dark.js', '/content/theme.js', '/content/controller.js']);
  const T = Trikaal;
  const C = T.color, D = T.detect, F = T.forced;
  const rgb = (s) => { const c = C.parse(s); return c && [Math.round(c.r), Math.round(c.g), Math.round(c.b), +c.a.toFixed(2)]; };

  // ---------------- color parsing ----------------
  test('parse: hex forms', () => {
    assert.deepEqual(rgb('#fff'), [255, 255, 255, 1]);
    assert.deepEqual(rgb('#1a2B3c'), [26, 43, 60, 1]);
    assert.deepEqual(rgb('#0008'), [0, 0, 0, 0.53]);
    assert.deepEqual(rgb('#ff000080'), [255, 0, 0, 0.5]);
    assert.equal(rgb('#ff'), null);
    assert.equal(rgb('#gggggg'), null);
  });
  test('parse: rgb/rgba comma, space, percent, alpha syntaxes', () => {
    assert.deepEqual(rgb('rgb(1, 2, 3)'), [1, 2, 3, 1]);
    assert.deepEqual(rgb('rgba(1,2,3,.5)'), [1, 2, 3, 0.5]);
    assert.deepEqual(rgb('rgb(1 2 3 / 25%)'), [1, 2, 3, 0.25]);
    assert.deepEqual(rgb('rgb(100% 0% 0%)'), [255, 0, 0, 1]);
    assert.deepEqual(rgb('RGB(300, -5, 3)'), [255, 0, 3, 1], 'clamped');
    assert.equal(rgb('rgb(1,2)'), null);
  });
  test('parse: hsl, color(srgb), transparent', () => {
    assert.deepEqual(rgb('hsl(0, 100%, 50%)'), [255, 0, 0, 1]);
    assert.deepEqual(rgb('hsl(120deg 100% 25%)'.replace('deg', '')), [0, 128, 0, 1]);
    assert.deepEqual(rgb('hsla(240, 100%, 50%, 0.5)'), [0, 0, 255, 0.5]);
    assert.deepEqual(rgb('color(srgb 1 0 0 / 0.5)'), [255, 0, 0, 0.5]);
    assert.deepEqual(rgb('transparent'), [0, 0, 0, 0]);
  });
  test('parse: named colors and modern spaces via canvas fallback', () => {
    assert.deepEqual(rgb('black'), [0, 0, 0, 1]);
    assert.deepEqual(rgb('RebeccaPurple'), [102, 51, 153, 1]);
    assert.deepEqual(rgb('white'), [255, 255, 255, 1]);
    const ok = rgb('oklch(0.2 0 0)');
    assert.ok(ok && ok[0] < 60 && ok[0] === ok[1] && ok[1] === ok[2], 'oklch gray: ' + JSON.stringify(ok));
    const lab = rgb('lab(100 0 0)');
    assert.ok(lab && lab[0] > 250, 'lab white ' + JSON.stringify(lab));
  });
  test('parse: invalid and non-string input return null; sentinel colors are not confused', () => {
    for (const bad of ['', '   ', 'notacolor', 'rgb(', null, undefined, 42, {}, 'var(--x)', 'currentcolor-ish']) assert.equal(C.parse(bad), null, String(bad));
    assert.deepEqual(rgb('#010203'), [1, 2, 3, 1]);
    assert.deepEqual(rgb('#030201'), [3, 2, 1, 1]);
  });
  test('parse: memoization returns equal results and survives cache clearing', () => {
    const a = C.parse('rgb(9, 9, 9)'), b = C.parse(' RGB(9, 9, 9) ');
    assert.deepEqual(a, b);
    C._clearCache();
    assert.deepEqual(C.parse('rgb(9, 9, 9)'), a);
  });
  test('luminance: black, white, mid-gray, known values', () => {
    assert.equal(C.luminance({ r: 0, g: 0, b: 0 }), 0);
    assert.near(C.luminance({ r: 255, g: 255, b: 255 }), 1, 1e-9);
    assert.near(C.luminance({ r: 128, g: 128, b: 128 }), 0.2159, 0.001);
    assert.near(C.luminance({ r: 18, g: 18, b: 18 }), 0.006, 0.001);
    assert.near(C.luminance({ r: 255, g: 0, b: 0 }), 0.2126, 1e-6);
  });
  test('over: alpha compositing', () => {
    const r = C.over({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual([Math.round(r.r), r.a], [128, 1]);
    assert.equal(C.over({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }).g, 20);
    assert.equal(C.over({ r: 10, g: 20, b: 30, a: 0 }, { r: 255, g: 255, b: 255, a: 1 }).g, 255);
  });

  // ---------------- measure() on fixture documents ----------------
  const frames = [];
  async function page(html) {
    const f = document.createElement('iframe');
    f.style.cssText = 'width:800px;height:600px;border:0';
    // A marker lets us tell the real srcdoc document from the empty about:blank one a
    // new iframe starts with (which already reports readyState "complete").
    const MARK = '<meta name="tk-fixture">';
    f.srcdoc = html.includes('<head>') ? html.replace('<head>', '<head>' + MARK) : MARK + html;
    document.body.appendChild(f);
    frames.push(f);
    for (let i = 0; i < 150; i++) {
      const d = f.contentDocument;
      if (d && d.readyState === 'complete' && d.querySelector('meta[name="tk-fixture"]')) break;
      await sleep(20);
    }
    await sleep(20);
    return f.contentDocument;
  }
  const m = async (html, opts) => D.measure(await page(html), opts || { prefersDark: false });
  const wrap = (head, body) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  const afterEachFrame = () => { frames.splice(0).forEach((f) => f.remove()); };

  test('plain page with no styles is light', async () => {
    const r = await m(wrap('', '<p>hi</p>'));
    assert.equal(r.dark, false); assert.equal(r.reason, 'default-canvas'); assert.equal(r.final, true);
    afterEachFrame();
  });
  test('body white / light gray / sepia are light', async () => {
    for (const c of ['#fff', '#f6f8fa', '#f4ecd8', '#aaa', 'hsl(40 40% 90%)']) {
      const r = await m(wrap(`<style>body{background:${c}}</style>`, '<p>x</p>'));
      assert.equal(r.dark, false, c);
      assert.equal(r.reason, 'background');
    }
    afterEachFrame();
  });
  test('body dark backgrounds are dark (GitHub, YouTube, Twitter dim, pure black)', async () => {
    for (const c of ['#0d1117', '#0f0f0f', '#15202b', '#000', '#121212', 'black', 'rgb(30 30 30)', '#3b3b3b', 'oklch(0.2 0 0)']) {
      const r = await m(wrap(`<style>body{background:${c}}</style>`, '<p>x</p>'));
      assert.equal(r.dark, true, c);
    }
    afterEachFrame();
  });
  test('threshold: #666 dark, #888 light (luminance 0.2 boundary)', async () => {
    assert.equal((await m(wrap('<style>body{background:#666}</style>', '<p>x</p>'))).dark, true);
    assert.equal((await m(wrap('<style>body{background:#888}</style>', '<p>x</p>'))).dark, false);
    afterEachFrame();
  });
  test('transparent body falls through to <html> background', async () => {
    const dark = await m(wrap('<style>html{background:#000}</style>', '<p>x</p>'));
    assert.equal(dark.dark, true); assert.equal(dark.reason, 'background');
    const light = await m(wrap('<style>html{background:#fff}</style>', '<p>x</p>'));
    assert.equal(light.dark, false);
    afterEachFrame();
  });
  test('body wins over html (first opaque walking up from body)', async () => {
    const r = await m(wrap('<style>html{background:#000}body{background:#fff}</style>', '<p>x</p>'));
    assert.equal(r.dark, false);
    afterEachFrame();
  });
  test('semi-transparent backgrounds are composited over white', async () => {
    assert.equal((await m(wrap('<style>body{background:rgba(0,0,0,.9)}</style>', '<p>x</p>'))).dark, true);
    assert.equal((await m(wrap('<style>body{background:rgba(0,0,0,.1)}</style>', '<p>x</p>'))).dark, false);
    // translucent body over an opaque dark html
    assert.equal((await m(wrap('<style>html{background:#000}body{background:rgba(255,255,255,.1)}</style>', '<p>x</p>'))).dark, true);
    afterEachFrame();
  });
  test('transparent body + dark full-height wrapper (SPA) is dark via content sample', async () => {
    const r = await m(wrap('<style>html,body{margin:0;height:100%}#app{height:100vh;background:#111;color:#eee}</style>', '<div id="app"><p>app</p></div>'));
    assert.equal(r.dark, true); assert.equal(r.reason, 'content-background');
    const light = await m(wrap('<style>html,body{margin:0;height:100%}#app{height:100vh;background:#fff}</style>', '<div id="app"><p>app</p></div>'));
    assert.equal(light.dark, false);
    afterEachFrame();
  });
  test('color-scheme: dark (CSS) with no backgrounds is dark', async () => {
    const r = await m(wrap('<style>:root{color-scheme:dark}</style>', '<p>x</p>'));
    assert.equal(r.dark, true); assert.equal(r.reason, 'color-scheme');
    afterEachFrame();
  });
  test('<meta name=color-scheme content=dark> is dark; "light dark" follows the OS', async () => {
    assert.equal((await m(wrap('<meta name="color-scheme" content="dark">', '<p>x</p>'))).dark, true);
    assert.equal((await m(wrap('<meta name="color-scheme" content="light dark">', '<p>x</p>'), { prefersDark: false })).dark, false);
    assert.equal((await m(wrap('<meta name="color-scheme" content="light dark">', '<p>x</p>'), { prefersDark: true })).dark, true);
    assert.equal((await m(wrap('<meta name="color-scheme" content="light">', '<p>x</p>'), { prefersDark: true })).dark, false);
    assert.equal((await m(wrap('<style>:root{color-scheme:light dark}</style>', '<p>x</p>'), { prefersDark: true })).dark, true);
    afterEachFrame();
  });
  test('explicit opaque light background beats a dark color-scheme declaration', async () => {
    const r = await m(wrap('<meta name="color-scheme" content="dark"><style>body{background:#fff}</style>', '<p>x</p>'));
    assert.equal(r.dark, false);
    afterEachFrame();
  });
  test('light body text with no visible background implies dark design', async () => {
    const r = await m(wrap('<style>body{color:#fff}</style>', '<p>x</p>'));
    assert.equal(r.dark, true); assert.equal(r.reason, 'light-text');
    const r2 = await m(wrap('<style>body{color:#222}</style>', '<p>x</p>'));
    assert.equal(r2.dark, false);
    afterEachFrame();
  });
  test('empty document / missing body is not final', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.body.remove();
    const r = D.measure(doc, { prefersDark: false });
    assert.equal(r.final, false);
    assert.equal(r.dark, false);
  });
  test('measure never throws on odd documents', async () => {
    const doc = await page('');
    assert.ok(D.measure(doc, {}));
    assert.ok(D.measure(undefined, {}));
    afterEachFrame();
  });
  test('our own injected elements are ignored by the center sample', async () => {
    const doc = await page(wrap('<style>html,body{margin:0;height:100%}</style>', '<div id="trikaal-overlay" style="position:fixed;inset:0;background:#000"></div><p>x</p>'));
    const r = D.measure(doc, { prefersDark: false });
    assert.equal(r.dark, false, 'black own overlay must not count');
    afterEachFrame();
  });

  // ---------------- verdict cache ----------------
  test('cache: loads valid entries, rejects junk, case-insensitive', async () => {
    const c = (window.chrome = createMockChrome());
    c._local.trikaalDetect = { 'a.com': { dark: true, t: 1 }, 'b.com': { dark: false, t: 2 }, bad: { dark: 'x' }, '__proto__': { dark: true } };
    await D.loadCache();
    assert.equal(D.cachedVerdict('a.com'), 'dark');
    assert.equal(D.cachedVerdict('A.COM'), 'dark');
    assert.equal(D.cachedVerdict('b.com'), 'light');
    assert.equal(D.cachedVerdict('bad'), null);
    assert.equal(D.cachedVerdict('__proto__'), null);
    assert.equal(D.cachedVerdict('unknown.com'), null);
    assert.equal(D.cachedVerdict(''), null);
  });
  test('cache: survives missing/failing storage', async () => {
    window.chrome = {};
    await D.loadCache();
    D.remember('x.com', true);
    await D.flushCache();
    window.chrome = createMockChrome();
  });
  test('cache: remember persists once, ignores no-op repeats, caps at 300 (oldest dropped)', async () => {
    const c = (window.chrome = createMockChrome());
    await D.loadCache();
    D.remember('site0.com', true);
    for (let i = 1; i < 350; i++) D.remember('site' + i + '.com', i % 2 === 0);
    await D.flushCache();
    const stored = c._local.trikaalDetect;
    assert.ok(Object.keys(stored).length <= 300, 'size ' + Object.keys(stored).length);
    assert.ok(!stored['site0.com'], 'oldest dropped');
    assert.equal(stored['site349.com'].dark, false);
    await D.loadCache();
  });

  test('cache: flush merges with what other tabs stored instead of overwriting it', async () => {
    const c = (window.chrome = createMockChrome());
    await D.loadCache(); // empty, like a frame that skipped the preload
    c._local.trikaalDetect = { 'other.com': { dark: true, t: 5 } }; // another tab wrote meanwhile
    D.remember('mine.com', false);
    await D.flushCache();
    assert.equal(c._local.trikaalDetect['other.com'].dark, true, 'other tab entry kept');
    assert.equal(c._local.trikaalDetect['mine.com'].dark, false);
    await D.loadCache();
  });

  // ---------------- forced session behaviour (integration) ----------------
  const root = document.documentElement;
  const forcedStyle = () => document.getElementById('trikaal-forced-style');
  const setBg = (c) => { document.body.style.background = c; };
  const savedBodyBg = document.body.style.background;
  const reset = () => { F.disable(); T.theme.teardown(); document.body.style.background = savedBodyBg; document.querySelectorAll('meta[name="color-scheme"]').forEach((e) => e.remove()); F.isTopFrame = () => true; F.config.debounceMs = 25; F.config.minEvalGapMs = 0; F.config.settleMs = 60; window.chrome = createMockChrome(); };

  test('session: light page gets forced; style is active and not left disabled', async () => {
    reset(); setBg('#fff');
    F.enable();
    assert.equal(F.isForcing(), true);
    assert.ok(forcedStyle());
    assert.equal(forcedStyle().disabled, false);
    assert.equal(F.lastVerdict.dark, false);
    reset();
  });
  test('session: already-dark page is left alone (no residue, never forced)', async () => {
    reset(); setBg('#0d1117');
    F.enable();
    assert.equal(F.isForcing(), false);
    assert.equal(document.querySelectorAll('#trikaal-forced-style, [data-trikaal-keep]').length, 0);
    assert.equal(getComputedStyle(root).filter, 'none');
    reset();
  });
  test('session: forcing is never visible to a paint when the page is already dark (sync add+remove)', () => {
    reset(); setBg('#000');
    let sawStyleAtStart = false;
    const mo = new MutationObserver(() => {});
    mo.observe(document.head, { childList: true }); mo.observe(root, { childList: true });
    F.enable();
    // Everything above ran in one task: style may have been inserted and removed, but
    // by the time control returns to the browser it is gone.
    assert.equal(!!forcedStyle(), false);
    mo.disconnect();
    reset();
  });
  test('session: page that turns dark later (theme toggle) stops being forced, and back', async () => {
    reset(); setBg('#fff');
    F.enable();
    assert.equal(F.isForcing(), true);
    setBg('#111');
    await sleep(120);
    assert.equal(F.isForcing(), false, 'dropped after page went dark');
    assert.equal(!!forcedStyle(), false);
    setBg('#fff');
    await sleep(120);
    assert.equal(F.isForcing(), true, 'restored after page went light');
    assert.ok(forcedStyle());
    reset();
  });
  test('session: class and data-attribute theme toggles are noticed', async () => {
    reset();
    const st = document.createElement('style');
    st.textContent = 'body.tk-dark{background:#101010} body.tk-light{background:#fafafa}';
    document.head.appendChild(st);
    document.body.className = 'tk-light';
    F.enable();
    assert.equal(F.isForcing(), true);
    document.body.className = 'tk-dark';
    await sleep(120);
    assert.equal(F.isForcing(), false);
    document.body.className = '';
    await sleep(120);
    assert.equal(F.isForcing(), true);
    st.remove();
    reset();
  });
  test('session: <meta name=color-scheme> added later is noticed', async () => {
    reset(); setBg('');
    F.enable();
    assert.equal(F.isForcing(), true);
    const meta = document.createElement('meta');
    meta.name = 'color-scheme'; meta.content = 'dark';
    document.head.appendChild(meta);
    await sleep(120);
    assert.equal(F.isForcing(), false);
    meta.remove();
    await sleep(120);
    assert.equal(F.isForcing(), true);
    reset();
  });
  test('session: disable() stops all monitoring', async () => {
    reset(); setBg('#fff');
    F.enable();
    F.disable();
    setBg('#000'); await sleep(100); setBg('#fff'); await sleep(100);
    assert.equal(F.isForcing(), false);
    assert.equal(!!forcedStyle(), false);
    reset();
  });
  test('session: re-enable after disable works and stays single', async () => {
    reset(); setBg('#fff');
    for (let i = 0; i < 5; i++) { F.enable(); F.disable(); }
    F.enable(); F.enable();
    assert.equal(document.querySelectorAll('#trikaal-forced-style').length, 1);
    reset();
  });
  test('session: before <body> exists the verdict is not final -> keep tentative forcing; cached dark skips it', () => {
    reset();
    const real = D.measure;
    const host = location.hostname;
    try {
      D.measure = () => ({ dark: false, final: false, reason: 'no-body', luminance: null });
      D.remember(host, false);
      F.enable();
      assert.equal(F.isForcing(), true, 'unknown, no cache: force to avoid white flash');
      F.disable();
      D.remember(host, true); // cached dark for this host
      F.enable();
      assert.equal(F.isForcing(), false, 'known-dark host is not forced while body is unknown');
    } finally {
      D.measure = real;
      D.remember(host, false);
      reset();
    }
  });
  test('session: detection errors keep the current state and never throw', () => {
    reset();
    const real = D.measure;
    try {
      D.measure = () => { throw new Error('boom'); };
      F.enable();
      assert.equal(F.isForcing(), true);
    } finally {
      D.measure = real;
      reset();
    }
  });
  test('session: verdicts are remembered per host for the next load', async () => {
    reset(); setBg('#000');
    D.remember(location.hostname, false); // clear previous
    F.enable();
    assert.equal(D.cachedVerdict(location.hostname), 'dark');
    setBg('#fff'); await sleep(120);
    assert.equal(D.cachedVerdict(location.hostname), 'light');
    reset();
  });
  test('session: non-top frame does nothing (filter engine)', () => {
    reset(); setBg('#fff');
    F.isTopFrame = () => false;
    F.enable();
    assert.equal(F.isForcing(), false);
    assert.equal(!!forcedStyle(), false);
    reset();
  });
  test('session: theme dispatch forced -> light removes the engine completely', async () => {
    reset(); setBg('#fff');
    T.theme.apply('forced');
    assert.ok(forcedStyle());
    T.theme.apply('light');
    assert.equal(document.querySelectorAll('#trikaal-forced-style, [data-trikaal-keep]').length, 0);
    reset();
  });
  test('e2e: controller preload warms the cache before first apply', async () => {
    reset();
    const c = (window.chrome = createMockChrome());
    c._local.trikaalDetect = { [location.hostname]: { dark: true, t: 5 } };
    await c.storage.sync.set({ trikaal: { defaultMode: 'forced', siteOverrides: {} } });
    let seen = null;
    const ctl = T.createController({ host: location.hostname, log: () => {}, preload: () => D.loadCache(), apply: () => { seen = D.cachedVerdict(location.hostname); } });
    await ctl.start();
    assert.equal(seen, 'dark');
    ctl.stop();
    reset();
  });
  test('a failing preload does not block applying the mode', async () => {
    reset();
    window.chrome = createMockChrome();
    let applied = null;
    const ctl = T.createController({ host: 'x.com', log: () => {}, preload: () => { throw new Error('x'); }, apply: (m) => { applied = m; } });
    await ctl.start();
    assert.equal(applied, 'light');
    ctl.stop();
  });
})();
