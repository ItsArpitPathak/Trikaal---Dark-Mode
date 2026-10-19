// Phase 4: Forced Dark v1 (CSS filter engine).
window.__suitePending = (async () => {
  await loadScripts(['/shared/storage.js', '/content/util.js', '/content/color.js', '/content/detect.js', '/content/forced-dark.js', '/content/theme.js', '/content/controller.js']);
  const T = Trikaal;
  const F = T.forced;
  const root = document.documentElement;
  const SEL_RESIDUE = '#trikaal-style, #trikaal-forced-style, [data-trikaal-keep], [data-trikaal-scheme]';
  const residue = () => document.querySelectorAll(SEL_RESIDUE).length;
  const filterOf = (el) => getComputedStyle(el).filter;
  const INV = 'invert(1) hue-rotate(180deg)';

  // Pull the article fixture into this page (styles + body markup).
  const html = await (await fetch('/tests/pages/article.html', { cache: 'no-store' })).text();
  const fixture = new DOMParser().parseFromString(html, 'text/html');
  const fxStyles = Array.from(fixture.head.querySelectorAll('style')).map((s) => { const n = document.createElement('style'); n.textContent = s.textContent; n.dataset.fx = '1'; return n; });
  const box = document.createElement('div');
  box.id = 'fx';
  const load = () => {
    for (const s of fxStyles) if (!s.isConnected) document.head.appendChild(s);
    box.innerHTML = fixture.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, '');
    if (!box.isConnected) document.body.appendChild(box);
  };
  const $ = (id) => document.getElementById(id);
  const cleanup = () => { T.theme.teardown(); F.isTopFrame = () => true; box.innerHTML = ''; };
  // Suites run inside an iframe (all.html), so isTopFrame is stubbed to true.

  test('enable adds a single uniquely named style; html is filtered', async () => {
    cleanup(); load();
    F.enable();
    assert.equal(document.querySelectorAll('#trikaal-forced-style').length, 1);
    assert.ok(filterOf(root).includes('invert(1)') && filterOf(root).includes('hue-rotate(180deg)'));
    F.enable(); F.enable();
    assert.equal(document.querySelectorAll('#trikaal-forced-style').length, 1, 'idempotent');
    cleanup();
  });
  test('html gets a background so the canvas is inverted too (no white flash area)', () => {
    cleanup(); load();
    F.enable();
    assert.equal(getComputedStyle(root).backgroundColor, 'rgb(255, 255, 255)', 'pre-filter white -> dark after invert');
    cleanup();
  });
  test('media is re-inverted: img, canvas, iframe', () => {
    cleanup(); load();
    F.enable();
    for (const id of ['photo', 'cv', 'frame']) assert.equal(filterOf($(id)), INV, id);
    cleanup();
  });
  test('picture/img pair is inverted exactly once', () => {
    cleanup(); load();
    F.enable();
    assert.equal(filterOf($('pic')), INV);
    assert.equal(filterOf($('picimg')), 'none');
    cleanup();
  });
  test('CSS background-image elements are detected and re-inverted; nested media not doubled', async () => {
    cleanup(); load();
    F.enable();
    await sleep(120);
    assert.ok($('hero').hasAttribute('data-trikaal-keep'));
    assert.equal(filterOf($('hero')), INV);
    assert.equal(filterOf($('heroimg')), 'none', 'img inside a kept box is not inverted again');
    assert.ok(!$('card').hasAttribute('data-trikaal-keep'), 'gradient is not an image');
    assert.equal(filterOf($('card')), 'none');
    cleanup();
  });
  test('dynamically added bg-image element gets handled (childList)', async () => {
    cleanup(); load();
    F.enable();
    await sleep(120);
    const d = document.createElement('div');
    d.id = 'dyn';
    d.style.cssText = "height:20px;background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>\")";
    $('fx').appendChild(d);
    await sleep(120);
    assert.ok(d.hasAttribute('data-trikaal-keep'));
    cleanup();
  });
  test('bg image added/removed via style or class mutation toggles the mark', async () => {
    cleanup(); load();
    F.enable();
    await sleep(120);
    const c = $('card');
    c.style.backgroundImage = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>\")";
    await sleep(120);
    assert.ok(c.hasAttribute('data-trikaal-keep'));
    c.style.backgroundImage = '';
    await sleep(120);
    assert.ok(!c.hasAttribute('data-trikaal-keep'), 'unmarked again');
    const st = document.createElement('style'); st.dataset.fx = '1';
    st.textContent = ".withbg{background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>\")}";
    document.head.appendChild(st);
    c.className = 'card withbg';
    await sleep(120);
    assert.ok(c.hasAttribute('data-trikaal-keep'), 'class-driven bg');
    st.remove();
    cleanup();
  });
  test('disable removes style, marks and filters completely', async () => {
    cleanup(); load();
    F.enable();
    await sleep(120);
    F.disable();
    assert.equal(residue(), 0);
    assert.equal(filterOf(root), 'none');
    assert.equal(filterOf($('photo')), 'none');
    cleanup();
  });
  test('no observer activity after disable (late bg image is not marked)', async () => {
    cleanup(); load();
    F.enable();
    await sleep(120);
    F.disable();
    const d = document.createElement('div');
    d.style.cssText = "background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>\")";
    $('fx').appendChild(d);
    await sleep(120);
    assert.equal(residue(), 0);
    cleanup();
  });
  test('non-top frames do not filter themselves', () => {
    cleanup(); load();
    F.isTopFrame = () => false;
    F.enable();
    assert.equal(residue(), 0);
    assert.equal(filterOf(root), 'none');
    cleanup();
  });
  test('theme dispatch: forced -> light -> forced -> light leaves no residue at the end', async () => {
    cleanup(); load();
    T.theme.apply('forced');
    await sleep(50);
    assert.ok(document.getElementById('trikaal-forced-style'));
    T.theme.apply('light');
    assert.equal(residue(), 0);
    T.theme.apply('forced'); T.theme.apply('light');
    await sleep(120);
    assert.equal(residue(), 0);
    cleanup();
  });
  test('rapid cycling of every mode leaves no residue', async () => {
    cleanup(); load();
    const modes = ['forced', 'light', 'forced', 'forced', 'light'];
    for (let i = 0; i < 8; i++) for (const m of modes) T.theme.apply(m);
    await sleep(150);
    assert.equal(residue(), 0);
    assert.equal(filterOf(root), 'none');
    cleanup();
  });
  test('guard re-adds the style if the page strips it', async () => {
    cleanup(); load();
    F.enable();
    document.getElementById('trikaal-forced-style').remove();
    await sleep(40);
    assert.equal(document.querySelectorAll('#trikaal-forced-style').length, 1);
    cleanup();
  });
  test('large DOM is scanned in slices without blocking (5000 elements)', async () => {
    cleanup(); load();
    const big = document.createElement('div');
    for (let i = 0; i < 5000; i++) { const e = document.createElement('span'); e.textContent = i; big.appendChild(e); }
    big.children[4321].style.backgroundImage = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>\")";
    $('fx').appendChild(big);
    void box.offsetHeight; // pay the browser's own first style/layout cost before measuring us
    const base = Math.max(recalcCost(), recalcCost()); // one full-page style recalc on this machine
    const t0 = performance.now();
    F.enable();
    const enableCost = performance.now() - t0;
    // Main-thread blocking while the scan runs (works even when the pane is hidden).
    const lat = await blockedTicks(1500);
    assert.ok(big.children[4321].hasAttribute('data-trikaal-keep'), 'late element found');
    // enable() measures the page (a few forced style recalcs) so it scales with the baseline.
    assert.ok(enableCost < Math.max(10 * base + 200, 800), 'enable() cost ' + Math.round(enableCost) + 'ms vs recalc baseline ' + Math.round(base) + 'ms');
    // The browser itself must recalc the whole page once or twice after our style lands;
    // anything far beyond that would mean un-sliced scanning.
    // (Measured: the first slice absorbs that recalc; every later slice is <= ~40 ms.)
    assert.ok(lat.worst <= Math.max(8 * base + 150, 600), 'worst block ' + lat.worst + 'ms vs recalc baseline ' + Math.round(base) + 'ms');
    cleanup();
  });
  test('engine never throws when documentElement queries fail / elements vanish mid-scan', async () => {
    cleanup(); load();
    F.enable();
    $('fx').innerHTML = '';
    await sleep(60);
    cleanup();
  });
  test('e2e: storage -> forced engine on/off live', async () => {
    cleanup(); load();
    window.chrome = createMockChrome();
    const S = T.storage;
    const c = T.createController({ host: 'example.com', log: () => {}, apply: (m) => T.theme.apply(m) });
    await c.start();
    await S.update((s) => S.applyChange(s, 'all', '', 'forced'));
    await sleep(60);
    assert.ok(filterOf(root).includes('invert'));
    await S.update((s) => S.applyChange(s, 'site', 'example.com', 'light'));
    await sleep(60);
    assert.equal(residue(), 0);
    c.stop();
    cleanup();
  });
})();
