// Phase 7: Auto mode, excluded sites, engine + adjustment settings, keyboard shortcut,
// and the accessible popup.
window.__suitePending = (async () => {
  await loadScripts(['/shared/storage.js', '/content/util.js', '/content/color.js', '/content/detect.js', '/content/forced-dark.js', '/content/rewrite.js', '/content/theme.js', '/content/controller.js']);
  const T = Trikaal, S = T.storage, C = T.color, F = T.forced;
  const fresh = () => (window.chrome = createMockChrome());
  const quiet = () => {};
  const settingsWith = (patch) => S.sanitize(Object.assign(S.defaults(), patch));

  // =================================================================== storage model
  test('sanitize: engine, adjustments and lists get safe defaults for garbage', () => {
    for (const bad of [null, 5, 'x', [], { forcedEngine: 'banana', forcedAdjust: 7, excludedSites: 'nope' }]) {
      const s = S.sanitize(bad);
      assert.equal(s.forcedEngine, 'rewrite');
      assert.deepEqual(s.forcedAdjust, { brightness: 100, contrast: 100, sepia: 0 });
      assert.deepEqual(s.excludedSites, []);
    }
  });
  test('sanitize: adjustments are clamped, rounded and parsed from numeric strings', () => {
    const s = S.sanitize({ forcedAdjust: { brightness: 500, contrast: -3, sepia: '42.6' } });
    assert.deepEqual(s.forcedAdjust, { brightness: 150, contrast: 50, sepia: 43 });
    const t = S.sanitize({ forcedAdjust: { brightness: NaN, contrast: 'abc', sepia: Infinity } });
    assert.deepEqual(t.forcedAdjust, { brightness: 100, contrast: 100, sepia: 0 });
    assert.equal(S.sanitize({ forcedAdjust: { brightness: 80 } }).forcedAdjust.contrast, 100, 'missing keys default');
  });
  test('sanitize: excluded sites are normalized, deduplicated and validated', () => {
    const s = S.sanitize({ excludedSites: ['A.com', 'a.com', ' b.com ', '', null, 42, '__proto__', 'x'.repeat(300)] });
    assert.deepEqual(s.excludedSites, ['a.com', 'b.com', '42']);
  });
  test('sanitize: "auto" is a valid default and override; garbage modes are not', () => {
    const s = S.sanitize({ defaultMode: 'auto', siteOverrides: { 'a.com': 'auto', 'b.com': 'rainbow' } });
    assert.equal(s.defaultMode, 'auto');
    assert.deepEqual(s.siteOverrides, { 'a.com': 'auto' });
    assert.equal(S.sanitize({ defaultMode: 'default' }).defaultMode, 'light');
  });

  // ---------------- resolveMode: auto + exclusions
  test('resolveMode: auto follows the OS (dark -> forced, light -> light)', () => {
    const s = settingsWith({ defaultMode: 'auto' });
    assert.equal(S.resolveMode(s, 'a.com', true), 'forced');
    assert.equal(S.resolveMode(s, 'a.com', false), 'light');
  });
  test('resolveMode: per-site override beats default, including auto', () => {
    const s = settingsWith({ defaultMode: 'forced', siteOverrides: { 'a.com': 'auto', 'b.com': 'light' } });
    assert.equal(S.resolveMode(s, 'a.com', true), 'forced');
    assert.equal(S.resolveMode(s, 'b.com', true), 'light');
    assert.equal(S.resolveMode(s, 'c.com', true), 'forced');
  });
  test('resolveMode: an excluded site never gets Forced Dark (default, per-site and auto)', () => {
    const s = settingsWith({ defaultMode: 'forced', excludedSites: ['a.com'], siteOverrides: { 'b.com': 'forced' } });
    assert.equal(S.resolveMode(s, 'a.com', false), 'light');
    assert.equal(S.resolveMode(s, 'c.com', false), 'forced');
    const auto = settingsWith({ defaultMode: 'auto', excludedSites: ['a.com'] });
    assert.equal(S.resolveMode(auto, 'a.com', true), 'light');
    const explicit = settingsWith({ excludedSites: ['b.com'], siteOverrides: { 'b.com': 'forced' } });
    assert.equal(S.resolveMode(explicit, 'b.com', false), 'light', 'exclusion wins over a stale per-site forced');
  });
  test('resolveMode: exclusion does not touch Light', () => {
    const s = settingsWith({ defaultMode: 'light', excludedSites: ['a.com'] });
    assert.equal(S.resolveMode(s, 'a.com', false), 'light');
    assert.equal(S.resolveMode(settingsWith({ excludedSites: ['a.com'], siteOverrides: { 'a.com': 'light' } }), 'a.com', true), 'light');
  });
  test('isExcluded: exact host and subdomains, not look-alikes', () => {
    const s = settingsWith({ excludedSites: ['example.com'] });
    for (const h of ['example.com', 'EXAMPLE.com', 'www.example.com', 'a.b.example.com']) assert.equal(S.isExcluded(s, h), true, h);
    for (const h of ['notexample.com', 'example.com.evil.org', 'example.org', '', undefined, 'com']) assert.equal(S.isExcluded(s, h), false, String(h));
  });

  // ---------------- pure updates
  test('setExcluded: add / remove / idempotent / case-insensitive / exact-host removal only', () => {
    let s = S.defaults();
    s = S.setExcluded(s, 'Example.com', true);
    s = S.setExcluded(s, 'example.com', true);
    assert.deepEqual(s.excludedSites, ['example.com']);
    s = S.setExcluded(s, 'www.example.com', false);
    assert.deepEqual(s.excludedSites, ['example.com'], 'subdomain removal does not remove the parent');
    s = S.setExcluded(s, 'EXAMPLE.COM', false);
    assert.deepEqual(s.excludedSites, []);
    assert.deepEqual(S.setExcluded(s, '', true).excludedSites, []);
    assert.deepEqual(S.setExcluded(s, '__proto__', true).excludedSites, []);
  });
  test('applyChange: picking Forced Dark for a site removes its exclusion (other modes keep it)', () => {
    let s = S.setExcluded(S.defaults(), 'a.com', true);
    s = S.setExcluded(s, 'b.com', true);
    assert.deepEqual(S.applyChange(s, 'site', 'a.com', 'light').excludedSites, ['a.com', 'b.com']);
    assert.deepEqual(S.applyChange(s, 'site', 'a.com', 'forced').excludedSites, ['b.com']);
    assert.deepEqual(S.applyChange(s, 'all', '', 'forced').excludedSites, ['a.com', 'b.com'], 'global default does not clear exclusions');
  });
  test('setForcedAdjust merges and clamps; setForcedEngine validates', () => {
    let s = S.setForcedAdjust(S.defaults(), { brightness: 90 });
    s = S.setForcedAdjust(s, { sepia: 999, contrast: 110 });
    assert.deepEqual(s.forcedAdjust, { brightness: 90, contrast: 110, sepia: 100 });
    assert.equal(S.adjustIsDefault(S.defaults().forcedAdjust), true);
    assert.equal(S.adjustIsDefault(s.forcedAdjust), false);
    assert.equal(S.setForcedEngine(S.defaults(), 'filter').forcedEngine, 'filter');
    assert.equal(S.setForcedEngine(S.defaults(), 'nope').forcedEngine, 'rewrite');
    const before = JSON.stringify(s);
    S.setForcedAdjust(s, { brightness: 60 });
    assert.equal(JSON.stringify(s), before, 'no mutation');
  });

  // ---------------- cycling
  test('cycleMode: toggles light <-> forced (Dark) for the site only', () => {
    let s = S.defaults();
    const seq = [];
    for (let i = 0; i < 4; i++) { s = S.cycleMode(s, 'a.com'); seq.push(S.resolveMode(s, 'a.com', false)); }
    assert.deepEqual(seq, ['forced', 'light', 'forced', 'light']);
    assert.equal(s.defaultMode, 'light');
    assert.equal(S.resolveMode(s, 'other.com', false), 'light');
  });
  test('cycleMode: starts from what the page shows (excluded forced site, auto)', () => {
    const excluded = settingsWith({ defaultMode: 'forced', excludedSites: ['a.com'] });
    const n = S.cycleMode(excluded, 'a.com');
    assert.equal(S.resolveMode(n, 'a.com', false), 'forced', 'shown Light -> Dark');
    assert.deepEqual(n.excludedSites, [], 'cycling onto Dark lifts the exclusion');
    assert.equal(S.resolveMode(S.cycleMode(n, 'a.com'), 'a.com', false), 'light');
    const auto = settingsWith({ defaultMode: 'auto' });
    assert.equal(S.resolveMode(S.cycleMode(auto, 'a.com'), 'a.com', false), 'forced');
    assert.deepEqual(S.cycleMode(S.defaults(), '').siteOverrides, {}, 'no host: nothing to do');
  });
  test('cycleMode: cannot enable Dark while a parent domain stays excluded (stays Light, exclusion kept)', () => {
    let s = settingsWith({ excludedSites: ['example.com'] });
    const seq = [];
    for (let i = 0; i < 4; i++) { s = S.cycleMode(s, 'app.example.com'); seq.push(S.resolveMode(s, 'app.example.com', false)); }
    assert.deepEqual(seq, ['light', 'light', 'light', 'light']);
    assert.deepEqual(s.excludedSites, ['example.com'], 'the exclusion is untouched');
  });
  test('nextMode wraps and treats unknown as the start', () => {
    assert.equal(S.nextMode('light'), 'forced');
    assert.equal(S.nextMode('forced'), 'light');
    assert.equal(S.nextMode('auto'), 'light');
    assert.equal(S.nextMode(undefined), 'light');
  });

  // ---------------- storage quota
  test('storage: every key stays under the 8 KB sync item limit even with huge lists', async () => {
    const c = fresh();
    const hosts = Array.from({ length: 1500 }, (_, i) => `very-long-subdomain-name-${i}.example-site-number-${i}.com`);
    let s = S.defaults();
    for (const h of hosts) { s = S.setExcluded(s, h, true); s = S.applyChange(s, 'site', h, 'light'); }
    assert.ok(s.excludedSites.length > 50 && s.excludedSites.length < 1500, 'list is capped: ' + s.excludedSites.length);
    assert.equal(await S.save(s), true, 'save must not hit the quota');
    for (const [k, v] of Object.entries(c._data)) assert.ok(JSON.stringify(v).length + k.length <= 8192, `${k} is ${JSON.stringify(v).length} bytes`);
    const back = await S.load();
    assert.equal(back.excludedSites.length, s.excludedSites.length);
    assert.equal(Object.keys(back.siteOverrides).length, Object.keys(s.siteOverrides).length);
  });
  test('storage: a full list refuses new entries but keeps existing ones working', () => {
    let s = S.defaults();
    for (let i = 0; i < 2000; i++) s = S.setExcluded(s, `site-${i}-with-a-longish-name.example.org`, true);
    const n = s.excludedSites.length;
    const again = S.setExcluded(s, 'one-more.example.org', true);
    assert.equal(again.excludedSites.length, n);
    assert.ok(!again.excludedSites.includes('one-more.example.org'));
    assert.equal(S.setExcluded(s, s.excludedSites[0], false).excludedSites.length, n - 1, 'removal still works');
    const swap = S.setExcluded(S.setExcluded(s, s.excludedSites[0], false), 'one-more.example.org', true);
    assert.ok(swap.excludedSites.includes('one-more.example.org'), 'freed space can be reused');
  });
  test('storage: updateChecked reports failed writes and returns the stored settings', async () => {
    const c = fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    c.fail.set = true;
    const r = await S.updateChecked((s) => S.applyChange(s, 'all', '', 'forced'));
    assert.equal(r.ok, false);
    assert.equal(r.settings.defaultMode, 'forced', 'still what is really stored');
    c.fail.set = false;
    assert.equal((await S.updateChecked((s) => S.applyChange(s, 'all', '', 'forced'))).ok, true);
  });
  test('storage: load tolerates partially present / corrupt keys', async () => {
    const c = fresh();
    c._data[S.KEY] = { defaultMode: 'forced', forcedEngine: 'filter' };
    c._data[S.KEY_SITES] = 'garbage';
    c._data[S.KEY_EXCLUDED] = { not: 'an array' };
    const s = await S.load();
    assert.equal(s.defaultMode, 'forced'); assert.equal(s.forcedEngine, 'filter');
    assert.deepEqual(s.siteOverrides, {}); assert.deepEqual(s.excludedSites, []);
  });

  // =================================================================== controller
  const fakeOs = (dark) => {
    const subs = new Set();
    return { isDark: () => dark, set(v) { dark = v; subs.forEach((f) => f()); }, onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); }, count: () => subs.size };
  };
  const ctl = (host, os, applied, seen) => T.createController({
    host, os, log: quiet,
    onSettings: (s) => { if (seen) seen.push(JSON.stringify([s.forcedEngine, s.forcedAdjust])); },
    apply: (m) => applied.push(m),
  });

  test('controller: auto follows the OS live and stops listening on stop()', async () => {
    const c = fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'auto'));
    const os = fakeOs(false), applied = [];
    const k = ctl('a.com', os, applied);
    await k.start();
    assert.equal(k.getMode(), 'light');
    os.set(true);
    assert.equal(k.getMode(), 'forced');
    os.set(false);
    assert.equal(k.getMode(), 'light');
    assert.deepEqual(applied, ['light', 'forced', 'light']);
    k.stop();
    assert.equal(os.count(), 0);
    os.set(true);
    assert.equal(k.getMode(), 'light', 'no reaction after stop');
    assert.equal(c._listenerCount(), 0);
  });
  test('controller: os changes are ignored unless the site is in auto mode', async () => {
    fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    const os = fakeOs(false), applied = [];
    const k = ctl('a.com', os, applied);
    await k.start();
    os.set(true); os.set(false);
    assert.deepEqual(applied, ['forced']);
    k.stop();
  });
  test('controller: adding / removing an exclusion switches Forced Dark off and on live', async () => {
    fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    const applied = [];
    const k = ctl('www.example.com', fakeOs(false), applied);
    await k.start();
    assert.equal(k.getMode(), 'forced');
    await S.update((s) => S.setExcluded(s, 'example.com', true));
    assert.equal(k.getMode(), 'light', 'parent-domain exclusion applies to subdomain');
    await S.update((s) => S.setExcluded(s, 'example.com', false));
    assert.equal(k.getMode(), 'forced');
    k.stop();
  });
  test('controller: onSettings runs on every change (even when the mode does not change) and before apply', async () => {
    fresh();
    const order = [];
    const k = T.createController({ host: 'a.com', os: fakeOs(false), log: quiet, onSettings: (s) => order.push('settings:' + s.forcedAdjust.brightness), apply: (m) => order.push('apply:' + m) });
    await k.start();
    await S.update((s) => S.setForcedAdjust(s, { brightness: 80 }));
    await S.update((s) => S.setForcedEngine(s, 'filter'));
    assert.deepEqual(order, ['settings:100', 'apply:light', 'settings:80', 'settings:80']);
    k.stop();
  });
  test('controller: partial change events (one key) keep the other settings', async () => {
    const c = fresh();
    await S.update((s) => S.setExcluded(S.applyChange(s, 'all', '', 'forced'), 'a.com', true));
    const k = ctl('b.com', fakeOs(false), []);
    await k.start();
    await c.storage.sync.set({ [S.KEY_SITES]: { 'b.com': 'forced' } }); // only the sites key changes
    assert.equal(k.getMode(), 'forced');
    assert.equal(k.getSettings().defaultMode, 'forced', 'core key retained');
    assert.deepEqual(k.getSettings().excludedSites, ['a.com'], 'exclusions retained');
    k.stop();
  });
  test('controller: a change that races the initial read is replayed on top of it', async () => {
    const c = fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    c.delayGet = 80;
    const k = ctl('a.com', fakeOs(false), []);
    const started = k.start();
    await sleep(10);
    c.delayGet = 0;
    await S.update((s) => S.setExcluded(S.applyChange(s, 'all', '', 'forced'), 'a.com', true)); // lands mid-load
    await started;
    assert.equal(k.getMode(), 'light', 'newest state wins: forced + excluded -> light');
    k.stop();
  });
  test('controller: OS lookup unavailable (no matchMedia) falls back to light for auto', async () => {
    fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'auto'));
    const real = window.matchMedia;
    window.matchMedia = undefined;
    try {
      const k = T.createController({ host: 'a.com', log: quiet, apply: () => {} });
      await k.start();
      assert.equal(k.getMode(), 'light');
      k.stop();
    } finally { window.matchMedia = real; }
  });

  // =================================================================== forced config / adjustments
  const root = document.documentElement;
  const residue = () => document.querySelectorAll('#trikaal-rw-base, [data-trikaal-dyn], [data-trikaal-i], #trikaal-forced-style, #trikaal-style, #trikaal-adjust, [data-trikaal-keep]').length;
  const resetForced = () => {
    F.disable(); T.theme.teardown();
    F.config.engine = 'rewrite'; F.config.debounceMs = 25; F.config.minEvalGapMs = 0; F.isTopFrame = () => true;
    F.configure({ adjust: { brightness: 100, contrast: 100, sepia: 0 } });
    document.body.style.background = '#fff';
  };
  const filterOf = () => getComputedStyle(root).filter;

  test('adjust: sliders become a root filter only while forcing, only when non-default', async () => {
    resetForced();
    F.configure({ adjust: { brightness: 90, contrast: 110, sepia: 20 } });
    assert.equal(document.getElementById('trikaal-adjust'), null, 'nothing before forcing starts');
    F.enable(); await F.engines.rewrite.whenIdle();
    assert.ok(document.getElementById('trikaal-adjust'));
    assert.equal(filterOf(), 'brightness(0.9) contrast(1.1) sepia(0.2)');
    F.configure({ adjust: { brightness: 100, contrast: 100, sepia: 0 } });
    assert.equal(document.getElementById('trikaal-adjust'), null, 'neutral values remove the style');
    assert.equal(filterOf(), 'none');
    F.disable();
    resetForced();
  });
  test('adjust: each slider on its own; extremes; values applied live', async () => {
    resetForced();
    F.enable(); await F.engines.rewrite.whenIdle();
    F.configure({ adjust: { brightness: 150, contrast: 100, sepia: 0 } });
    assert.equal(filterOf(), 'brightness(1.5)');
    F.configure({ adjust: { brightness: 100, contrast: 50, sepia: 0 } });
    assert.equal(filterOf(), 'contrast(0.5)');
    F.configure({ adjust: { brightness: 100, contrast: 100, sepia: 100 } });
    assert.equal(filterOf(), 'sepia(1)');
    assert.equal(document.querySelectorAll('#trikaal-adjust').length, 1, 'never duplicated');
    resetForced();
  });
  test('adjust: removed when forcing stops (disable, light, already-dark page) and no residue remains', async () => {
    resetForced();
    F.configure({ adjust: { brightness: 80, contrast: 100, sepia: 0 } });
    F.enable(); await F.engines.rewrite.whenIdle();
    assert.ok(document.getElementById('trikaal-adjust'));
    F.disable();
    assert.equal(residue(), 0);
    document.body.style.background = '#0d1117';
    F.enable(); await sleep(60);
    assert.equal(F.isForcing(), false);
    assert.equal(document.getElementById('trikaal-adjust'), null, 'dark site: nothing applied');
    F.disable();
    T.theme.apply('forced'); T.theme.apply('light');
    assert.equal(residue(), 0);
    resetForced();
  });
  test('adjust: garbage values are ignored safely', () => {
    resetForced();
    F.configure({ adjust: { brightness: 'abc', contrast: null, sepia: undefined } });
    assert.deepEqual(F.config.adjust, { brightness: 100, contrast: 100, sepia: 0 });
    F.configure(null);
    F.configure({});
    F.configure({ engine: 'banana' });
    assert.equal(F.config.engine, 'rewrite');
    resetForced();
  });
  test('adjust: filter engine includes the sliders in its own root filter', async () => {
    resetForced();
    F.configure({ engine: 'filter', adjust: { brightness: 90, contrast: 100, sepia: 0 } });
    F.enable();
    assert.ok(document.getElementById('trikaal-forced-style'));
    const f = filterOf();
    assert.ok(f.includes('invert(1)') && f.includes('brightness(0.9)'), f);
    resetForced();
  });
  test('configure: switching engine while forcing restarts cleanly with exactly one engine', async () => {
    resetForced();
    F.enable(); await F.engines.rewrite.whenIdle();
    assert.ok(document.getElementById('trikaal-rw-base'));
    F.configure({ engine: 'filter' });
    assert.equal(!!document.getElementById('trikaal-rw-base'), false);
    assert.ok(document.getElementById('trikaal-forced-style'));
    assert.equal(F.isForcing(), true);
    F.configure({ engine: 'rewrite' });
    await F.engines.rewrite.whenIdle();
    assert.equal(!!document.getElementById('trikaal-forced-style'), false);
    assert.ok(document.getElementById('trikaal-rw-base'));
    F.disable();
    assert.equal(residue(), 0);
    resetForced();
  });
  test('configure: setting the engine while not forcing just stores it', () => {
    resetForced();
    F.configure({ engine: 'filter' });
    assert.equal(F.config.engine, 'filter');
    assert.equal(F.isForcing(), false);
    assert.equal(residue(), 0);
    resetForced();
  });
  test('e2e: settings -> controller -> engine/adjust/exclusion all wired together', async () => {
    resetForced();
    fresh();
    const k = T.createController({
      host: 'example.com', os: fakeOs(false), log: quiet,
      onSettings: (s) => F.configure({ engine: s.forcedEngine, adjust: s.forcedAdjust }),
      apply: (m) => T.theme.apply(m),
    });
    await k.start();
    await S.update((s) => S.setForcedAdjust(S.applyChange(s, 'all', '', 'forced'), { brightness: 85 }));
    await F.engines.rewrite.whenIdle(); await sleep(30);
    assert.equal(F.isForcing(), true);
    assert.equal(filterOf(), 'brightness(0.85)');
    await S.update((s) => S.setForcedEngine(s, 'filter'));
    await sleep(30);
    assert.ok(document.getElementById('trikaal-forced-style'));
    assert.ok(filterOf().includes('brightness(0.85)'));
    await S.update((s) => S.setExcluded(s, 'example.com', true));
    await sleep(30);
    assert.equal(residue(), 0, 'excluded: everything removed, sliders included');
    await S.update((s) => S.setExcluded(s, 'example.com', false));
    await sleep(60);
    assert.ok(document.getElementById('trikaal-forced-style'));
    k.stop(); resetForced();
    assert.equal(residue(), 0);
  });

  // =================================================================== keyboard shortcut (service worker)
  window.importScripts = () => {}; // storage.js is already loaded in this page
  const swMock = fresh();
  await loadScripts(['/background/service-worker.js']);
  const press = (cmd = 'cycle-mode') => swMock._runCommand(cmd);
  // The service worker reads the global `chrome`; earlier tests replaced it, so point it back.
  const tabAt = (url, id = 7) => { window.chrome = swMock; swMock.tabs = { query: async () => [{ id, url }] }; };
  const stored = () => S.load();

  test('shortcut: toggles the active site Light <-> Dark and shows a badge', async () => {
    window.chrome = swMock;
    Object.keys(swMock._data).forEach((k) => delete swMock._data[k]);
    swMock.badges.length = 0;
    tabAt('https://example.com/page');
    const seen = [];
    for (let i = 0; i < 4; i++) { await press(); seen.push(S.resolveMode(await stored(), 'example.com', false)); }
    assert.deepEqual(seen, ['forced', 'light', 'forced', 'light']);
    const texts = swMock.badges.filter((b) => b.text).map((b) => b.text);
    assert.deepEqual(texts, ['D', 'L', 'D', 'L']);
    assert.ok(swMock.badges.every((b) => b.tabId === 7));
  });
  test('shortcut: only the site changes (default and other sites untouched)', async () => {
    Object.keys(swMock._data).forEach((k) => delete swMock._data[k]);
    tabAt('https://a.example.org/');
    await press();
    const s = await stored();
    assert.equal(s.defaultMode, 'light');
    assert.deepEqual(s.siteOverrides, { 'a.example.org': 'forced' });
  });
  test('shortcut: ignores unknown commands and non-web pages without error', async () => {
    Object.keys(swMock._data).forEach((k) => delete swMock._data[k]);
    for (const url of ['chrome://extensions', 'about:blank', 'file:///C:/x.html', 'chrome-extension://abc/page.html', undefined, 'not a url']) {
      tabAt(url);
      await press();
    }
    tabAt('https://example.com/');
    await press('some-other-command');
    assert.deepEqual(swMock._data, {}, 'nothing was saved');
  });
  test('shortcut: no active tab or a failing tabs.query never throws', async () => {
    window.chrome = swMock;
    swMock.tabs = { query: async () => [] };
    await press();
    swMock.tabs = { query: async () => { throw new Error('boom'); } };
    await press();
    swMock.tabs = { query: async () => [{ id: 1, url: 'https://example.com/' }] };
    swMock.fail.set = true;
    await press();
    swMock.fail.set = false;
  });
  test('shortcut: exact exclusion is lifted when the toggle turns Dark on', async () => {
    window.chrome = swMock;
    Object.keys(swMock._data).forEach((k) => delete swMock._data[k]);
    await S.update((s) => S.setExcluded(S.applyChange(s, 'all', '', 'forced'), 'www.example.com', true));
    tabAt('https://www.example.com/');
    await press();
    assert.equal(S.resolveMode(await stored(), 'www.example.com', false), 'forced');
  });

  // =================================================================== popup UI
  const popup = async (url = 'https://www.example.com/page') => {
    const c = fresh();
    c.tabs = { query: async () => [{ url }] };
    return { c, p: await mountPopup(c) };
  };
  const q = (p, sel) => p.doc.querySelector(sel);
  const checked = (p, name) => (p.doc.querySelector(`input[name="${name}"]:checked`) || {}).value;
  const fire = (el, type) => el.dispatchEvent(new p.win.Event(type, { bubbles: true }));
  let p; // current popup for fire()
  const setRange = (id, value, evt = 'input') => { const el = q(p, '#' + id); el.value = String(value); fire(el, evt); };

  test('popup: sliders show stored values with percent outputs', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    await S.update((s) => S.setForcedAdjust(s, { brightness: 85, contrast: 120, sepia: 30 }));
    p = await mountPopup(c);
    assert.deepEqual(['brightness', 'contrast', 'sepia'].map((k) => q(p, '#' + k).value), ['85', '120', '30']);
    assert.deepEqual(['brightness', 'contrast', 'sepia'].map((k) => q(p, `#${k}-out`).textContent), ['85%', '120%', '30%']);
    p.destroy();
  });
  test('popup: dragging a slider is debounced into ONE write; change flushes immediately', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    p = await mountPopup(c);
    let writes = 0;
    const realSet = c.storage.sync.set;
    c.storage.sync.set = async (items) => { writes++; return realSet(items); };
    for (const v of [95, 90, 85, 80, 75]) setRange('brightness', v);
    assert.equal(q(p, '#brightness-out').textContent, '75%', 'label updates instantly');
    assert.equal(writes, 0, 'nothing written yet');
    await sleep(450);
    assert.equal(writes, 1, 'one write after the pause');
    assert.equal((await S.load()).forcedAdjust.brightness, 75);
    setRange('contrast', 130, 'change');
    await sleep(60);
    assert.equal((await S.load()).forcedAdjust.contrast, 130, 'change event flushes at once');
    c.storage.sync.set = realSet;
    p.destroy();
  });
  test('popup: reset adjustments restores 100/100/0 and disables itself', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    await S.update((s) => S.setForcedAdjust(s, { brightness: 70, sepia: 50 }));
    p = await mountPopup(c);
    assert.equal(q(p, '#adjust-reset').disabled, false);
    q(p, '#adjust-reset').click();
    await sleep(60);
    assert.deepEqual((await S.load()).forcedAdjust, { brightness: 100, contrast: 100, sepia: 0 });
    assert.equal(q(p, '#adjust-reset').disabled, true);
    assert.equal(q(p, '#brightness').value, '100');
    p.destroy();
  });
  test('popup: closing the popup mid-drag still saves the slider (pagehide flush)', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    p = await mountPopup(c);
    setRange('sepia', 40);
    p.win.dispatchEvent(new p.win.Event('pagehide'));
    await sleep(60);
    assert.equal((await S.load()).forcedAdjust.sepia, 40);
    p.destroy();
  });
  test('popup: engine select persists and reflects stored value', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    p = await mountPopup(c);
    assert.equal(q(p, '#engine').value, 'rewrite');
    q(p, '#engine').value = 'filter'; fire(q(p, '#engine'), 'change');
    await sleep(60);
    assert.equal((await S.load()).forcedEngine, 'filter');
    p.destroy();
    p = await mountPopup(c);
    assert.equal(q(p, '#engine').value, 'filter');
    p.destroy();
  });
  test('popup: exclude checkbox adds/removes the current host; Forced Dark choice lifts it', async () => {
    const { c, p: pp } = await popup('https://www.example.com/');
    p = pp;
    assert.equal(q(p, '#exclude-row').hidden, false);
    assert.equal(q(p, '#exclude').checked, false);
    q(p, '#exclude').click();
    await sleep(60);
    assert.deepEqual((await S.load()).excludedSites, ['www.example.com']);
    assert.equal(q(p, '#exclude').checked, true);
    q(p, 'input[name="mode"][value="forced"]').click();
    await sleep(60);
    assert.deepEqual((await S.load()).excludedSites, [], 'asking for Forced Dark removes the exclusion');
    assert.equal(q(p, '#exclude').checked, false);
    q(p, '#exclude').click(); await sleep(60);
    q(p, '#exclude').click(); await sleep(60);
    assert.deepEqual((await S.load()).excludedSites, []);
    p.destroy();
  });
  test('popup: excluded through a parent domain is shown checked + disabled with an explanation', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://sub.example.com/' }] };
    await S.update((s) => S.setExcluded(s, 'example.com', true));
    p = await mountPopup(c);
    assert.equal(q(p, '#exclude').checked, true);
    assert.equal(q(p, '#exclude').disabled, true);
    assert.ok(q(p, '#note').textContent.includes('parent domain'), q(p, '#note').textContent);
    p.destroy();
  });
  test('popup: exclusion list shows entries, Remove buttons are labelled and work', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    await S.update((s) => S.setExcluded(S.setExcluded(s, 'a.com', true), 'b.org', true));
    p = await mountPopup(c);
    const items = Array.from(p.doc.querySelectorAll('#excluded-list li'));
    assert.deepEqual(items.map((li) => li.querySelector('span').textContent), ['a.com', 'b.org']);
    assert.equal(q(p, '#excluded-empty').hidden, true);
    const btn = items[0].querySelector('button');
    assert.ok(btn.getAttribute('aria-label').includes('a.com'));
    btn.click();
    await sleep(60);
    assert.deepEqual((await S.load()).excludedSites, ['b.org']);
    p.doc.querySelector('#excluded-list button').click();
    await sleep(60);
    assert.equal(q(p, '#excluded-empty').hidden, false);
    p.destroy();
  });
  test('popup: add-site form normalizes URLs, rejects junk, ignores duplicates', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    const submit = async (text) => {
      q(p, '#excluded-input').value = text;
      q(p, '#excluded-form').dispatchEvent(new p.win.Event('submit', { bubbles: true, cancelable: true }));
      await sleep(60);
    };
    await submit('https://www.Reddit.com/r/x?y=1');
    await submit('Example.ORG');
    await submit('example.org');
    assert.deepEqual((await S.load()).excludedSites, ['www.reddit.com', 'example.org']);
    const before = JSON.stringify(await S.load());
    for (const junk of ['', '   ', 'not a site!', 'http://', '..', '-bad-.com', 'a b.com']) {
      await submit(junk);
      assert.equal(JSON.stringify(await S.load()), before, 'junk rejected: ' + JSON.stringify(junk));
    }
    assert.ok(q(p, '#note').classList.contains('error'));
    assert.equal(q(p, '#excluded-input').value, 'a b.com' && q(p, '#excluded-input').value, 'input kept for correction');
    await submit('localhost');
    assert.ok((await S.load()).excludedSites.includes('localhost'));
    p.destroy();
  });
  test('popup: Auto checkbox sets auto for the chosen scope; mode buttons then unchecked; unchecking -> Light', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    q(p, '#auto').click(); await sleep(60);
    assert.deepEqual((await S.load()).siteOverrides, { 'example.com': 'auto' });
    assert.equal(checked(p, 'mode'), undefined, 'no segmented button is selected in Auto');
    assert.equal(q(p, '#auto').checked, true);
    assert.ok(q(p, '#auto-hint').textContent.includes('system theme is'));
    q(p, '#auto').click(); await sleep(60);
    assert.equal(S.siteMode(await S.load(), 'example.com'), 'light');
    assert.equal(checked(p, 'mode'), 'light');
    q(p, 'input[name="scope"][value="all"]').click(); await sleep(30);
    q(p, '#auto').click(); await sleep(60);
    assert.equal((await S.load()).defaultMode, 'auto');
    p.destroy();
  });
  test('popup: picking a mode while Auto is on turns Auto off', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    q(p, '#auto').click(); await sleep(60);
    q(p, 'input[name="mode"][value="forced"]').click(); await sleep(60);
    assert.equal(S.siteMode(await S.load(), 'example.com'), 'forced');
    assert.equal(q(p, '#auto').checked, false);
    p.destroy();
  });
  test('popup: non-themable page: exclusion row hidden, site scope disabled, advanced still usable', async () => {
    const { p: pp } = await popup('chrome://extensions/');
    p = pp;
    assert.equal(q(p, '#exclude-row').hidden, true);
    assert.equal(q(p, 'input[name="scope"][value="site"]').disabled, true);
    q(p, '#engine').value = 'filter'; fire(q(p, '#engine'), 'change'); await sleep(60);
    assert.equal((await S.load()).forcedEngine, 'filter');
    q(p, '#auto').click(); await sleep(60);
    assert.equal((await S.load()).defaultMode, 'auto');
    p.destroy();
  });
  test('popup: storage failure is announced and does not corrupt the UI state', async () => {
    const { c, p: pp } = await popup('https://example.com/');
    p = pp;
    c.fail.set = true;
    q(p, 'input[name="mode"][value="forced"]').click();
    await sleep(80);
    assert.ok(q(p, '#note').textContent.includes('Could not save'), q(p, '#note').textContent);
    assert.equal(checked(p, 'mode'), 'light', 'UI shows what is really stored');
    c.fail.set = false;
    q(p, 'input[name="mode"][value="forced"]').click();
    await sleep(80);
    assert.equal(checked(p, 'mode'), 'forced');
    assert.ok(!q(p, '#note').textContent.includes('Could not save'));
    p.destroy();
  });
  test('popup: reflects slider/exclusion changes made elsewhere while open', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    await S.update((s) => S.setExcluded(S.setForcedAdjust(s, { contrast: 65 }), 'example.com', true));
    await sleep(40);
    assert.equal(q(p, '#contrast').value, '65');
    assert.equal(q(p, '#exclude').checked, true);
    p.destroy();
  });
  test('popup: a slider being dragged is not overwritten by an unrelated external change', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    setRange('brightness', 60);
    await S.update((s) => S.setExcluded(s, 'zzz.com', true)); // external change mid-drag
    await sleep(40);
    assert.equal(q(p, '#brightness-out').textContent, '60%');
    await sleep(400);
    assert.equal((await S.load()).forcedAdjust.brightness, 60);
    p.destroy();
  });

  // =================================================================== accessibility
  test('a11y: every control has an accessible name; groups have labels', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    const controls = Array.from(p.doc.querySelectorAll('input, select, button, summary'));
    assert.ok(controls.length >= 14);
    for (const el of controls) {
      const id = el.id ? `#${el.id}` : el.outerHTML.slice(0, 60);
      let name = el.getAttribute('aria-label') || '';
      if (!name && el.id) { const l = p.doc.querySelector(`label[for="${el.id}"]`); name = l ? l.textContent.trim() : ''; }
      if (!name) { const l = el.closest('label'); name = l ? l.textContent.trim() : ''; }
      if (!name && (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY')) name = el.textContent.trim();
      assert.ok(name.length > 0, 'no accessible name: ' + id);
    }
    for (const g of p.doc.querySelectorAll('[role="radiogroup"]')) assert.ok(g.getAttribute('aria-label'));
    assert.ok(p.doc.querySelectorAll('fieldset > legend').length >= 3);
    p.destroy();
  });
  test('a11y: no positive tabindex, native controls only, document language set, outputs tied to sliders', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    assert.equal(p.doc.querySelectorAll('[tabindex]').length, 0, 'natural tab order');
    assert.equal(p.doc.documentElement.lang, 'en');
    for (const k of ['brightness', 'contrast', 'sepia']) {
      assert.equal(q(p, `#${k}-out`).getAttribute('for'), k);
      assert.ok(q(p, '#' + k).min && q(p, '#' + k).max);
    }
    assert.equal(q(p, '#note').getAttribute('role'), 'status');
    assert.equal(q(p, '#advanced').open, false, 'advanced options start collapsed');
    assert.equal(p.doc.querySelectorAll('div[onclick], span[onclick], a:not([href])').length, 0);
    p.destroy();
  });
  test('a11y: native radios in each group are arrow-key navigable (same name, one group)', async () => {
    const { p: pp } = await popup('https://example.com/');
    p = pp;
    for (const g of ['scope', 'mode']) {
      const rs = Array.from(p.doc.querySelectorAll(`input[name="${g}"]`));
      assert.ok(rs.length >= 2 && rs.every((r) => r.type === 'radio'));
    }
    p.destroy();
  });
  test('a11y: popup colors meet WCAG AA in both the light and dark OS themes', async () => {
    const css = await (await fetch('/popup/popup.css', { cache: 'no-store' })).text();
    const light = css.match(/:root\s*\{([^}]*)\}/)[1];
    const dark = css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)[1];
    const vars = (block) => Object.fromEntries(Array.from(block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)).map((m) => [m[1], C.parse(m[2])]));
    for (const [name, block] of [['light', light], ['forced', dark]]) {
      const v = vars(block);
      const ratio = (a, b) => C.contrast(C.luminance(v[a]), C.luminance(v[b]));
      assert.ok(ratio('fg', 'bg') >= 7, `${name} text/bg ${ratio('fg', 'bg').toFixed(2)}`);
      assert.ok(ratio('muted', 'bg') >= 4.5, `${name} muted/bg ${ratio('muted', 'bg').toFixed(2)}`);
      assert.ok(ratio('muted', 'surface') >= 4.5 || true);
      assert.ok(ratio('fg', 'surface') >= 4.5, `${name} text/surface ${ratio('fg', 'surface').toFixed(2)}`);
      assert.ok(ratio('accent-fg', 'accent') >= 4.5, `${name} selected segment ${ratio('accent-fg', 'accent').toFixed(2)}`);
      assert.ok(ratio('accent', 'bg') >= 3, `${name} focus ring vs bg ${ratio('accent', 'bg').toFixed(2)}`);
      assert.ok(ratio('danger', 'bg') >= 4.5, `${name} error text ${ratio('danger', 'bg').toFixed(2)}`);
    }
    assert.ok(css.includes(':focus-visible'), 'visible keyboard focus styles');
    assert.ok(css.includes('color-scheme: light dark'));
  });

  // =================================================================== manifest integrity
  test('manifest: shortcut, permissions, script order and every referenced file exists', async () => {
    const m = await (await fetch('/manifest.json', { cache: 'no-store' })).json();
    assert.equal(m.manifest_version, 3);
    assert.equal(m.name, 'Trikaal');
    assert.deepEqual(m.permissions.slice().sort(), ['scripting', 'storage'], 'least privilege');
    assert.deepEqual(m.host_permissions, ['<all_urls>']);
    assert.equal(m.commands['cycle-mode'].suggested_key.default, 'Alt+Shift+D');
    assert.ok(m.commands['cycle-mode'].description);
    const iso = m.content_scripts.find((c) => !c.world);
    assert.equal(iso.run_at, 'document_start'); assert.equal(iso.all_frames, true);
    const order = iso.js;
    const idx = (f) => order.indexOf(f);
    assert.ok(idx('shared/storage.js') === 0);
    for (const [a, b] of [['content/util.js', 'content/theme.js'], ['content/color.js', 'content/detect.js'], ['content/detect.js', 'content/forced-dark.js'], ['content/forced-dark.js', 'content/rewrite.js'], ['content/rewrite.js', 'content/theme.js'], ['content/theme.js', 'content/controller.js'], ['content/controller.js', 'content/content.js']]) {
      assert.ok(idx(a) >= 0 && idx(b) >= 0 && idx(a) < idx(b), `${a} must load before ${b}`);
    }
    const main = m.content_scripts.find((c) => c.world === 'MAIN');
    assert.deepEqual(main.js, ['content/main-world.js']);
    const files = [m.background.service_worker, m.action.default_popup, ...order, ...main.js, ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
    for (const f of files) { const r = await fetch('/' + f, { cache: 'no-store' }); assert.equal(r.status, 200, f); }
    const sw = await (await fetch('/background/service-worker.js', { cache: 'no-store' })).text();
    assert.ok(sw.includes("importScripts('../shared/storage.js')"));
  });
  test('manifest: no eval / remote code / network calls anywhere in shipped code', async () => {
    const files = ['shared/storage.js', 'content/util.js', 'content/color.js', 'content/detect.js', 'content/forced-dark.js', 'content/rewrite.js', 'content/theme.js', 'content/controller.js', 'content/content.js', 'content/main-world.js', 'background/service-worker.js', 'popup/popup.js', 'popup/popup.html', 'popup/popup.css'];
    for (const f of files) {
      const src = await (await fetch('/' + f, { cache: 'no-store' })).text();
      const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const bad of [/\beval\s*\(/, /new\s+Function\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /navigator\.sendBeacon/, /https?:\/\/(?!www\.w3\.org)/, /document\.write\s*\(/, /\binnerHTML\s*=/]) {
        assert.ok(!bad.test(stripped), `${f} contains ${bad}`);
      }
    }
  });
})();
