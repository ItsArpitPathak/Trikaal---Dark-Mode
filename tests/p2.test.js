// Phase 2: storage module, controller (live updates) and popup UI.
window.__suitePending = (async () => {
  await loadScripts(['/shared/storage.js', '/content/controller.js']);
  const S = Trikaal.storage;
  const fresh = () => (window.chrome = createMockChrome());
  const quiet = () => {};

  // ---------- storage: pure logic ----------
  test('defaults are light with no overrides', () => {
    assert.deepEqual(S.defaults(), { defaultMode: 'light', siteOverrides: {}, excludedSites: [], forcedEngine: 'rewrite', forcedAdjust: { brightness: 100, contrast: 100, sepia: 0 } });
  });
  test('sanitize handles garbage input', () => {
    for (const bad of [null, undefined, 5, 'x', [], { defaultMode: 'purple' }, { siteOverrides: 7 }]) {
      const s = S.sanitize(bad);
      assert.ok(S.MODES.includes(s.defaultMode), 'valid mode for ' + JSON.stringify(bad));
      assert.equal(typeof s.siteOverrides, 'object');
    }
  });
  test('sanitize drops invalid overrides, keeps valid, lowercases hosts', () => {
    const s = S.sanitize({ defaultMode: 'forced', siteOverrides: { 'A.com': 'light', 'b.com': 'nope', 'c.com': 'default', '': 'forced' } });
    assert.deepEqual({ d: s.defaultMode, o: s.siteOverrides }, { d: 'forced', o: { 'a.com': 'light' } });
  });
  test('sanitize reads the removed native "dark" mode as "forced" (the mode now called Dark)', () => {
    const s = S.sanitize({ defaultMode: 'dark', siteOverrides: { 'a.com': 'dark', 'b.com': 'light' } });
    assert.deepEqual({ d: s.defaultMode, o: s.siteOverrides }, { d: 'forced', o: { 'a.com': 'forced', 'b.com': 'light' } });
    assert.equal(S.applyChange(S.defaults(), 'all', '', 'dark').defaultMode, 'forced');
    assert.equal(S.effectiveMode({ defaultMode: 'light', siteOverrides: { 'x.com': 'dark' }, excludedSites: [] }, 'x.com'), 'forced');
    assert.deepEqual(S.MODES, ['light', 'forced']);
  });
  test('sanitize blocks __proto__ pollution', () => {
    const s = S.sanitize(JSON.parse('{"siteOverrides":{"__proto__":"forced","x.com":"forced"}}'));
    assert.equal(Object.getPrototypeOf(s.siteOverrides), Object.prototype);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(s.siteOverrides), ['x.com']);
    assert.equal(S.effectiveMode(s, '__proto__'), 'light');
    assert.equal(S.effectiveMode(s, 'constructor'), 'light');
    assert.equal(S.effectiveMode(s, 'toString'), 'light');
  });
  test('effectiveMode: override beats default; case-insensitive', () => {
    const s = { defaultMode: 'forced', siteOverrides: { 'x.com': 'light' } };
    assert.equal(S.effectiveMode(s, 'x.com'), 'light');
    assert.equal(S.effectiveMode(s, 'X.COM'), 'light');
    assert.equal(S.effectiveMode(s, 'y.com'), 'forced');
    assert.equal(S.effectiveMode(s, ''), 'forced');
    assert.equal(S.effectiveMode(s, undefined), 'forced');
  });
  test('applyChange: all / site / default / invalid', () => {
    let s = S.defaults();
    s = S.applyChange(s, 'all', 'x.com', 'forced');
    assert.equal(s.defaultMode, 'forced');
    s = S.applyChange(s, 'site', 'X.com', 'forced');
    assert.deepEqual(s.siteOverrides, { 'x.com': 'forced' });
    s = S.applyChange(s, 'site', 'x.com', 'default');
    assert.deepEqual(s.siteOverrides, {});
    const before = JSON.stringify(s);
    assert.equal(JSON.stringify(S.applyChange(s, 'site', '', 'forced')), before, 'empty host ignored');
    assert.equal(JSON.stringify(S.applyChange(s, 'all', 'x', 'default')), before, 'default not allowed globally');
    assert.equal(JSON.stringify(S.applyChange(s, 'site', 'x.com', 'bogus')), before);
    assert.equal(JSON.stringify(S.applyChange(s, 'weird', 'x.com', 'forced')), before);
  });
  test('applyChange does not mutate its input', () => {
    const s = { defaultMode: 'light', siteOverrides: { 'a.com': 'forced' } };
    const copy = JSON.stringify(s);
    S.applyChange(s, 'site', 'b.com', 'forced');
    assert.equal(JSON.stringify(s), copy);
  });

  // ---------- storage: chrome.storage round trips ----------
  test('load returns defaults when nothing stored', async () => {
    fresh();
    assert.deepEqual(await S.load(), S.defaults());
  });
  test('save then load round-trips', async () => {
    fresh();
    const next = S.applyChange(S.defaults(), 'site', 'a.com', 'forced');
    assert.equal(await S.save(next), true);
    assert.deepEqual(await S.load(), next);
  });
  test('load survives storage failure and corrupt data', async () => {
    const c = fresh();
    c.fail.get = true;
    assert.deepEqual(await S.load(), S.defaults());
    c.fail.get = false;
    c._data[S.KEY] = 'corrupt';
    assert.deepEqual(await S.load(), S.defaults());
  });
  test('save reports failure instead of throwing', async () => {
    const c = fresh();
    c.fail.set = true;
    assert.equal(await S.save(S.defaults()), false);
  });
  test('update is read-modify-write', async () => {
    fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    const out = await S.update((s) => S.applyChange(s, 'site', 'a.com', 'light'));
    assert.deepEqual({ d: out.defaultMode, o: out.siteOverrides }, { d: 'forced', o: { 'a.com': 'light' } });
    assert.deepEqual(await S.load(), out);
  });
  test('stored values are namespaced and split so one list cannot overflow another key', async () => {
    const c = fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    assert.deepEqual(Object.keys(c._data).sort(), [S.KEY, S.KEY_EXCLUDED, S.KEY_SITES].sort());
    assert.ok(Object.keys(c._data).every((k) => k.startsWith('trikaal')));
  });
  test('changed()/applyChanges() only react to sync changes for our keys', () => {
    const base = S.applyChange(S.defaults(), 'all', '', 'forced');
    assert.equal(S.changed({ other: { newValue: 1 } }, 'sync'), false);
    assert.equal(S.changed({ [S.KEY]: {} }, 'local'), false);
    assert.equal(S.changed(null, 'sync'), false);
    assert.equal(S.applyChanges(base, { other: { newValue: 1 } }, 'sync'), null);
    assert.equal(S.applyChanges(base, { [S.KEY]: { newValue: { defaultMode: 'forced' } } }, 'local'), null);
    const r = S.applyChanges(base, { [S.KEY]: { newValue: { defaultMode: 'forced' } } }, 'sync');
    assert.equal(r.defaultMode, 'forced');
    const sites = S.applyChanges(base, { [S.KEY_SITES]: { newValue: { 'a.com': 'light' } } }, 'sync');
    assert.equal(sites.defaultMode, 'forced', 'untouched keys are kept from the previous settings');
    assert.deepEqual(sites.siteOverrides, { 'a.com': 'light' });
    const removed = S.applyChanges(base, { [S.KEY]: {} }, 'sync');
    assert.equal(removed.defaultMode, 'light', 'removed core key -> defaults');
  });

  // ---------- controller ----------
  const mkController = (host, applied) =>
    Trikaal.createController({ host, log: quiet, apply: (m, p) => applied.push([m, p]) });

  test('controller applies stored mode on start', async () => {
    fresh();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    const applied = [];
    const c = mkController('a.com', applied);
    await c.start();
    assert.equal(c.getMode(), 'forced');
    assert.deepEqual(applied, [['forced', null]]);
    c.stop();
  });
  test('controller defaults to light and still applies once', async () => {
    fresh();
    const applied = [];
    const c = mkController('a.com', applied);
    await c.start();
    assert.deepEqual(applied, [['light', null]]);
    c.stop();
  });
  test('controller updates live on change, only when effective mode changes', async () => {
    const chrome_ = fresh();
    const applied = [];
    const c = mkController('a.com', applied);
    await c.start();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    assert.equal(c.getMode(), 'forced');
    await S.update((s) => S.applyChange(s, 'site', 'other.com', 'light')); // irrelevant host
    assert.equal(applied.length, 2, 'no re-apply for unrelated change');
    await S.update((s) => S.applyChange(s, 'site', 'a.com', 'light'));
    assert.equal(c.getMode(), 'light');
    await S.update((s) => S.applyChange(s, 'site', 'a.com', 'default'));
    assert.equal(c.getMode(), 'forced', 'falls back to default');
    assert.deepEqual(applied.map((a) => a[0]), ['light', 'forced', 'light', 'forced']);
    c.stop();
    assert.equal(chrome_._listenerCount(), 0, 'stop removes listener');
  });
  test('two tabs on different hosts stay independent but share the default', async () => {
    fresh();
    const a = [], b = [];
    const ca = mkController('a.com', a), cb = mkController('b.com', b);
    await ca.start(); await cb.start();
    await S.update((s) => S.applyChange(s, 'site', 'a.com', 'forced'));
    assert.equal(ca.getMode(), 'forced');
    assert.equal(cb.getMode(), 'light');
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    assert.equal(ca.getMode(), 'forced');
    assert.equal(cb.getMode(), 'forced');
    ca.stop(); cb.stop();
  });
  test('slow initial load never overrides a newer live change', async () => {
    const c0 = fresh();
    c0.delayGet = 80;
    await S.save(S.applyChange(S.defaults(), 'all', '', 'forced')); // stale value
    const applied = [];
    const c = mkController('a.com', applied);
    const started = c.start();
    await sleep(10);
    await S.save(S.applyChange(S.defaults(), 'all', '', 'forced')); // newer, arrives mid-load
    await started;
    assert.equal(c.getMode(), 'forced');
    c.stop();
  });
  test('controller survives storage failure and apply throwing', async () => {
    const c0 = fresh();
    c0.fail.get = true;
    const c = Trikaal.createController({ host: 'a.com', log: quiet, apply: () => { throw new Error('boom'); } });
    await c.start();
    assert.equal(c.getMode(), 'light');
    c.stop();
  });
  test('start twice does not double-register', async () => {
    const c0 = fresh();
    const c = mkController('a.com', []);
    await c.start(); await c.start();
    assert.equal(c0._listenerCount(), 1);
    c.stop();
  });
  test('ignores non-sync storage areas', async () => {
    const c0 = fresh();
    const applied = [];
    const c = mkController('a.com', applied);
    await c.start();
    for (const l of c0.storage.onChanged ? [] : []) l();
    await c0.storage.sync.set({ unrelated: 1 });
    assert.equal(applied.length, 1);
    c.stop();
  });

  // ---------- popup UI ----------
  const checked = (doc, name) => (doc.querySelector(`input[name="${name}"]:checked`) || {}).value;
  const click = (doc, name, value) => doc.querySelector(`input[name="${name}"][value="${value}"]`).click();

  test('popup: shows hostname and highlights active default mode', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://www.example.com/page?q=1' }] };
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    const p = await mountPopup(c);
    assert.equal(p.doc.getElementById('host').textContent, 'www.example.com');
    assert.equal(checked(p.doc, 'scope'), 'site');
    assert.equal(checked(p.doc, 'mode'), 'forced');
    p.destroy();
  });
  test('popup: This site writes an override; All sites writes default', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    const p = await mountPopup(c);
    click(p.doc, 'mode', 'forced');
    await sleep(40);
    assert.deepEqual((await S.load()).siteOverrides, { 'example.com': 'forced' });
    assert.equal((await S.load()).defaultMode, 'light');
    click(p.doc, 'scope', 'all');
    await sleep(20);
    assert.equal(checked(p.doc, 'mode'), 'light', 'All sites shows the default');
    assert.ok(p.doc.getElementById('note').textContent.includes('overrides'), 'note mentions override');
    click(p.doc, 'mode', 'forced');
    await sleep(40);
    const s = await S.load();
    assert.equal(s.defaultMode, 'forced');
    assert.equal(s.siteOverrides['example.com'], 'forced', 'override untouched');
    p.destroy();
  });
  test('popup: reset button removes the override', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    await S.update((s) => S.applyChange(S.applyChange(s, 'all', '', 'forced'), 'site', 'example.com', 'light'));
    const p = await mountPopup(c);
    const reset = p.doc.getElementById('reset');
    assert.equal(reset.hidden, false);
    assert.equal(checked(p.doc, 'mode'), 'light');
    reset.click();
    await sleep(40);
    assert.deepEqual((await S.load()).siteOverrides, {});
    assert.equal(checked(p.doc, 'mode'), 'forced');
    assert.equal(reset.hidden, true);
    p.destroy();
  });
  test('popup: non-http page (chrome://) can only edit the default', async () => {
    for (const url of ['chrome://extensions/', 'about:blank', 'file:///C:/x.html', undefined]) {
      const c = fresh();
      c.tabs = { query: async () => [{ url }] };
      const p = await mountPopup(c);
      assert.equal(p.doc.querySelector('input[name="scope"][value="site"]').disabled, true, 'site scope disabled for ' + url);
      assert.equal(checked(p.doc, 'scope'), 'all');
      click(p.doc, 'mode', 'forced');
      await sleep(40);
      const s = await S.load();
      assert.equal(s.defaultMode, 'forced');
      assert.deepEqual(s.siteOverrides, {});
      p.destroy();
    }
  });
  test('popup: no tabs / tabs.query throwing is handled', async () => {
    const c = fresh();
    c.tabs = { query: async () => { throw new Error('nope'); } };
    const p = await mountPopup(c);
    assert.equal(checked(p.doc, 'scope'), 'all');
    p.destroy();
    const c2 = fresh();
    c2.tabs = { query: async () => [] };
    const p2 = await mountPopup(c2);
    assert.equal(checked(p2.doc, 'scope'), 'all');
    p2.destroy();
  });
  test('popup: reflects external changes while open', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    const p = await mountPopup(c);
    assert.equal(checked(p.doc, 'mode'), 'light');
    await S.update((s) => S.applyChange(s, 'site', 'example.com', 'forced'));
    await sleep(20);
    assert.equal(checked(p.doc, 'mode'), 'forced');
    p.destroy();
  });
  test('popup: exactly one radio checked per group, labels present', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    const p = await mountPopup(c);
    for (const g of ['scope', 'mode']) {
      assert.equal(p.doc.querySelectorAll(`input[name="${g}"]:checked`).length, 1, g);
    }
    const labels = Array.from(p.doc.querySelectorAll('.segmented label span')).map((s) => s.textContent);
    assert.deepEqual(labels, ['This site', 'All sites', 'Light', 'Dark']);
    assert.ok(p.doc.querySelectorAll('[role="radiogroup"][aria-label]').length === 2);
    p.destroy();
  });
  test('popup: storage write failure does not break the UI', async () => {
    const c = fresh();
    c.tabs = { query: async () => [{ url: 'https://example.com/' }] };
    const p = await mountPopup(c);
    c.fail.set = true;
    click(p.doc, 'mode', 'forced');
    await sleep(40);
    assert.ok(p.doc.getElementById('host').textContent === 'example.com');
    p.destroy();
  });
})();
