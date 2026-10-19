// Phase 9: early paint guard (CSS-only content scripts registered by the service worker,
// plus the reveal logic in the page).
window.__suitePending = (async () => {
  await loadScripts(['/shared/storage.js', '/content/util.js', '/content/color.js', '/content/detect.js', '/content/forced-dark.js', '/content/rewrite.js', '/content/theme.js', '/content/controller.js']);
  const T = Trikaal, S = T.storage, F = T.forced;
  const engine = F.engines.rewrite;
  const get = async (path) => { const r = await fetch(path, { cache: 'no-store' }); assert.equal(r.status, 200, path); return r.text(); };
  const settingsWith = (patch) => S.sanitize(Object.assign(S.defaults(), patch));
  const validPattern = (p) => p === '<all_urls>' || /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/.test(p);

  // ================================================================ which sites get the guard
  test('earlyGroups: nothing for Light, nothing for Auto, nothing for an empty config', () => {
    assert.deepEqual(S.earlyGroups(S.defaults()), { forced: null });
    assert.deepEqual(S.earlyGroups(settingsWith({ defaultMode: 'auto' })), { forced: null });
    assert.deepEqual(S.earlyGroups(null), { forced: null });
    assert.deepEqual(S.earlyGroups('junk'), { forced: null });
  });
  test('earlyGroups: default Dark covers all sites (a stored legacy "dark" counts as Dark)', () => {
    assert.deepEqual(S.earlyGroups(settingsWith({ defaultMode: 'forced' })), { forced: { matches: ['<all_urls>'], excludeMatches: [] } });
    assert.deepEqual(S.earlyGroups(settingsWith({ defaultMode: 'dark' })), { forced: { matches: ['<all_urls>'], excludeMatches: [] } });
  });
  test('earlyGroups: per-site overrides are carved out of the default (exact host only)', () => {
    const g = S.earlyGroups(settingsWith({ defaultMode: 'forced', siteOverrides: { 'b.com': 'light', 'c.com': 'forced', 'd.com': 'auto' } }));
    assert.deepEqual(g.forced.matches, ['<all_urls>']);
    assert.deepEqual(g.forced.excludeMatches.sort(), ['*://b.com/*', '*://d.com/*']);
  });
  test('earlyGroups: default Light + Dark overrides register only those sites', () => {
    const g = S.earlyGroups(settingsWith({ siteOverrides: { 'a.com': 'forced', 'b.com': 'dark', 'c.com': 'light' } }));
    assert.deepEqual(g.forced.matches.sort(), ['*://a.com/*', '*://b.com/*']);
  });
  test('earlyGroups: exclusions (with subdomains) are carved out of Dark', () => {
    const g = S.earlyGroups(settingsWith({ defaultMode: 'forced', excludedSites: ['x.com'] }));
    assert.deepEqual(g.forced.excludeMatches, ['*://x.com/*', '*://*.x.com/*']);
  });
  test('earlyGroups: an excluded site with a stale per-site Dark is not registered', () => {
    const g = S.earlyGroups(settingsWith({ siteOverrides: { 'a.com': 'forced' }, excludedSites: ['a.com'] }));
    assert.equal(g.forced, null);
  });
  test('earlyGroups: every pattern is a valid Chrome match pattern; unusable hosts are skipped', () => {
    const hosts = { 'a b.com': 'forced', '[::1]': 'forced', 'ok.example.org': 'forced', 'localhost': 'forced', '127.0.0.1': 'light', 'under_score.com': 'light', 'xn--bcher-kva.example': 'light' };
    const g = S.earlyGroups(settingsWith({ defaultMode: 'forced', siteOverrides: hosts, excludedSites: ['bad host', 'good.com'] }));
    const all = [].concat(g.forced.matches, g.forced.excludeMatches);
    assert.ok(all.length > 3);
    for (const p of all) assert.ok(validPattern(p), 'invalid pattern ' + p);
    assert.ok(g.forced.excludeMatches.includes('*://127.0.0.1/*'));
    const only = S.earlyGroups(settingsWith({ siteOverrides: hosts }));
    assert.ok(only.forced.matches.includes('*://ok.example.org/*') && only.forced.matches.includes('*://localhost/*'));
    assert.ok(!only.forced.matches.some((m) => m.includes('a b') || m.includes('[')), 'unusable hosts skipped');
  });
  test('earlyGroups does not mutate its input and is deterministic', () => {
    const s = settingsWith({ defaultMode: 'forced', siteOverrides: { 'a.com': 'light' }, excludedSites: ['x.com'] });
    const before = JSON.stringify(s);
    const a = JSON.stringify(S.earlyGroups(s)), b = JSON.stringify(S.earlyGroups(s));
    assert.equal(JSON.stringify(s), before);
    assert.equal(a, b);
  });

  // ================================================================ the service worker keeps the registration in sync
  window.importScripts = () => {};
  const swMock = (window.chrome = createMockChrome());
  await loadScripts(['/background/service-worker.js']);
  const sync = () => self.__trikaalSyncEarly();
  const reset = async () => {
    window.chrome = swMock;
    swMock.fail.scripting = false;
    Object.keys(swMock._data).forEach((k) => delete swMock._data[k]);
    await swMock.scripting.unregisterContentScripts().catch(() => {});
    await sync();
  };
  const reg = () => Object.fromEntries(Array.from(swMock._scripts.entries()));

  test('SW: exposes the sync hook and registers nothing for the default (Light) settings', async () => {
    await reset();
    assert.equal(typeof self.__trikaalSyncEarly, 'function');
    assert.deepEqual(reg(), {});
  });
  test('SW: default Forced Dark registers one CSS-only script with the right definition', async () => {
    await reset();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    await sync();
    const r = reg();
    assert.deepEqual(Object.keys(r), ['trikaal-early-forced']);
    const d = r['trikaal-early-forced'];
    assert.deepEqual(d.css, ['content/early-forced.css']);
    assert.equal(d.js, undefined, 'CSS only: no JavaScript is registered');
    assert.deepEqual(d.matches, ['<all_urls>']);
    assert.equal(d.runAt, 'document_start');
    assert.equal(d.allFrames, true);
    assert.equal(d.matchOriginAsFallback, true);
    assert.equal(d.persistAcrossSessions, true);
  });
  test('SW: switching the default Dark -> Light removes the script', async () => {
    await reset();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced')); await sync();
    assert.deepEqual(Object.keys(reg()), ['trikaal-early-forced']);
    await S.update((s) => S.applyChange(s, 'all', '', 'light')); await sync();
    assert.deepEqual(reg(), {});
  });
  test('SW: a Dark-mode guard registered by an older version (persisted) is removed', async () => {
    await reset();
    await swMock.scripting.registerContentScripts([{ id: 'trikaal-early-dark', matches: ['<all_urls>'], css: ['content/early-dark.css'], runAt: 'document_start' }]);
    await S.update((s) => S.applyChange(s, 'all', '', 'forced')); await sync();
    assert.deepEqual(Object.keys(reg()), ['trikaal-early-forced']);
  });
  test('SW: onChanged alone (no manual sync) keeps the registration current', async () => {
    await reset();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    await sync(); // waits for the listener-triggered run too (they are serialized)
    assert.ok(reg()['trikaal-early-forced']);
  });
  test('SW: per-site Forced Dark registers just those hosts and follows add/remove', async () => {
    await reset();
    await S.update((s) => S.applyChange(s, 'site', 'a.com', 'forced')); await sync();
    assert.deepEqual(reg()['trikaal-early-forced'].matches, ['*://a.com/*']);
    await S.update((s) => S.applyChange(s, 'site', 'b.org', 'forced')); await sync();
    assert.deepEqual(reg()['trikaal-early-forced'].matches.sort(), ['*://a.com/*', '*://b.org/*']);
    await S.update((s) => S.applyChange(S.applyChange(s, 'site', 'a.com', 'default'), 'site', 'b.org', 'default')); await sync();
    assert.deepEqual(reg(), {});
  });
  test('SW: removing an exclusion really clears excludeMatches (update() keeps omitted fields)', async () => {
    await reset();
    await S.update((s) => S.setExcluded(S.applyChange(s, 'all', '', 'forced'), 'x.com', true)); await sync();
    assert.deepEqual(reg()['trikaal-early-forced'].excludeMatches, ['*://x.com/*', '*://*.x.com/*']);
    await S.update((s) => S.setExcluded(s, 'x.com', false)); await sync();
    assert.deepEqual(reg()['trikaal-early-forced'].excludeMatches, []);
  });
  test('SW: an excluded site gets no guard even though the default is Forced Dark', async () => {
    await reset();
    await S.update((s) => S.setExcluded(S.applyChange(s, 'all', '', 'forced'), 'bank.com', true)); await sync();
    assert.ok(reg()['trikaal-early-forced'].excludeMatches.includes('*://*.bank.com/*'));
  });
  test('SW: twelve rapid settings changes converge to exactly the final state (serialized)', async () => {
    await reset();
    const modes = ['forced', 'light', 'forced', 'light', 'forced', 'forced', 'light', 'light', 'forced', 'light', 'forced', 'forced'];
    for (const m of modes) await S.update((s) => S.applyChange(s, 'all', '', m)); // no awaiting the SW in between
    await sync();
    const want = S.earlyGroups(await S.load());
    assert.deepEqual(Object.keys(reg()).sort(), ['trikaal-early-forced']);
    assert.deepEqual(reg()['trikaal-early-forced'].matches, want.forced.matches);
  });
  test('SW: parallel sync() calls never produce duplicate-id errors', async () => {
    await reset();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    await Promise.all(Array.from({ length: 8 }, () => sync()));
    assert.deepEqual(Object.keys(reg()), ['trikaal-early-forced']);
  });
  test('SW: scripting failures never throw; the next successful run repairs the state', async () => {
    await reset();
    swMock.fail.scripting = true; // set first: the change below immediately triggers a (failing) sync
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    await sync(); // must resolve even though every scripting call rejects
    assert.deepEqual(reg(), {});
    swMock.fail.scripting = false;
    await sync();
    assert.ok(reg()['trikaal-early-forced']);
  });
  test('SW: runtime.onStartup and onInstalled re-register a lost registration', async () => {
    await reset();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced')); await sync();
    swMock._scripts.clear();
    swMock._fireStartup(); await sync();
    assert.ok(reg()['trikaal-early-forced'], 'restored on startup');
    swMock._scripts.clear();
    swMock._fireInstalled(); await sync();
    assert.ok(reg()['trikaal-early-forced'], 'restored on install/update');
  });
  test('SW: repeated syncs are idempotent (same single script, same definition)', async () => {
    await reset();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced')); await sync();
    const first = JSON.stringify(reg());
    for (let i = 0; i < 5; i++) await sync();
    assert.equal(JSON.stringify(reg()), first);
  });
  test('SW: unrelated storage changes do not trigger a registration run', async () => {
    await reset();
    let calls = 0;
    const real = swMock.scripting.getRegisteredContentScripts;
    swMock.scripting.getRegisteredContentScripts = async () => { calls++; return real(); };
    await swMock.storage.sync.set({ somethingElse: 1 });
    await swMock.storage.local.set({ trikaalDetect: {} });
    await sync(); // an explicit run still works
    swMock.scripting.getRegisteredContentScripts = real;
    assert.equal(calls, 1, 'only the explicit sync() ran');
  });

  test('SW: on install/update, open http(s) tabs get the current scripts (old instance cleaned first)', async () => {
    await reset();
    swMock._manifest = JSON.parse(await get('/manifest.json'));
    swMock.executed.length = 0;
    swMock.tabs = { query: async (q) => { swMock._lastQuery = q; return [{ id: 5, url: 'https://a.com/' }, { id: 6, url: 'https://b.com/' }]; } };
    swMock._fireInstalled();
    for (let i = 0; i < 50 && swMock.executed.length < 6; i++) await sleep(10);
    assert.deepEqual(swMock._lastQuery, { url: ['http://*/*', 'https://*/*'] }, 'only web pages');
    const forTab = (id) => swMock.executed.filter((e) => e.target.tabId === id);
    for (const id of [5, 6]) {
      const [clean, iso, main] = forTab(id);
      assert.equal(clean.func, 'cleanOldInstance');
      assert.equal(clean.target.allFrames, true);
      assert.ok(iso.files.includes('content/content.js') && iso.files[0] === 'shared/storage.js', 'isolated scripts in manifest order');
      assert.equal(main.world, 'MAIN');
      assert.deepEqual(main.files, ['content/main-world.js']);
    }
  });
  test('SW: a tab that cannot be scripted does not stop the others or throw', async () => {
    await reset();
    swMock._manifest = JSON.parse(await get('/manifest.json'));
    swMock.executed.length = 0;
    swMock.tabs = { query: async () => [{ id: 1, url: 'https://x.com/' }, { id: 2, url: 'https://y.com/' }] };
    const real = swMock.scripting.executeScript;
    swMock.scripting.executeScript = async (d) => { if (d.target.tabId === 1) throw new Error('Cannot access'); return real(d); };
    await self.__trikaalRefreshOpenTabs();
    swMock.scripting.executeScript = real;
    assert.ok(swMock.executed.some((e) => e.target.tabId === 2 && e.files), 'tab 2 still handled');
    await self.__trikaalRefreshOpenTabs(); // and a missing manifest/tab list never throws
  });

  // ================================================================ the CSS and the manifest
  test('early CSS: the file hides the body on a dark canvas, key off data-trikaal-off, and carry a CSS-only safety reveal', async () => {
    for (const f of ['early-forced.css']) {
      const css = await get('/content/' + f);
      assert.ok(css.includes('html:not([data-trikaal-off])'), f + ': switchable from the page');
      assert.ok(css.includes('color-scheme: dark !important'), f);
      assert.ok(/> body\s*\{[^}]*opacity:\s*0/.test(css), f + ': body hidden');
      assert.ok(/animation:\s*trikaal-early-reveal\s+0s\s+linear\s+1\.2s\s+forwards/.test(css), f + ': safety reveal after 1.2 s');
      assert.ok(/@keyframes trikaal-early-reveal\s*\{\s*to\s*\{\s*opacity:\s*1/.test(css), f + ': keyframes');
      assert.ok(css.includes('--trikaal-early'), f + ': detection marker');
      assert.ok(!/(url\(|@import|http)/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), f + ': no external resources');
    }
    assert.ok((await get('/content/early-forced.css')).includes('background-color: #181818 !important'), 'forced paints the dark canvas');
    assert.equal((await fetch('/content/early-dark.css', { cache: 'no-store' })).status, 404, 'the removed native Dark mode has no guard file');
  });
  test('manifest: scripting permission present, early CSS files exist and are registered dynamically only', async () => {
    const m = JSON.parse(await get('/manifest.json'));
    assert.ok(m.permissions.includes('scripting'));
    for (const f of ['content/early-forced.css']) assert.equal((await fetch('/' + f, { cache: 'no-store' })).status, 200, f);
    const staticJs = m.content_scripts.flatMap((c) => (c.js || []).concat(c.css || []));
    assert.ok(!staticJs.some((f) => f.includes('early-')), 'the guard must only exist where the service worker registers it');
    const sw = await get('/background/service-worker.js');
    for (const id of ['trikaal-early-forced', 'trikaal-early-dark', 'document_start', 'persistAcrossSessions', 'excludeMatches']) assert.ok(sw.includes(id), id);
  });

  // ================================================================ the page side: guard + reveal
  const forcedCss = await get('/content/early-forced.css');
  const root = document.documentElement;
  const opacity = () => getComputedStyle(document.body).opacity;
  const off = () => root.hasAttribute('data-trikaal-off');
  const guard = (css) => { const st = document.createElement('style'); st.dataset.p9 = '1'; st.textContent = css; document.head.appendChild(st); return st; };
  const cleanup = () => {
    engine.disable(); F.disable(); T.theme.teardown();
    document.querySelectorAll('style[data-p9]').forEach((e) => e.remove());
    root.removeAttribute('data-trikaal-off');
    document.body.style.cssText = ''; document.body.querySelectorAll('[data-p9]').forEach((e) => e.remove());
    F.isTopFrame = () => true; F.config.engine = 'rewrite'; F.config.debounceMs = 25; F.config.minEvalGapMs = 0; F.config.settleMs = 60; F.config.revealMs = 900;
    window.chrome = createMockChrome();
  };

  test('guard on the page: body is hidden on a dark canvas until the page is told to reveal it', () => {
    cleanup();
    guard(forcedCss);
    assert.equal(opacity(), '0');
    assert.equal(getComputedStyle(root).colorScheme, 'dark');
    assert.equal(getComputedStyle(root).backgroundColor, 'rgb(24, 24, 24)');
    assert.equal(getComputedStyle(root).getPropertyValue('--trikaal-early').trim(), '1');
    T.util.endEarly();
    assert.ok(off());
    assert.equal(opacity(), '1', 'revealed');
    assert.equal(getComputedStyle(root).backgroundColor, 'rgba(0, 0, 0, 0)', 'the canvas override is released too');
    cleanup();
  });
  test('guard safety net: even if nothing ever reveals the page, CSS alone shows it after ~1.2 s', async () => {
    cleanup();
    guard(forcedCss);
    assert.equal(opacity(), '0');
    await sleep(1500);
    assert.equal(opacity(), '1', 'the body must never stay hidden');
    assert.equal(off(), false, 'and it did so without any script');
    cleanup();
  });
  test('endEarly does nothing on pages that have no guard (no stray attribute in Light)', () => {
    cleanup();
    T.util.endEarly();
    assert.equal(off(), false);
    assert.equal(document.querySelectorAll('[data-trikaal-off]').length, 0);
    cleanup();
  });
  test('endEarly is idempotent and safe without a document element', () => {
    cleanup();
    guard(forcedCss);
    T.util.endEarly(); T.util.endEarly(); T.util.endEarly();
    assert.ok(off());
    cleanup();
  });
  test('mode Light reveals immediately (a stale guard must not hide a Light page)', () => {
    cleanup();
    guard(forcedCss);
    T.theme.apply('light');
    assert.ok(off());
    assert.equal(opacity(), '1');
    cleanup();
  });
  test('Forced Dark reveals only after the recolour engine has installed and drained its first queue', async () => {
    cleanup();
    document.body.style.background = '#fff';
    guard(forcedCss);
    const order = [];
    const mo = new MutationObserver(() => {
      if (root.hasAttribute('data-trikaal-off') && !order.length) order.push({ base: !!document.getElementById('trikaal-rw-base'), idle: !engine._busy });
    });
    mo.observe(root, { attributes: true, attributeFilter: ['data-trikaal-off'] });
    F.enable();
    assert.equal(opacity(), '0', 'still hidden right after enable()');
    for (let i = 0; i < 100 && !off(); i++) await sleep(20);
    await sleep(20);
    mo.disconnect();
    assert.ok(off(), 'revealed');
    assert.ok(order.length === 1 && order[0].base, 'engine base style existed when the page was revealed: ' + JSON.stringify(order));
    assert.equal(opacity(), '1');
    cleanup();
  });
  test('Forced Dark on an already-dark page reveals right away and applies nothing', async () => {
    cleanup();
    document.body.style.background = '#0d1117';
    guard(forcedCss);
    F.enable();
    for (let i = 0; i < 50 && !off(); i++) await sleep(10);
    assert.ok(off());
    assert.equal(F.isForcing(), false);
    assert.equal(document.querySelectorAll('#trikaal-rw-base, #trikaal-forced-style').length, 0);
    cleanup();
  });
  test('Forced Dark with a stuck engine still reveals after revealMs (does not wait forever)', async () => {
    cleanup();
    document.body.style.background = '#fff';
    guard(forcedCss);
    F.config.revealMs = 150;
    const real = engine.whenIdle;
    engine.whenIdle = () => new Promise(() => {}); // never resolves
    try {
      F.enable();
      assert.equal(off(), false);
      for (let i = 0; i < 60 && !off(); i++) await sleep(10);
      assert.ok(off(), 'the timer backstop revealed the page');
    } finally { engine.whenIdle = real; }
    cleanup();
  });
  test('Forced Dark in an unsupported frame (filter engine in an iframe) reveals instead of hiding forever', () => {
    cleanup();
    guard(forcedCss);
    F.config.engine = 'filter';
    F.isTopFrame = () => false;
    F.enable();
    assert.ok(off());
    cleanup();
  });
  test('switching Forced -> Light while the guard is up leaves the page visible and clean', async () => {
    cleanup();
    document.body.style.background = '#fff';
    guard(forcedCss);
    T.theme.apply('forced');
    T.theme.apply('light');
    assert.ok(off());
    await sleep(100);
    assert.equal(document.querySelectorAll('#trikaal-rw-base, #trikaal-forced-style, #trikaal-style, [data-trikaal-i]').length, 0);
    assert.equal(opacity(), '1');
    cleanup();
  });
  test('rapid mode flapping with the guard present always ends visible', async () => {
    cleanup();
    document.body.style.background = '#fff';
    guard(forcedCss);
    for (let i = 0; i < 30; i++) T.theme.apply(['forced', 'light'][i % 2]);
    await sleep(1100);
    assert.equal(opacity(), '1');
    cleanup();
  });
  test('detection is not fooled by the guard: a LIGHT page is still forced while <html> is painted dark', async () => {
    cleanup();
    document.body.style.background = '#fff';
    guard(forcedCss);
    assert.equal(getComputedStyle(root).backgroundColor, 'rgb(24, 24, 24)', 'precondition: the guard paints <html> dark');
    F.enable();
    assert.equal(F.lastVerdict.dark, false, 'verdict must describe the page, not our guard: ' + JSON.stringify(F.lastVerdict));
    assert.equal(F.isForcing(), true);
    assert.equal(T.detect.cachedVerdict(location.hostname) === 'dark', false, 'no wrong "dark" verdict was remembered');
    for (let i = 0; i < 100 && !off(); i++) await sleep(20);
    assert.ok(document.getElementById('trikaal-rw-base'));
    cleanup();
  });
  test('measurement leaves the guard exactly as it was (on stays on, off stays off)', async () => {
    cleanup();
    document.body.style.background = '#fff';
    guard(forcedCss);
    const attrChanges = [];
    const mo = new MutationObserver((r) => r.forEach((x) => attrChanges.push(x.attributeName)));
    F.enable();
    await sleep(10);
    mo.observe(root, { attributes: true });
    F.evaluateNow(); // while the guard may still be up
    await sleep(10);
    mo.disconnect();
    for (let i = 0; i < 100 && !off(); i++) await sleep(20);
    assert.ok(off(), 'ended through the normal reveal');
    F.evaluateNow(); await sleep(20);
    assert.ok(off(), 'a later measurement does not bring the guard back');
    cleanup();
  });
  test('e2e (mock storage): controller + guard: stored Forced Dark themes the page and reveals it', async () => {
    cleanup();
    document.body.style.background = '#fff';
    const c = (window.chrome = createMockChrome());
    await c.storage.sync.set({ trikaal: { defaultMode: 'forced' } });
    guard(forcedCss);
    const k = T.createController({ host: 'x.com', log: () => {}, os: { isDark: () => false, onChange: () => () => {} }, onSettings: (s) => F.configure({ engine: s.forcedEngine, adjust: s.forcedAdjust }), apply: (m) => T.theme.apply(m) });
    await k.start();
    for (let i = 0; i < 100 && !off(); i++) await sleep(20);
    assert.ok(off());
    assert.ok(document.getElementById('trikaal-rw-base'));
    k.stop();
    cleanup();
  });
})();
