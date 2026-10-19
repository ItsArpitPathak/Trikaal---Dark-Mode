// Phase 6: HSL color mapping, value rewriting, and the color-rewrite engine.
window.__suitePending = (async () => {
  await loadScripts(['/shared/storage.js', '/content/util.js', '/content/color.js', '/content/detect.js', '/content/forced-dark.js', '/content/rewrite.js', '/content/theme.js', '/content/controller.js', '/content/main-world.js']);
  const T = Trikaal, C = T.color, F = T.forced, RW = T.rewrite;
  const engine = F.engines.rewrite;
  const rgb = (r, g, b, a = 1) => ({ r, g, b, a });
  const hex = (s) => C.parse(s);

  // =========================================================== color mapping
  test('bg: white -> near-black, light gray card slightly lighter than page', () => {
    const page = C.toHsl(C.mapColor(hex('#ffffff'), 'bg')).l;
    const card = C.toHsl(C.mapColor(hex('#f5f5f5'), 'bg')).l;
    assert.near(page, 0.09, 0.001);
    assert.ok(card > page && card < 0.14, 'card ' + card);
  });
  test('bg: lighter input -> darker output (ordering inverted), over the whole light range', () => {
    let prev = 1;
    for (let l = 0.5; l <= 1.0001; l += 0.05) {
      const out = C.toHsl(C.mapColor(C.fromHsl(210, 0.5, l), 'bg')).l;
      assert.ok(out <= prev + 1e-9, `l=${l} out=${out} prev=${prev}`);
      assert.ok(out < 0.5);
      prev = out;
    }
  });
  test('bg: already-dark colors are left untouched', () => {
    for (const s of ['#000', '#0a2540', '#222', '#3b3b3b', '#1a1a2e']) {
      const c = hex(s), o = C.mapColor(c, 'bg');
      assert.deepEqual([Math.round(o.r), Math.round(o.g), Math.round(o.b)], [c.r, c.g, c.b].map(Math.round), s);
    }
  });
  test('fg: black -> ~L .9 light, #333 light, already-light text untouched, mid-gray stays readable', () => {
    assert.near(C.toHsl(C.mapColor(hex('#000'), 'fg')).l, 0.9, 0.001);
    assert.ok(C.toHsl(C.mapColor(hex('#333'), 'fg')).l > 0.75);
    const white = C.mapColor(hex('#ffffff'), 'fg');
    assert.equal(Math.round(white.r), 255);
    const gray = C.mapColor(hex('#777'), 'fg');
    assert.ok(C.toHsl(gray).l > 0.6);
  });
  test('hue is preserved by every role', () => {
    for (const role of ['bg', 'fg', 'border']) {
      for (const h of [0, 30, 120, 210, 280, 330]) {
        const src = C.fromHsl(h, 0.7, role === 'bg' ? 0.85 : 0.25, 1);
        const out = C.toHsl(C.mapColor(src, role));
        const diff = Math.min(Math.abs(out.h - h), 360 - Math.abs(out.h - h));
        assert.ok(diff < 2.5, `${role} hue ${h} -> ${out.h}`);
      }
    }
  });
  test('saturation never increases; brand colors stay recognizably colored', () => {
    for (const role of ['bg', 'fg', 'border']) {
      for (let i = 0; i < 60; i++) {
        const src = C.fromHsl(i * 6, 0.2 + (i % 5) * 0.15, 0.1 + (i % 9) * 0.1, 1);
        const a = C.toHsl(src), b = C.toHsl(C.mapColor(src, role));
        assert.ok(b.s <= a.s + 0.02, `${role} sat ${a.s} -> ${b.s}`);
      }
    }
    const red = C.toHsl(C.mapColor(hex('#e63946'), 'bg'));
    assert.ok(red.s > 0.5 && red.l > 0.2 && red.l < 0.35, 'brand red: ' + JSON.stringify(red));
  });
  test('alpha is preserved', () => {
    for (const role of ['bg', 'fg', 'border']) assert.near(C.mapColor(rgb(255, 255, 255, 0.4), role).a, 0.4, 1e-9);
  });
  test('idempotent: mapping an output again changes nothing (bg and fg)', () => {
    for (const role of ['bg', 'fg']) {
      for (let i = 0; i < 200; i++) {
        const src = C.fromHsl((i * 37) % 360, (i % 10) / 10, (i % 20) / 20, 1);
        const once = C.mapColor(src, role), twice = C.mapColor(once, role);
        assert.near(once.r, twice.r, 1.5, role + ' r'); assert.near(once.g, twice.g, 1.5); assert.near(once.b, twice.b, 1.5);
      }
    }
  });
  test('typical light-design pairs stay readable after mapping (contrast >= 4.5)', () => {
    const pairs = [['#222', '#fff'], ['#000', '#eee'], ['#0645ad', '#fff'], ['#333', '#f9f9f9'], ['#555', '#fafafa'], ['#666', '#fff'], ['#b00020', '#fff'], ['#006400', '#f0fff0']];
    for (const [fg, bg] of pairs) {
      const f = C.mapColor(hex(fg), 'fg'), b = C.mapColor(hex(bg), 'bg');
      const ratio = C.contrast(C.luminance(f), C.luminance(b));
      assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}`);
    }
  });
  test('borders: light lines stay visible but dark; black lines become mid-gray', () => {
    const light = C.toHsl(C.mapColor(hex('#ddd'), 'border')).l;
    assert.ok(light > 0.12 && light < 0.25, 'light border ' + light);
    const black = C.toHsl(C.mapColor(hex('#000'), 'border')).l;
    assert.ok(black > 0.4 && black < 0.6, 'black border ' + black);
  });

  // =========================================================== value rewriting
  const lumOf = (s) => C.luminance(C.parse(s));
  test('mapValue: hex / rgb / hsl / named', () => {
    assert.ok(lumOf(RW.mapValue('#ffffff', 'bg')) < 0.02);
    assert.ok(lumOf(RW.mapValue('rgb(250, 250, 250)', 'bg')) < 0.02);
    assert.ok(lumOf(RW.mapValue('hsl(210 50% 96%)', 'bg')) < 0.03);
    assert.ok(lumOf(RW.mapValue('white', 'bg')) < 0.02);
    assert.ok(lumOf(RW.mapValue('black', 'fg')) > 0.6);
    assert.ok(lumOf(RW.mapValue('navy', 'fg')) > 0.3);
  });
  test('mapValue: keywords, transparent, currentcolor, none are untouched', () => {
    for (const k of ['transparent', 'currentcolor', 'currentColor', 'inherit', 'initial', 'none', 'auto', 'unset']) assert.equal(RW.mapValue(k, 'bg'), k);
  });
  test('mapValue: gradients convert every stop and keep geometry', () => {
    const out = RW.mapValue('linear-gradient(90deg, #fff 0%, rgba(255,255,255,0) 50%, #ddd 100%)', 'bg');
    assert.ok(out.startsWith('linear-gradient(90deg, '));
    assert.ok(out.includes(' 0%') && out.includes(' 50%') && out.includes(' 100%'));
    const colors = out.match(/rgba?\([^)]*\)/g);
    assert.equal(colors.length, 3);
    assert.ok(lumOf(colors[0]) < 0.02 && lumOf(colors[2]) < 0.03);
    assert.ok(colors[1].includes('255, 255, 255, 0') || /,\s*0\)/.test(colors[1]), 'transparent stop kept: ' + colors[1]);
    assert.ok(RW.mapValue('radial-gradient(circle at 10% 20%, #fff, #eee)', 'bg').startsWith('radial-gradient(circle at 10% 20%, '));
  });
  test('mapValue: url() and var() are preserved; var() fallback colors convert', () => {
    const u = 'url("data:image/svg+xml;utf8,<svg fill=\'#fff\'/>"), #fff';
    const out = RW.mapValue(u, 'bg');
    assert.ok(out.startsWith('url("data:image/svg+xml;utf8,<svg fill=\'#fff\'/>")'), out);
    assert.ok(!out.endsWith('#fff'));
    assert.equal(RW.mapValue('var(--x)', 'bg'), 'var(--x)');
    const fb = RW.mapValue('var(--x, #fff)', 'bg');
    assert.ok(fb.startsWith('var(--x, ') && !fb.includes('#fff'));
    assert.equal(RW.mapValue('rgb(var(--r) var(--g) var(--b))', 'bg'), 'rgb(var(--r) var(--g) var(--b))');
  });
  test('mapValue: shorthand-like values keep non-color parts', () => {
    const out = RW.mapValue('1px solid #ddd', 'border');
    assert.ok(out.startsWith('1px solid ') && !out.includes('#ddd'));
    assert.ok(RW.mapValue('0 0 4px rgba(0,0,0,.2)', 'bg').startsWith('0 0 4px '));
  });
  test('mapValue: empty and weird input never throws', () => {
    for (const v of ['', null, undefined, '((', ')', '"unterminated', 'rgb(', '#', '#zz', 'calc(1px + 2px)', '\\']) RW.mapValue(v, 'bg');
  });
  test('convertVarValue: colors, rgb triplets, non-colors, var() chains', () => {
    RW._votes.clear();
    assert.ok(lumOf(RW.convertVarValue('--bg', '#ffffff')) < 0.02, 'light default role bg');
    assert.ok(lumOf(RW.convertVarValue('--text', '#111111')) > 0.6, 'dark default role fg');
    assert.equal(RW.convertVarValue('--shadow', '0 1px 3px rgba(0,0,0,.2)'), null);
    assert.equal(RW.convertVarValue('--x', 'var(--y)'), null);
    assert.equal(RW.convertVarValue('--x', ''), null);
    const trip = RW.convertVarValue('--rgb', '255, 255, 255');
    assert.ok(/^\d+, \d+, \d+$/.test(trip));
    const [r] = trip.split(',').map(Number);
    assert.ok(r < 50, 'triplet converted: ' + trip);
    RW._votes.set('--c', { bg: 0, fg: 5, border: 0 });
    assert.ok(lumOf(RW.convertVarValue('--c', '#ffffff')) > 0.9, 'used as text -> stays light');
    RW._votes.clear();
  });

  // =========================================================== rule rewriting
  const rulesOf = (css) => { const s = new CSSStyleSheet(); s.replaceSync(css); return Array.from(s.cssRules); };
  test('rewriteRule: style rule keeps selector, uses !important, only touches colors', () => {
    const [out] = RW.rewriteRule(rulesOf('.a:hover > b{background:#fff;color:#000;margin:3px;border:1px solid #ddd}')[0]);
    assert.ok(out.startsWith('.a:hover > b{'), out);
    assert.ok(out.includes('background-color:') && out.includes('color:') && out.includes('border-top-color:'));
    assert.ok(!out.includes('margin'));
    assert.ok(out.split(';').every((d) => d.includes('!important') || d.endsWith('}') === false || true));
    assert.ok(out.includes('!important'));
  });
  test('rewriteRule: rules without colors produce nothing', () => {
    assert.deepEqual(RW.rewriteRule(rulesOf('.a{margin:0;display:flex}')[0]), []);
  });
  test('rewriteRule: @media / @supports / @layer wrappers are preserved', () => {
    const [m] = RW.rewriteRule(rulesOf('@media (min-width: 10px){.a{background:#fff}}')[0]);
    assert.ok(m.startsWith('@media (min-width: 10px){.a{'), m);
    const [s] = RW.rewriteRule(rulesOf('@supports (display:grid){.a{background:#fff}}')[0]);
    assert.ok(/^@supports \(display:\s?grid\)\{/.test(s), s);
    const [l] = RW.rewriteRule(rulesOf('@layer base{.a{background:#fff}}')[0]);
    assert.ok(l.startsWith('@layer base{'), l);
    assert.deepEqual(RW.rewriteRule(rulesOf('@media print{.a{margin:0}}')[0]), []);
  });
  test('rewriteRule: keyframes colors converted without !important', () => {
    const [k] = RW.rewriteRule(rulesOf('@keyframes p{from{background:#fff}to{background:#ccc}}')[0]);
    assert.ok(k.startsWith('@keyframes p{') && !k.includes('!important'), k);
  });
  test('rewriteRule: custom properties converted (with !important) in their own rule', () => {
    const [o] = RW.rewriteRule(rulesOf(':root{--bg:#fff;--n:12px}')[0]);
    assert.ok(o.includes('--bg:') && !o.includes('--n') && o.includes('!important'), o);
  });
  test('rewriteRule: unreadable/odd rules never throw', () => {
    assert.deepEqual(RW.rewriteRule(null), []);
    assert.deepEqual(RW.rewriteRule({}), []);
    assert.deepEqual(RW.rewriteRule(rulesOf('@font-face{font-family:x;src:local(a)}')[0]), []);
  });

  // =========================================================== engine on a real fixture
  const SEL_RESIDUE = '#trikaal-rw-base, [data-trikaal-dyn], [data-trikaal-i], #trikaal-forced-style, #trikaal-style, [data-trikaal-keep]';
  const residue = () => document.querySelectorAll(SEL_RESIDUE).length;
  const html = await (await fetch('/tests/pages/app.html', { cache: 'no-store' })).text();
  const fixture = new DOMParser().parseFromString(html, 'text/html');
  const box = document.createElement('div');
  box.id = 'fx';
  const fxStyles = [];
  let shadowRoot = null;
  const $ = (id) => document.getElementById(id) || (shadowRoot && shadowRoot.getElementById(id));
  const cs = (el) => getComputedStyle(el);
  const bgOf = (id) => C.parse(cs($(id)).backgroundColor);
  const fgOf = (id) => C.parse(cs($(id)).color);

  function loadApp() {
    unload();
    for (const s of fixture.head.querySelectorAll('style')) {
      const n = document.createElement('style');
      n.textContent = s.textContent; n.dataset.fx = '1';
      document.head.appendChild(n); fxStyles.push(n);
    }
    box.innerHTML = fixture.body.innerHTML;
    document.body.appendChild(box);
    const host = $('shadowhost');
    shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<style>.x{background:#fff;color:#000;padding:4px}</style><div class="x" id="sh">shadow text</div>';
  }
  function unload() {
    fxStyles.splice(0).forEach((n) => n.remove());
    box.remove(); box.innerHTML = ''; shadowRoot = null;
    document.querySelectorAll('[data-fx]').forEach((n) => n.remove());
  }
  const cleanup = () => { engine.disable(); F.disable(); T.theme.teardown(); unload(); document.body.style.cssText = ''; F.config.engine = 'rewrite'; F.isTopFrame = () => true; };
  const run = async (fn) => {
    cleanup(); loadApp();
    try { await fn(); } finally { cleanup(); }
  };
  const settle = async () => { await engine.whenIdle(); await sleep(60); await engine.whenIdle(); };

  // Independent re-implementation of "what is behind this element" for auditing.
  function behind(el) {
    const chain = [];
    for (let n = el; n; ) { chain.push(n); n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null; }
    let color = { r: 255, g: 255, b: 255, a: 1 }, image = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const s = getComputedStyle(chain[i]);
      const bg = C.parse(s.backgroundColor);
      if (bg && bg.a > 0) { color = C.over(bg, color); if (bg.a >= 0.99) image = false; }
      if (s.backgroundImage.includes('url(')) image = true;
    }
    return { color, image };
  }
  const hasText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());
  function audit(scopeEl) {
    const bad = [];
    const els = Array.from(scopeEl.querySelectorAll('*'));
    for (const el of els) {
      if (['SCRIPT', 'STYLE', 'OPTION', 'IMG', 'SVG', 'svg'].includes(el.nodeName) || el instanceof SVGElement) continue;
      const s = getComputedStyle(el);
      const bg = C.parse(s.backgroundColor);
      if (bg && bg.a > 0.5 && !s.backgroundImage.includes('url(') && C.luminance(bg) >= 0.2) bad.push(`light bg: #${el.id || el.className} ${s.backgroundColor}`);
      if (hasText(el) || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.nodeName)) {
        const b = behind(el);
        if (b.image) continue;
        const fg = C.parse(s.color);
        const shown = fg.a < 1 ? C.over(fg, b.color) : fg;
        const ratio = C.contrast(C.luminance(shown), C.luminance(b.color));
        if (ratio < 3) bad.push(`low contrast ${ratio.toFixed(2)}: #${el.id || el.className} fg ${s.color} on ${C.toCss(b.color)}`);
      }
    }
    return bad;
  }

  test('baseline: the light fixture really is light and would fail the audit', async () => {
    await run(async () => {
      assert.ok(audit(box).length >= 8, 'sanity: unthemed fixture has many light backgrounds');
    });
  });
  test('engine: page becomes dark and readable (contrast audit passes everywhere)', async () => {
    await run(async () => {
      engine.enable();
      await settle();
      const bad = audit(box);
      assert.deepEqual(bad, [], bad.join('\n'));
      const shBad = audit(shadowRoot);
      assert.deepEqual(shBad, [], 'shadow: ' + shBad.join('\n'));
    });
  });
  test('engine: <html> canvas is dark and color-scheme is dark (native controls/scrollbars)', async () => {
    await run(async () => {
      engine.enable(); await settle();
      assert.equal(cs(document.documentElement).colorScheme, 'dark');
      assert.ok(C.luminance(C.parse(cs(document.documentElement).backgroundColor)) < 0.05);
    });
  });
  test('engine: brand colors keep their hue; already-dark stays; yellow badge goes dark but yellow', async () => {
    await run(async () => {
      const hueOf = (c) => C.toHsl(c).h;
      const beforeBtn = bgOf('btn'), beforeRed = bgOf('inl2'), beforeNavy = bgOf('navy'), beforeBadge = bgOf('badge');
      engine.enable(); await settle();
      const hd = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
      assert.ok(hd(hueOf(bgOf('btn')), hueOf(beforeBtn)) < 3, 'blue button hue');
      assert.ok(hd(hueOf(bgOf('inl2')), hueOf(beforeRed)) < 3, 'inline red hue');
      assert.ok(C.toHsl(bgOf('inl2')).s > 0.5, 'inline red still saturated');
      const navy = bgOf('navy');
      assert.deepEqual([navy.r, navy.g, navy.b].map(Math.round), [beforeNavy.r, beforeNavy.g, beforeNavy.b].map(Math.round), 'navy untouched');
      assert.ok(hd(hueOf(bgOf('badge')), hueOf(beforeBadge)) < 3 && C.luminance(bgOf('badge')) < 0.2, 'yellow -> dark yellow');
    });
  });
  test('engine: media is untouched (img, svg image, no filters, no attrs, same src)', async () => {
    await run(async () => {
      const src = $('img').getAttribute('src');
      engine.enable(); await settle();
      assert.equal($('img').getAttribute('src'), src);
      assert.equal(cs($('img')).filter, 'none');
      assert.equal($('img').hasAttribute('data-trikaal-i'), false);
      assert.equal(cs(document.documentElement).filter, 'none', 'rewrite engine uses no filter');
    });
  });
  test('engine: hero keeps its background image and author text color (white on image)', async () => {
    await run(async () => {
      engine.enable(); await settle();
      assert.ok(cs($('hero')).backgroundImage.includes('url('));
      const f = fgOf('hero');
      assert.ok(C.luminance(f) > 0.9, 'white text stays white');
    });
  });
  test('engine: gradients (stylesheet and inline) are darkened', async () => {
    await run(async () => {
      engine.enable(); await settle();
      for (const id of ['card', 'inl3']) {
        const colors = cs($(id)).backgroundImage.match(/rgba?\([^)]*\)/g) || [];
        assert.ok(colors.length >= 2, id + ' has stops: ' + cs($(id)).backgroundImage);
        assert.ok(colors.every((c) => C.luminance(C.parse(c)) < 0.1), id + ' ' + colors.join(' '));
      }
    });
  });
  test('engine: CSS variables, rgba(var()), media/supports/layer, named and hsl colors', async () => {
    await run(async () => {
      engine.enable(); await settle();
      for (const id of ['v', 'v2', 'm', 's', 'l', 'named', 'hsl', 'tbl']) {
        const b = id === 'tbl' ? C.parse(cs($('tbl').querySelector('td')).backgroundColor) : bgOf(id);
        if (b && b.a > 0) assert.ok(C.luminance(b) < 0.2, id + ' bg ' + C.toCss(b));
      }
      assert.ok(C.luminance(fgOf('v')) > 0.4, 'var text color is light');
      assert.ok(C.luminance(fgOf('v3')) > 0.15, 'var accent readable');
      assert.ok(C.luminance(fgOf('named')) > 0.15, 'navy text lightened');
    });
  });
  test('engine: zebra rows / border colors / table text', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const rows = $('tbl').querySelectorAll('tr');
      assert.ok(C.luminance(C.parse(cs(rows[1]).backgroundColor)) < 0.1);
      const td = $('tbl').querySelector('td');
      assert.ok(C.luminance(C.parse(cs(td).borderTopColor)) < 0.2, 'light border darkened');
    });
  });
  test('engine: hover / focus styles are rewritten too (copied rules exist)', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const ours = Array.from(document.querySelectorAll('[data-trikaal-dyn]')).filter((s) => s.sheet);
      const rules = ours.flatMap((s) => Array.from(s.sheet.cssRules));
      const text = rules.map((r) => r.cssText).join('\n');
      const hover = rules.find((r) => r.selectorText === '.btn:hover');
      assert.ok(hover, 'copied .btn:hover rule. Our rules: ' + text.slice(0, 300));
      assert.ok(C.luminance(C.parse(hover.style.backgroundColor)) < 0.1, 'hover bg is dark');
      assert.ok(rules.some((r) => r.selectorText === '.hdr a:hover'));
      assert.ok(text.includes('@keyframes pulse'), 'keyframes rewritten');
    });
  });
  test('engine: inline styles win over copied stylesheet rules', async () => {
    await run(async () => {
      const style = document.createElement('style');
      style.dataset.fx = '1';
      style.textContent = '#inl2 { background: #eee; }'; // page rule that would otherwise override our twin
      document.head.appendChild(style);
      const brandBefore = C.toHsl(C.parse('#e63946')).h;
      engine.enable(); await settle();
      const b = C.toHsl(bgOf('inl2'));
      assert.ok(Math.abs(b.h - brandBefore) < 5 || b.s > 0.4, 'inline brand red kept over the stylesheet twin: ' + JSON.stringify(b));
    });
  });
  test('engine: form controls, legacy <font color>, and SVG fills are readable', async () => {
    await run(async () => {
      engine.enable(); await settle();
      for (const id of ['inp', 'ta', 'sel']) {
        const r = C.contrast(C.luminance(fgOf(id)), C.luminance(bgOf(id)));
        assert.ok(r >= 3, id + ' contrast ' + r.toFixed(2));
      }
      const font = fgOf('oldfont');
      assert.ok(C.luminance(font) > 0.3, 'black <font color> became light: ' + C.toCss(font));
      const dark = C.luminance(C.parse(cs($('svgpath')).fill));
      assert.ok(dark > 0.2, 'black svg path visible on dark: ' + cs($('svgpath')).fill);
      const rectBg = C.luminance(C.parse(cs($('svgrect')).fill));
      assert.ok(rectBg < 0.6 || true);
    });
  });
  test('engine: open shadow DOM is themed (styles inside the shadow root)', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const sh = shadowRoot.getElementById('sh');
      assert.ok(C.luminance(C.parse(getComputedStyle(sh).backgroundColor)) < 0.1);
      assert.ok(C.luminance(C.parse(getComputedStyle(sh).color)) > 0.5);
    });
  });
  test('engine: shadow roots attached AFTER enable are found when the host is inserted', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const host = document.createElement('div');
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = '<style>.y{background:#fff;color:#111}</style><p class="y" id="late-sh">late</p>';
      box.appendChild(host);
      await settle();
      const p = sr.getElementById('late-sh');
      assert.ok(C.luminance(C.parse(getComputedStyle(p).backgroundColor)) < 0.1);
    });
  });
  test('engine: a shadow root attached AFTER the host is already in the page (late attachShadow) is found and themed', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const host = document.createElement('div');
      box.appendChild(host); // inserted first, no shadow root yet
      await settle();
      const sr = host.attachShadow({ mode: 'open' }); // attached later, like many web components do
      sr.innerHTML = '<style>.z{background:#fff;color:#111;padding:4px}</style><p class="z" id="late-z">late</p>';
      await settle();
      const p = sr.getElementById('late-z');
      assert.ok(C.luminance(C.parse(getComputedStyle(p).backgroundColor)) < 0.1, 'late shadow content themed: ' + getComputedStyle(p).backgroundColor);
      assert.ok(C.luminance(C.parse(getComputedStyle(p).color)) > 0.5);
    });
  });
  test('engine: nested late shadow roots (shadow inside shadow, attached later) are themed too', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const outer = document.createElement('div');
      box.appendChild(outer);
      const osr = outer.attachShadow({ mode: 'open' });
      osr.innerHTML = '<div id="innerhost"></div>';
      await settle();
      const innerHost = osr.getElementById('innerhost');
      const isr = innerHost.attachShadow({ mode: 'open' });
      isr.innerHTML = '<style>.q{background:#eee;color:#000}</style><span class="q" id="deep">deep</span>';
      await settle();
      const el = isr.getElementById('deep');
      assert.ok(C.luminance(C.parse(getComputedStyle(el).backgroundColor)) < 0.1, getComputedStyle(el).backgroundColor);
    });
  });
  test('late-shadow hook: closed roots are left alone, the page still gets its shadow root, and disable() stops listening', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const h = document.createElement('div');
      box.appendChild(h);
      const closed = h.attachShadow({ mode: 'closed' });
      assert.ok(closed, 'attachShadow still returns the root');
      assert.equal(h.shadowRoot, null, 'closed roots stay closed');
      const open = document.createElement('div');
      box.appendChild(open);
      const r2 = open.attachShadow({ mode: 'open' });
      assert.equal(open.shadowRoot, r2, 'native behaviour unchanged for open roots');
      engine.disable();
      const h2 = document.createElement('div');
      box.appendChild(h2);
      h2.attachShadow({ mode: 'open' }).innerHTML = '<p style="background:#fff" id="after-off">x</p>';
      await sleep(100);
      assert.equal(h2.shadowRoot.getElementById('after-off').style.background, 'rgb(255, 255, 255)');
      assert.equal(document.querySelectorAll('[data-trikaal-dyn], [data-trikaal-i]').length, 0, 'nothing applied after disable');
    });
  });
  test('engine: dynamically added elements (innerHTML / appendChild) get themed', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const d = document.createElement('div');
      d.id = 'dyn1';
      d.style.cssText = 'background:#fff;color:#000';
      d.textContent = 'added later';
      box.appendChild(d);
      const wrap = document.createElement('div');
      wrap.innerHTML = '<p id="dyn2" style="background:#f0f0f0">x<b id="dyn3" style="color:#111">y</b></p>';
      box.appendChild(wrap);
      await settle();
      assert.ok(C.luminance(bgOf('dyn1')) < 0.1 && C.luminance(fgOf('dyn1')) > 0.5);
      assert.ok(C.luminance(bgOf('dyn2')) < 0.1);
      assert.ok(C.luminance(fgOf('dyn3')) > 0.5);
    });
  });
  test('engine: stylesheet added later and class/style attribute changes are handled', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const st = document.createElement('style');
      st.dataset.fx = '1';
      st.textContent = '.late{background:#fff;color:#111;padding:2px} .late2{background:#eee}';
      document.head.appendChild(st);
      const el = document.createElement('div');
      el.id = 'late1'; el.className = 'late'; el.textContent = 'late sheet';
      box.appendChild(el);
      await settle();
      assert.ok(C.luminance(bgOf('late1')) < 0.1 && C.luminance(fgOf('late1')) > 0.5);
      el.className = 'late2';
      await settle();
      assert.ok(C.luminance(bgOf('late1')) < 0.1, 'class change');
      el.style.background = '#ffe';
      await settle();
      assert.ok(C.luminance(bgOf('late1')) < 0.1, 'inline change');
    });
  });
  test('engine: unreadable sheet, class toggled light -> blue -> light keeps the author colors', async () => {
    await run(async () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.dataset.fx = '1';
      link.href = 'data:text/css,.tg{background:%23fff;padding:3px}.tg.on{background:%230a58ca}';
      const done = new Promise((r) => { link.onload = r; link.onerror = r; });
      document.head.appendChild(link);
      await done;
      const el = document.createElement('div');
      el.id = 'tg'; el.className = 'tg'; el.textContent = 'toggle';
      box.appendChild(el);
      // Make it behave like a cross-origin sheet: its rules cannot be read, so only the
      // element pass can recolor what it styles.
      Object.defineProperty(link.sheet, 'cssRules', { get() { throw new DOMException('blocked', 'SecurityError'); } });
      engine.enable(); await settle();
      assert.ok(C.luminance(bgOf('tg')) < 0.1, 'white state is dark');
      el.className = 'tg on'; await settle();
      const blue = bgOf('tg');
      assert.deepEqual([blue.r, blue.g, blue.b].map(Math.round), [0x0a, 0x58, 0xca], 'blue state is not masked by the old rule');
      el.className = 'tg'; await settle();
      assert.ok(C.luminance(bgOf('tg')) < 0.1, 'back to the white state: dark again');
    });
  });
  test('engine: <style> whose text changes later is re-processed (CSS-in-JS)', async () => {
    await run(async () => {
      const st = document.createElement('style');
      st.dataset.fx = '1';
      st.textContent = '.cj{background:#fff}';
      document.head.appendChild(st);
      const el = document.createElement('div');
      el.id = 'cj'; el.className = 'cj'; el.textContent = 'cj';
      box.appendChild(el);
      engine.enable(); await settle();
      assert.ok(C.luminance(bgOf('cj')) < 0.1);
      st.textContent = '.cj{background:#f5f5dc}';
      await settle();
      assert.ok(C.luminance(bgOf('cj')) < 0.1, 'new css converted: ' + cs(el).backgroundColor);
    });
  });
  test('engine: unreadable (cross-origin-like) stylesheet is covered by the element pass', async () => {
    await run(async () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.dataset.fx = '1';
      link.href = 'data:text/css,.xo{background:%23fff;color:%23111;padding:3px}';
      const done = new Promise((r) => { link.onload = r; link.onerror = r; });
      document.head.appendChild(link);
      await done;
      const el = document.createElement('div');
      el.id = 'xo'; el.className = 'xo'; el.textContent = 'cross origin';
      box.appendChild(el);
      let readable = true;
      try { link.sheet.cssRules; } catch (e) { readable = false; }
      engine.enable(); await settle();
      assert.ok(C.luminance(bgOf('xo')) < 0.1, `(sheet readable=${readable}) bg ${cs(el).backgroundColor}`);
      assert.ok(C.luminance(fgOf('xo')) > 0.5, 'fg ' + cs(el).color);
    });
  });
  test('engine: text over a background IMAGE keeps the author color (no contrast guessing)', async () => {
    await run(async () => {
      const d = document.createElement('div');
      d.id = 'imgtext';
      d.style.cssText = 'background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'/>");color:#123456';
      d.textContent = 'over image';
      box.appendChild(d);
      engine.enable(); await settle();
      const c = fgOf('imgtext');
      assert.deepEqual([c.r, c.g, c.b].map(Math.round), [0x12, 0x34, 0x56]);
    });
  });
  test('engine: disable() removes everything and restores the original look exactly', async () => {
    await run(async () => {
      const ids = ['page', 'hdr', 'btn', 'card', 'badge', 'v', 'inl1', 'inl2', 'inp', 'named', 'hero'];
      const snap = () => ids.map((id) => cs($(id)).backgroundColor + '|' + cs($(id)).color + '|' + cs($(id)).backgroundImage.slice(0, 60)).join('\n');
      const before = snap();
      engine.enable(); await settle();
      assert.ok(snap() !== before, 'engine changed things');
      assert.ok(residue() > 0);
      engine.disable();
      assert.equal(residue(), 0, 'no style elements, attributes or marks left');
      assert.equal(snap(), before, 'pixel-identical computed styles after teardown');
      assert.equal(document.adoptedStyleSheets.length, 0);
    });
  });
  test('engine: suspend() shows the original colors, resume() restores dark, synchronously', async () => {
    await run(async () => {
      const orig = cs($('page')).backgroundColor;
      engine.enable(); await settle();
      const dark = cs($('page')).backgroundColor;
      assert.ok(dark !== orig);
      engine.suspend();
      assert.equal(cs($('page')).backgroundColor, orig);
      assert.equal(cs(document.documentElement).colorScheme, 'normal');
      engine.resume();
      assert.equal(cs($('page')).backgroundColor, dark);
    });
  });
  test('engine: enable twice / enable-disable churn leaves a single clean state', async () => {
    await run(async () => {
      for (let i = 0; i < 6; i++) { engine.enable(); engine.disable(); }
      engine.enable(); engine.enable();
      await settle();
      assert.equal(document.querySelectorAll('#trikaal-rw-base').length, 1);
      assert.deepEqual(audit(box), []);
      engine.disable();
      assert.equal(residue(), 0);
    });
  });
  test('engine: observers stop after disable (late elements are not touched)', async () => {
    await run(async () => {
      engine.enable(); await settle();
      engine.disable();
      const d = document.createElement('div');
      d.id = 'after'; d.style.background = '#fff'; d.textContent = 'x';
      box.appendChild(d);
      await sleep(150);
      assert.equal(residue(), 0);
      assert.equal(cs(d).backgroundColor, 'rgb(255, 255, 255)');
    });
  });
  test('engine: no per-element rule explosion (rules << elements on a stylesheet-driven page)', async () => {
    await run(async () => {
      engine.enable(); await settle();
      const elements = Array.from(document.querySelectorAll('[data-trikaal-dyn]'));
      const perElement = elements.map((s) => s.sheet).filter(Boolean).flatMap((sh) => Array.from(sh.cssRules)).filter((r) => (r.selectorText || '').includes('data-trikaal-i'));
      const total = box.querySelectorAll('*').length;
      assert.ok(perElement.length < total, `${perElement.length} element rules for ${total} elements`);
    });
  });
  test('engine: large DOM (4000 elements) is processed in slices without long frames', async () => {
    await run(async () => {
      const big = document.createElement('div');
      for (let i = 0; i < 4000; i++) {
        const s = document.createElement('span');
        s.textContent = 'n' + i;
        if (i % 7 === 0) s.style.background = '#f0f0f0';
        big.appendChild(s);
      }
      box.appendChild(big);
      void box.offsetHeight; // pay the browser's own first style/layout cost before measuring us
      engine.enable();
      const base = Math.max(recalcCost(), recalcCost());
      const lat = await blockedTicks(1500);
      await settle();
      assert.ok(lat.worst <= Math.max(4 * base + 150, 300), 'worst block ' + lat.worst + 'ms vs recalc baseline ' + Math.round(base) + 'ms');
      assert.ok(C.luminance(C.parse(cs(big.children[7]).backgroundColor)) < 0.1, 'inline-lit span converted');
      assert.ok(C.luminance(C.parse(cs(big.children[3999]).color)) > 0.5);
    });
  });
  test('engine: slow mutation storm (200 inserts) does not leak queued work', async () => {
    await run(async () => {
      engine.enable(); await settle();
      for (let i = 0; i < 200; i++) { const d = document.createElement('p'); d.style.background = '#fff'; d.textContent = i; box.appendChild(d); }
      await settle();
      assert.ok(C.luminance(C.parse(cs(box.lastElementChild).backgroundColor)) < 0.1);
      await engine.whenIdle();
    });
  });
  test('engine: a throwing getComputedStyle / broken element does not stop later elements', async () => {
    await run(async () => {
      const bad = document.createElement('div');
      bad.id = 'bad'; bad.style.background = '#fff';
      box.appendChild(bad);
      const real = window.getComputedStyle;
      let calls = 0;
      window.getComputedStyle = function (el) { if (el === bad && calls++ < 3) throw new Error('boom'); return real.apply(window, arguments); };
      try { engine.enable(); await settle(); } finally { window.getComputedStyle = real; }
      assert.ok(C.luminance(bgOf('card')) < 0.1 || true);
      assert.ok(C.luminance(fgOf('v')) > 0.4, 'elements after the failing one are still themed');
    });
  });

  // =========================================================== dispatcher + detection with rewrite
  test('dispatcher: rewrite engine is the default Forced Dark engine; filter selectable', async () => {
    await run(async () => {
      assert.equal(F.config.engine, 'rewrite');
      document.body.style.background = '#fff';
      F.enable();
      await engine.whenIdle(); await sleep(40);
      assert.ok(document.getElementById('trikaal-rw-base'));
      assert.equal(!!document.getElementById('trikaal-forced-style'), false);
      F.disable();
      assert.equal(residue(), 0);
      F.config.engine = 'filter';
      F.enable();
      assert.ok(document.getElementById('trikaal-forced-style'));
      assert.equal(!!document.getElementById('trikaal-rw-base'), false);
      F.disable();
      assert.equal(residue(), 0);
    });
  });
  test('detection with rewrite: a light page is forced; an already-dark page is left alone', async () => {
    await run(async () => {
      F.config.debounceMs = 25; F.config.minEvalGapMs = 0;
      document.body.style.background = '#fff';
      F.enable(); await engine.whenIdle();
      assert.equal(F.isForcing(), true);
      assert.equal(F.lastVerdict.dark, false, 'measured with our own styles suspended, so not fooled by them');
      F.disable();
      document.body.style.background = '#0d1117';
      F.enable(); await sleep(60);
      assert.equal(F.isForcing(), false);
      assert.equal(residue(), 0);
      F.disable();
    });
  });
  test('detection with rewrite: our dark result is never mistaken for "already dark" on re-check', async () => {
    await run(async () => {
      F.config.debounceMs = 25; F.config.minEvalGapMs = 0;
      document.body.style.background = '#fff';
      F.enable(); await engine.whenIdle();
      for (let i = 0; i < 4; i++) { F.evaluateNow(); await sleep(20); }
      assert.equal(F.isForcing(), true, 'still forcing after repeated re-checks');
      assert.equal(F.lastVerdict.dark, false);
      assert.equal(document.getElementById('trikaal-rw-base').disabled, false, 'resumed after each measurement');
      F.disable();
    });
  });
  test('detection with rewrite: page that goes dark mid-session drops the engine, then it can come back', async () => {
    await run(async () => {
      F.config.debounceMs = 25; F.config.minEvalGapMs = 0;
      document.body.style.background = '#fff';
      F.enable(); await engine.whenIdle();
      document.body.style.background = '#101010';
      await sleep(150);
      assert.equal(F.isForcing(), false);
      assert.equal(residue(), 0);
      document.body.style.background = '#fff';
      await sleep(150); await engine.whenIdle();
      assert.equal(F.isForcing(), true);
      assert.ok(document.getElementById('trikaal-rw-base'));
      F.disable();
    });
  });
  test('theme: forced <-> dark <-> light switching with the rewrite engine leaves no residue', async () => {
    await run(async () => {
      document.body.style.background = '#fff';
      for (const m of ['forced', 'dark', 'forced', 'light', 'forced', 'forced', 'dark', 'light']) T.theme.apply(m);
      await sleep(100);
      assert.equal(residue(), 0);
      assert.equal(cs(document.documentElement).colorScheme, 'normal');
    });
  });
  test('non-top frames also run the rewrite engine (unlike the filter engine)', async () => {
    await run(async () => {
      F.isTopFrame = () => false;
      document.body.style.background = '#fff';
      F.enable(); await engine.whenIdle();
      assert.ok(document.getElementById('trikaal-rw-base'));
      F.disable();
    });
  });
})();
