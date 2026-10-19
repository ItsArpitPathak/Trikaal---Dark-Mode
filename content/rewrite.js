// Trikaal Forced Dark, engine 2: real color rewriting.
//
// How it works (two cooperating passes, both writing ONLY into <style> elements so
// the page's own styles and DOM are never edited and everything can be removed):
//
//  A. Stylesheet pass. Every readable stylesheet rule that sets a color is copied
//     into our own stylesheet (inserted right after the original, same selector, so
//     same specificity and order) with its colors converted and marked !important.
//     That keeps :hover/:focus states, media queries, @layer, @container, @supports
//     and @keyframes working. Custom properties holding colors are converted too,
//     with the light/dark treatment chosen from how the variable is used.
//     Cross-origin stylesheets throw on .cssRules; they are skipped here and the
//     element pass (B) covers them instead.
//
//  B. Element pass. Reads *computed* styles (so it also sees var() results, inline
//     styles, presentation attributes and unreadable sheets) and adds a per-element
//     rule only where something light is still left over or where text would be
//     unreadable. Elements carry a `data-trikaal-i` id so the rule can target them.
//
// Both passes are time-sliced (a few ms per frame) and fed by MutationObservers, so
// SPAs, infinite scroll, new stylesheets and open shadow roots are picked up.
// Color math lives in content/color.js (HSL mapping + memoized parser).
(() => {
  'use strict';
  const T = (window.Trikaal = window.Trikaal || {});
  const C = T.color;

  const ATTR = 'data-trikaal-i';        // per-element id
  const DYN = 'data-trikaal-dyn';       // marks every style element we create
  const BASE_ID = 'trikaal-rw-base';
  const BASE_CANVAS = { r: 24, g: 24, b: 24, a: 1 }; // matches the base html background
  const BUDGET_MS = 8;                  // main-thread time per slice
  const BATCH = 400;                    // upper bound on elements per slice
  const MIN_CONTRAST = 3.2;
  const CHURN_LIMIT = 8, CHURN_WINDOW_MS = 1000; // see throttled()

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'AREA', 'MAP', 'DATALIST', 'OPTION', 'OPTGROUP']);
  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'SOURCE', 'AUDIO', 'IFRAME', 'EMBED', 'OBJECT', 'TRACK', 'IMAGE']);
  const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

  // property -> role
  const COLOR_PROPS = {
    'color': 'fg', '-webkit-text-fill-color': 'fg', '-webkit-text-stroke-color': 'fg',
    'text-decoration-color': 'fg', 'text-emphasis-color': 'fg', 'caret-color': 'fg',
    'fill': 'fg', 'stroke': 'fg',
    'background-color': 'bg',
    'border-top-color': 'border', 'border-right-color': 'border', 'border-bottom-color': 'border',
    'border-left-color': 'border', 'outline-color': 'border', 'column-rule-color': 'border',
  };
  const COLOR_PROP_NAMES = Object.keys(COLOR_PROPS);
  const BG_IMAGE = 'background-image';
  // Where a custom property is *used* tells us which role its color plays.
  const USAGE_ROLE = {
    'background': 'bg', 'background-color': 'bg', 'background-image': 'bg',
    'color': 'fg', 'fill': 'fg', 'stroke': 'fg', 'caret-color': 'fg', '-webkit-text-fill-color': 'fg', 'text-decoration-color': 'fg',
    'border': 'border', 'border-color': 'border', 'border-top': 'border', 'border-right': 'border', 'border-bottom': 'border',
    'border-left': 'border', 'border-top-color': 'border', 'border-right-color': 'border', 'border-bottom-color': 'border',
    'border-left-color': 'border', 'outline': 'border', 'outline-color': 'border', 'column-rule-color': 'border',
  };
  const USAGE_PROPS = Object.keys(USAGE_ROLE);
  const INLINE_PROPS = COLOR_PROP_NAMES.concat([BG_IMAGE]);

  const COLOR_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']);
  const NOT_COLORS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'auto', 'normal']);

  // ------------------------------------------------------------ value rewriting
  const convCache = new Map();   // "role|token" -> css string | null
  const namedCache = new Map();  // word -> boolean
  const CACHE_MAX = 8000;

  function isNamedColor(word) {
    const w = word.toLowerCase();
    if (NOT_COLORS.has(w)) return false;
    let v = namedCache.get(w);
    if (v === undefined) {
      try { v = CSS.supports('color', w); } catch (e) { v = false; }
      namedCache.set(w, v);
    }
    return v;
  }

  // Converts one color token (hex, rgb(), name, ...) for a role; null = leave as is.
  function convertToken(token, role) {
    const key = role + '|' + token;
    let out = convCache.get(key);
    if (out !== undefined) return out;
    const c = C.parse(token);
    out = c && c.a > 0 ? C.toCss(C.mapColor(c, role)) : null;
    if (convCache.size >= CACHE_MAX) convCache.clear();
    convCache.set(key, out);
    return out;
  }

  function matchParen(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return i;
    }
    return s.length - 1;
  }

  const IDENT_START = /[a-zA-Z_-]/;
  const IDENT_CHAR = /[\w-]/;

  // Rewrites every color inside a CSS value (plain colors, gradients, shorthands).
  // url(...) and var(...) names are left alone; colors in var() fallbacks are converted.
  function mapValue(value, role) {
    if (!value) return value;
    let out = '';
    let i = 0;
    const n = value.length;
    while (i < n) {
      const ch = value[i];
      if (ch === '#') {
        let j = i + 1;
        while (j < n && /[0-9a-fA-F]/.test(value[j])) j++;
        const tok = value.slice(i, j);
        out += convertToken(tok, role) || tok;
        i = j;
      } else if (IDENT_START.test(ch)) {
        let j = i + 1;
        while (j < n && IDENT_CHAR.test(value[j])) j++;
        const ident = value.slice(i, j);
        if (value[j] === '(') {
          const k = matchParen(value, j);
          const lname = ident.toLowerCase();
          if (COLOR_FUNCS.has(lname)) {
            const full = value.slice(i, k + 1);
            out += convertToken(full, role) || full;
          } else if (lname === 'url' || lname === 'image-set' || lname === 'element') {
            out += value.slice(i, k + 1);
          } else {
            out += ident + '(' + mapValue(value.slice(j + 1, k), role) + ')';
          }
          i = k + 1;
        } else {
          out += isNamedColor(ident) ? (convertToken(ident, role) || ident) : ident;
          i = j;
        }
      } else if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n && value[j] !== ch) j += value[j] === '\\' ? 2 : 1;
        out += value.slice(i, j + 1);
        i = j + 1;
      } else {
        out += ch;
        i++;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ custom properties
  const varVotes = new Map(); // "--name" -> { bg, fg, border }

  function collectUsage(rules) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      try {
        if (rule.style && rule.selectorText !== undefined) {
          for (const prop of USAGE_PROPS) {
            const v = rule.style.getPropertyValue(prop);
            if (!v || v.indexOf('var(') === -1) continue;
            const re = /var\(\s*(--[\w-]+)/g;
            let m;
            while ((m = re.exec(v))) {
              let votes = varVotes.get(m[1]);
              if (!votes) varVotes.set(m[1], (votes = { bg: 0, fg: 0, border: 0 }));
              votes[USAGE_ROLE[prop]]++;
            }
          }
        }
        if (rule.cssRules) collectUsage(rule.cssRules);
        if (rule.styleSheet) { try { collectUsage(rule.styleSheet.cssRules); } catch (e) { /* cross-origin import */ } }
      } catch (e) { /* ignore a bad rule */ }
    }
  }

  function varRole(name, color) {
    const v = varVotes.get(name);
    if (v && (v.bg || v.fg || v.border)) {
      if (v.bg >= v.fg && v.bg >= v.border) return 'bg';
      return v.fg >= v.border ? 'fg' : 'border';
    }
    // Never used in a readable sheet: light values are usually backgrounds, dark ones text.
    return C.toHsl(color).l >= 0.5 ? 'bg' : 'fg';
  }

  const TRIPLET = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/;

  // Value of a custom property definition, or null if it isn't a plain color.
  function convertVarValue(name, value) {
    const v = value.trim();
    if (!v) return null;
    let m;
    if ((m = TRIPLET.exec(v))) { // "255, 255, 255" used inside rgba(var(--x), .5)
      const c = { r: +m[1], g: +m[2], b: +m[3], a: 1 };
      const mapped = C.mapColor(c, varRole(name, c));
      return `${Math.round(mapped.r)}, ${Math.round(mapped.g)}, ${Math.round(mapped.b)}`;
    }
    if (v.indexOf('var(') !== -1) return null;
    const c = C.parse(v);
    if (!c || c.a === 0) return null;
    return C.toCss(C.mapColor(c, varRole(name, c)));
  }

  // ------------------------------------------------------------ rule rewriting
  function declsFor(style, important) {
    const out = [];
    const bang = important ? '!important' : '';
    for (const prop of COLOR_PROP_NAMES) {
      const v = style.getPropertyValue(prop);
      if (!v || v.indexOf('var(') !== -1 && !/var\([^)]*,/.test(v)) continue;
      const nv = mapValue(v, COLOR_PROPS[prop]);
      if (nv !== v) out.push(`${prop}:${nv}${bang}`);
    }
    const bi = style.getPropertyValue(BG_IMAGE);
    if (bi && bi.indexOf('gradient') !== -1) {
      const nv = mapValue(bi, 'bg');
      if (nv !== bi) out.push(`${BG_IMAGE}:${nv}${bang}`);
    }
    if (important) {
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        if (name.charCodeAt(0) !== 45 || name.charCodeAt(1) !== 45) continue; // "--"
        const nv = convertVarValue(name, style.getPropertyValue(name));
        if (nv != null && nv !== style.getPropertyValue(name).trim()) out.push(`${name}:${nv}!important`);
      }
    }
    return out;
  }

  const has = (name) => typeof window[name] === 'function';

  // Returns an array of CSS rule strings for one source rule ([] if nothing to change).
  function rewriteRule(rule) {
    try {
      if (has('CSSStyleRule') && rule instanceof CSSStyleRule) {
        const d = declsFor(rule.style, true);
        return d.length ? [`${rule.selectorText}{${d.join(';')}}`] : [];
      }
      if (has('CSSKeyframesRule') && rule instanceof CSSKeyframesRule) {
        let body = '';
        for (const kf of rule.cssRules) {
          const d = declsFor(kf.style, false);
          if (d.length) body += `${kf.keyText}{${d.join(';')}}`;
        }
        return body ? [`@keyframes ${rule.name}{${body}}`] : [];
      }
      if (has('CSSImportRule') && rule instanceof CSSImportRule) {
        let inner = [];
        try { inner = rewriteList(rule.styleSheet.cssRules); } catch (e) { /* cross-origin import */ }
        const media = rule.media && rule.media.mediaText;
        return inner.length && media && media !== 'all' ? [`@media ${media}{${inner.join('')}}`] : inner;
      }
      let header = null;
      if (has('CSSMediaRule') && rule instanceof CSSMediaRule) header = '@media ' + rule.media.mediaText;
      else if (has('CSSSupportsRule') && rule instanceof CSSSupportsRule) header = '@supports ' + rule.conditionText;
      else if (has('CSSLayerBlockRule') && rule instanceof CSSLayerBlockRule) header = '@layer' + (rule.name ? ' ' + rule.name : '');
      else if (has('CSSContainerRule') && rule instanceof CSSContainerRule) header = '@container ' + (rule.containerName ? rule.containerName + ' ' : '') + (rule.containerQuery || rule.conditionText);
      if (header && rule.cssRules) {
        const inner = rewriteList(rule.cssRules);
        return inner.length ? [`${header}{${inner.join('')}}`] : [];
      }
    } catch (e) { /* a rule we can't read or re-serialize is skipped */ }
    return [];
  }

  function rewriteList(rules) {
    const out = [];
    for (let i = 0; i < rules.length; i++) for (const t of rewriteRule(rules[i])) out.push(t);
    return out;
  }

  // ------------------------------------------------------------ engine
  function createRewriteEngine() {
    let active = false;
    let gen = 0;
    const scopes = new Map();      // Document | ShadowRoot -> scope
    const jobs = [];               // pending stylesheet jobs
    const ownStyles = new Set();   // every <style> we created (for suspend/resume)
    const ownConstructed = new Set();
    let elRule = new WeakMap();    // element -> its one CSSStyleRule in the elements sheet
    let idCounter = 0;
    let timer = false;
    let idleWaiters = [];
    let readyCleanups = [];

    const isOwn = (n) => n.nodeType === 1 && (n.hasAttribute(DYN) || n.id === BASE_ID);

    // ---- style targets -------------------------------------------------------
    // A target is something we can insertRule() into.
    function makeTarget(scope, ownerNode, mediaText) {
      try {
        const st = document.createElement('style');
        st.setAttribute(DYN, '1');
        if (mediaText && mediaText !== 'all') st.media = mediaText;
        const parent = ownerNode && ownerNode.parentNode;
        if (parent) parent.insertBefore(st, ownerNode.nextSibling);
        else scope.container.appendChild(st);
        if (st.sheet) { ownStyles.add(st); return { sheet: st.sheet, el: st }; }
        st.remove();
      } catch (e) { /* fall through to a constructed sheet */ }
      try { // CSP that blocks injected <style>: constructed sheets are exempt
        const cs = new CSSStyleSheet();
        scope.root.adoptedStyleSheets = [...scope.root.adoptedStyleSheets, cs];
        ownConstructed.add({ cs, root: scope.root });
        return { sheet: cs, el: null };
      } catch (e) { return null; }
    }

    function insert(target, text) {
      try { target.sheet.insertRule(text, target.sheet.cssRules.length); } catch (e) { /* invalid in this context */ }
    }

    // ---- scopes (document + open shadow roots) --------------------------------
    function createScope(root) {
      const isShadow = root.nodeType === 11;
      const scope = {
        root, isShadow,
        container: isShadow ? root : document.documentElement,
        queue: new Set(), seen: new WeakSet(), watched: new WeakSet(),
        targets: new Map(), elementsTarget: null, observer: null, unreadable: false,
      };
      scopes.set(root, scope);
      scope.elementsTarget = makeTarget(scope, null, null);
      scope.observer = new MutationObserver((records) => onMutations(scope, records));
      scope.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'], characterData: true });
      return scope;
    }

    function scanScope(scope) {
      const root = scope.root;
      try {
        for (const s of Array.from(root.styleSheets)) if (s.ownerNode) watchSheetNode(scope, s.ownerNode);
      } catch (e) { /* ignore */ }
      try {
        for (const s of Array.from(root.adoptedStyleSheets || [])) enqueueSheet(scope, s);
      } catch (e) { /* ignore */ }
      queueTree(scope, isRootDoc(root) ? document.documentElement : root);
    }

    const isRootDoc = (root) => root.nodeType === 9;

    function ensureShadow(host) {
      const sr = host.shadowRoot;
      if (!sr || scopes.has(sr)) return;
      scanScope(createScope(sr));
    }

    // ---- stylesheet jobs -------------------------------------------------------
    function enqueueSheet(scope, sheet) {
      if (!sheet || scope.seen.has(sheet)) return;
      const owner = sheet.ownerNode;
      if (owner && isOwn(owner)) return;
      let rules;
      try { rules = sheet.cssRules; } catch (e) { scope.unreadable = true; return; } // cross-origin
      scope.seen.add(sheet);
      collectUsage(rules);
      jobs.push({ scope, sheet, rules, i: 0, target: null });
      schedule();
    }

    function stepJob(job, over) {
      while (job.i < job.rules.length) {
        const texts = rewriteRule(job.rules[job.i++]);
        if (texts.length) {
          if (!job.target) {
            let media = '';
            try { media = job.sheet.media && job.sheet.media.mediaText; } catch (e) { /* ignore */ }
            job.target = makeTarget(job.scope, job.sheet.ownerNode, media);
            if (job.target && job.sheet.ownerNode) job.scope.targets.set(job.sheet.ownerNode, job.target);
          }
          if (!job.target) return true;
          for (const t of texts) insert(job.target, t);
        }
        if (over()) break;
      }
      return job.i >= job.rules.length;
    }

    function watchSheetNode(scope, node) {
      if (isOwn(node)) return;
      if (node.nodeName === 'STYLE') {
        if (node.sheet) enqueueSheet(scope, node.sheet);
      } else if (node.nodeName === 'LINK') {
        if (node.sheet) enqueueSheet(scope, node.sheet);
        if (!scope.watched.has(node)) {
          scope.watched.add(node);
          // Stylesheets arrive asynchronously. When one loads, process it; if it turned
          // out unreadable (cross-origin) re-run the element pass over the page.
          node.addEventListener('load', () => {
            if (!active || !scopes.has(scope.root)) return;
            if (node.sheet) enqueueSheet(scope, node.sheet);
            if (scope.unreadable) queueTree(scope, isRootDoc(scope.root) ? document.documentElement : scope.root);
          });
        }
      }
    }

    function reprocessStyleNode(scope, node) {
      const old = scope.targets.get(node);
      if (old) {
        if (old.el) { ownStyles.delete(old.el); old.el.remove(); }
        scope.targets.delete(node);
      }
      if (node.sheet) enqueueSheet(scope, node.sheet);
    }

    // ---- element pass ----------------------------------------------------------
    function queueTree(scope, node) {
      if (!node) return;
      if (node.nodeType === 1) {
        scope.queue.add(node);
        if (node.shadowRoot) ensureShadow(node);
        if (node.nodeName === 'STYLE' || node.nodeName === 'LINK') watchSheetNode(scope, node);
      }
      if (!node.querySelectorAll) { schedule(); return; }
      for (const el of node.querySelectorAll('*')) {
        scope.queue.add(el);
        if (el.shadowRoot) ensureShadow(el);
        const tag = el.nodeName;
        if (tag === 'STYLE' || tag === 'LINK') watchSheetNode(scope, el);
      }
      schedule();
    }

    // Elements whose class/style change many times per second (animations, carousels,
    // drag handles) would be re-read on every change. After CHURN_LIMIT changes inside
    // one second we stop queueing them and re-check once when the second is over.
    const churn = new WeakMap();
    function throttled(scope, el) {
      const now = performance.now();
      let c = churn.get(el);
      if (!c || now - c.start > CHURN_WINDOW_MS) { c = { start: now, n: 0, timer: 0 }; churn.set(el, c); }
      if (++c.n <= CHURN_LIMIT) return false;
      if (!c.timer) {
        c.timer = setTimeout(() => {
          c.timer = 0;
          if (active && el.isConnected && scopes.has(scope.root)) { scope.queue.add(el); schedule(); }
        }, CHURN_WINDOW_MS);
      }
      return true;
    }

    function onMutations(scope, records) {
      if (!active) return;
      for (const r of records) {
        if (r.type === 'childList') {
          if (r.target.nodeName === 'STYLE' && !isOwn(r.target)) reprocessStyleNode(scope, r.target);
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1 || isOwn(n)) continue;
            queueTree(scope, n);
          }
          for (const n of r.removedNodes) {
            if (n.nodeType === 1 && scope.targets.has(n)) reprocessStyleNode(scope, n);
          }
        } else if (r.type === 'attributes') {
          if (r.target.nodeType === 1 && !isOwn(r.target) && !throttled(scope, r.target)) scope.queue.add(r.target);
        } else if (r.type === 'characterData') {
          const p = r.target.parentNode;
          if (p && p.nodeName === 'STYLE' && !isOwn(p)) reprocessStyleNode(scope, p);
        }
      }
      schedule();
    }

    function hasOwnText(el) {
      let seen = 0;
      for (let n = el.firstChild; n && seen < 8; n = n.nextSibling, seen++) {
        if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      }
      return false;
    }

    // `predicted` maps elements of the current batch to the background color we are
    // about to give them, so contrast can be judged against the FINAL (dark)
    // background without committing first and forcing another style recalculation.
    //
    // Effective opaque background behind `el`, plus whether an image sits behind it.
    function effBg(el, cache, predicted) {
      let hit = cache.get(el);
      if (hit) return hit;
      const parent = el.parentElement || (el.parentNode && el.parentNode.nodeType === 11 ? el.parentNode.host : null);
      const parentRes = parent ? effBg(parent, cache, predicted) : { color: BASE_CANVAS, image: false };
      let color = parentRes.color, image = parentRes.image;
      const cs = getComputedStyle(el);
      const bg = predicted && predicted.has(el) ? predicted.get(el) : C.parse(cs.backgroundColor);
      if (bg && bg.a > 0) {
        color = C.over(bg, color);
        if (bg.a >= 0.99) image = false;
      }
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none' && bi.indexOf('url(') !== -1) image = true;
      hit = { color, image };
      cache.set(el, hit);
      return hit;
    }

    const isLightLeftover = (c) => c && c.a > 0 && C.toHsl(c).l >= 0.5 && C.luminance(c) >= 0.2;

    // Pass 1: backgrounds, borders, gradients, inline colors.
    function phase1(el, cache, predicted) {
      const decls = [];
      const cs = getComputedStyle(el);
      const inlineSet = new Set();
      const st = el.style;
      if (st && st.length) {
        let overImage = null;
        for (const prop of INLINE_PROPS) {
          const v = st.getPropertyValue(prop);
          if (!v) continue;
          inlineSet.add(prop);
          // Text drawn over a photo keeps the author's color: the photo was not
          // darkened, so the original contrast is the best we can know.
          const role = prop === BG_IMAGE ? 'bg' : COLOR_PROPS[prop];
          if (role === 'fg' && overImage === null) {
            const parent = el.parentElement;
            const bi = cs.backgroundImage;
            overImage = (bi && bi.indexOf('url(') !== -1) || (parent ? effBg(parent, cache, predicted).image : false);
          }
          // Always re-assert inline colors: our !important sheet rules would otherwise
          // override the author's inline style for the same property.
          const nv = role === 'fg' && overImage ? v : mapValue(v, role);
          decls.push(`${prop}:${nv}!important`);
          if (prop === 'background-color') { const pc = C.parse(nv); if (pc) predicted.set(el, pc); }
        }
      }
      if (!inlineSet.has('background-color')) {
        const bg = C.parse(cs.backgroundColor);
        if (isLightLeftover(bg)) {
          const mapped = C.mapColor(bg, 'bg');
          decls.push(`background-color:${C.toCss(mapped)}!important`);
          predicted.set(el, mapped);
        }
      }
      if (!inlineSet.has(BG_IMAGE)) {
        const bi = cs.backgroundImage;
        if (bi && bi.indexOf('gradient') !== -1) {
          const nv = mapValue(bi, 'bg');
          if (nv !== bi) decls.push(`${BG_IMAGE}:${nv}!important`);
        }
      }
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const prop = `border-${side}-color`;
        if (inlineSet.has(prop)) continue;
        if (parseFloat(cs[`border-${side}-width`]) > 0 && cs[`border-${side}-style`] !== 'none' && cs[`border-${side}-style`] !== 'hidden') {
          const bc = C.parse(cs[prop]);
          if (isLightLeftover(bc)) decls.push(`${prop}:${C.toCss(C.mapColor(bc, 'border'))}!important`);
        }
      }
      return decls;
    }

    // Pass 2: text / SVG paint that would be hard to read on the final background.
    function phase2(el, cache, predicted) {
      const tag = el.nodeName;
      const isSvgPart = el instanceof SVGElement && tag.toLowerCase() !== 'svg';
      if (!(FORM_TAGS.has(tag) || isSvgPart || hasOwnText(el))) return [];
      const eff = effBg(el, cache, predicted);
      if (eff.image) return []; // text over a photo: the author's choice stands
      const cs = getComputedStyle(el);
      const effLum = C.luminance(eff.color);
      const inline = el.style;
      const decls = [];
      const fix = (prop, value) => {
        const fg = C.parse(value);
        if (!fg || fg.a === 0) return;
        const shown = fg.a < 1 ? C.over(fg, eff.color) : fg;
        if (C.contrast(C.luminance(shown), effLum) >= MIN_CONTRAST) return;
        let next = C.toHsl(fg).l < 0.5 ? C.mapColor(fg, 'fg') : fg;
        const nextShown = next.a < 1 ? C.over(next, eff.color) : next;
        if (C.contrast(C.luminance(nextShown), effLum) < MIN_CONTRAST) {
          next = effLum < 0.4 ? { r: 232, g: 230, b: 227, a: 1 } : { r: 27, g: 27, b: 27, a: 1 };
        }
        decls.push(`${prop}:${C.toCss(next)}!important`);
      };
      // Inline colors were already decided in pass 1.
      if ((!isSvgPart || tag.toLowerCase() === 'text' || tag.toLowerCase() === 'tspan') && !(inline && inline.color)) fix('color', cs.color);
      if (isSvgPart) {
        if (cs.fill && cs.fill !== 'none' && cs.fill.indexOf('url(') === -1 && !(inline && inline.fill)) fix('fill', cs.fill);
        if (cs.stroke && cs.stroke !== 'none' && cs.stroke.indexOf('url(') === -1 && !(inline && inline.stroke)) fix('stroke', cs.stroke);
      }
      return decls;
    }

    // Each element owns exactly one rule, rewritten on every pass. Appending a new rule per
    // change left old ones behind: an old !important color then masked the author's new one
    // (a class toggled from white to blue stayed dark) and the sheet only ever grew.
    function ruleFor(scope, el) {
      let rule = elRule.get(el);
      if (rule) return rule;
      const sheet = scope.elementsTarget && scope.elementsTarget.sheet;
      if (!sheet) return null;
      let id = el.getAttribute(ATTR);
      if (!id) { id = String(++idCounter); el.setAttribute(ATTR, id); }
      try {
        // :not(#_) raises specificity so this beats same-element rules we copied from the page.
        const i = sheet.insertRule(`[${ATTR}="${id}"]:not(#_trikaal){}`, sheet.cssRules.length);
        rule = sheet.cssRules[i];
      } catch (e) { return null; }
      elRule.set(el, rule);
      return rule;
    }

    function commit(scope, ruleMap) {
      for (const [el, decls] of ruleMap) {
        const rule = ruleFor(scope, el);
        if (rule) rule.style.cssText = decls.join(';');
      }
    }

    // Batch size adapts to how expensive elements are on this page so one slice stays
    // near BUDGET_MS (style recalculation cost grows with document size).
    let batchSize = 60;
    // Cheap counters, handy when profiling a heavy page (engine.stats).
    const stats = { slices: 0, elements: 0, read: 0, commit: 0 };

    function processScope(scope, over) {
      const batch = [];
      for (const el of scope.queue) {
        scope.queue.delete(el);
        if (!el.isConnected || SKIP_TAGS.has(el.nodeName) || MEDIA_TAGS.has(el.nodeName) || isOwn(el)) continue;
        batch.push(el);
        if (batch.length >= batchSize || over()) break;
      }
      if (!batch.length) return;
      const t0 = performance.now();
      // Our own rule would hide the author's current colors from the reads below, so empty
      // it first; commit() refills it in the same task, before anything is painted.
      for (const el of batch) { const r = elRule.get(el); if (r) r.style.cssText = ''; }
      // One read pass (no writes in between, so the browser recalculates styles at most
      // once) followed by a single commit.
      const rules = new Map();
      const predicted = new Map();
      const cache1 = new Map();
      for (const el of batch) {
        try { const d = phase1(el, cache1, predicted); if (d.length) rules.set(el, d); } catch (e) { /* skip element */ }
      }
      const cache2 = new Map(); // fresh: pass 1 recorded the predicted backgrounds
      for (const el of batch) {
        try { const d = phase2(el, cache2, predicted); if (d.length) rules.set(el, (rules.get(el) || []).concat(d)); } catch (e) { /* skip element */ }
      }
      const t1 = performance.now();
      commit(scope, rules);
      const t2 = performance.now();
      stats.slices++; stats.elements += batch.length; stats.read += t1 - t0; stats.commit += t2 - t1;
      const elapsed = Math.max(1, t2 - t0);
      batchSize = Math.max(20, Math.min(BATCH, Math.round(batch.length * (BUDGET_MS * 1.5) / elapsed)));
    }

    // ---- scheduling ------------------------------------------------------------
    // Slices continue via MessageChannel (like React's scheduler): the next slice runs
    // as soon as the browser has had a chance to render, and, unlike rAF or timers, it
    // is not throttled in background tabs.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (!timer) return; // stale message from before a disable()
      timer = false;
      pump();
    };

    function schedule() {
      if (timer || !active) return;
      timer = true;
      channel.port2.postMessage(0);
    }

    const hasWork = () => jobs.length > 0 || Array.from(scopes.values()).some((s) => s.queue.size > 0);

    function pump() {
      if (!active) return;
      const start = performance.now();
      const over = () => performance.now() - start > BUDGET_MS;
      try {
        while (jobs.length && !over()) {
          if (stepJob(jobs[0], over)) jobs.shift();
        }
        if (!jobs.length) {
          for (const scope of Array.from(scopes.values())) {
            if (over()) break;
            processScope(scope, over);
          }
        }
      } catch (e) { /* never let a slice break the page */ }
      if (hasWork()) schedule();
      else { const w = idleWaiters; idleWaiters = []; w.forEach((fn) => fn()); }
    }

    // Resolves when all queued work has been applied (used by tests).
    function whenIdle() {
      return new Promise((resolve) => {
        if (!active || (!timer && !hasWork())) return resolve();
        idleWaiters.push(resolve);
      });
    }

    // ---- lifecycle -------------------------------------------------------------
    // The last rule lets the brightness/contrast/sepia sliders in (they set --trikaal-adj
    // on <html>); without them it is `filter: none`, which costs nothing.
    const BASE_CSS = ':root { color-scheme: dark !important; }\n'
      + 'html { background-color: #181818; }\n'
      + 'html { filter: var(--trikaal-adj, none) !important; }';

    function ensureBase(root) {
      if (document.getElementById(BASE_ID)) return;
      const st = document.createElement('style');
      st.id = BASE_ID;
      st.setAttribute(DYN, 'base');
      st.textContent = BASE_CSS;
      root.appendChild(st);
      ownStyles.add(st);
    }

    // The MAIN-world script (content/main-world.js) fires this on a host the moment an open
    // shadow root is attached to it, even long after the host was inserted.
    function onShadowAttached(e) {
      if (!active) return;
      try {
        const host = (e.composedPath && e.composedPath()[0]) || e.target;
        if (host && host.nodeType === 1 && host.shadowRoot) ensureShadow(host);
      } catch (err) { /* ignore */ }
    }

    function enable() {
      if (active) disable();
      active = true;
      const myGen = ++gen;
      T.util.whenRoot((root) => {
        ensureBase(root);
        const docScope = createScope(document);
        scanScope(docScope);
        document.addEventListener('trikaal-shadow-attached', onShadowAttached, true);
        readyCleanups.push(() => document.removeEventListener('trikaal-shadow-attached', onShadowAttached, true));
        // Safety net: a full re-check once parsing and loading are done.
        const again = () => { if (active && myGen === gen) queueTree(docScope, document.documentElement); };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', again, { once: true });
          readyCleanups.push(() => document.removeEventListener('DOMContentLoaded', again));
        }
        if (document.readyState !== 'complete') {
          window.addEventListener('load', again, { once: true });
          readyCleanups.push(() => window.removeEventListener('load', again));
        }
      }, () => myGen !== gen);
    }

    function disable() {
      active = false;
      gen++;
      timer = false;
      jobs.length = 0;
      readyCleanups.forEach((fn) => fn());
      readyCleanups = [];
      for (const scope of scopes.values()) {
        if (scope.observer) scope.observer.disconnect();
        scope.queue.clear();
        try {
          for (const el of scope.root.querySelectorAll('[' + ATTR + ']')) el.removeAttribute(ATTR);
        } catch (e) { /* ignore */ }
      }
      for (const st of ownStyles) { try { st.remove(); } catch (e) { /* ignore */ } }
      ownStyles.clear();
      for (const { cs, root } of ownConstructed) {
        try { root.adoptedStyleSheets = Array.from(root.adoptedStyleSheets).filter((s) => s !== cs); } catch (e) { /* ignore */ }
      }
      ownConstructed.clear();
      elRule = new WeakMap(); // the rules died with their sheets
      scopes.clear();
      const w = idleWaiters; idleWaiters = []; w.forEach((fn) => fn());
    }

    // Detection needs the page's real colors; flip our sheets off and on again
    // synchronously (no paint can happen in between).
    function setSuspended(flag) {
      for (const st of ownStyles) st.disabled = flag;
      for (const { cs } of ownConstructed) cs.disabled = flag;
    }

    return {
      enable, disable, whenIdle, stats,
      suspend: () => setSuspended(true),
      resume: () => setSuspended(false),
      supported: () => true,
    };
  }

  const engine = createRewriteEngine();
  if (T.forced && T.forced.engines) T.forced.engines.rewrite = engine;
  T.rewrite = { CHURN_LIMIT, CHURN_WINDOW_MS, mapValue, convertVarValue, rewriteRule, ATTR, DYN, BASE_ID, _votes: varVotes };
})();
