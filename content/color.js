// Color parsing and basic color math, shared by already-dark detection (Phase 5)
// and the color-rewriting engine (Phase 6).
//
// A parsed color is { r, g, b, a } with r/g/b in 0..255 and a in 0..1.
(() => {
  'use strict';
  const T = (window.Trikaal = window.Trikaal || {});

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cache = new Map(); // string -> parsed color | null (bounded, see parse())
  const CACHE_MAX = 5000;

  // Anything the cheap parsers below don't understand (named colors, lab(), oklch(),
  // color-mix(), ...) is resolved by the browser itself through a 1x1 canvas.
  let ctx = null;
  function canvasParse(str) {
    try {
      if (!ctx) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        ctx = c.getContext('2d', { willReadFrequently: true });
      }
      // Assigning an invalid color leaves fillStyle unchanged, so use two different
      // sentinels to tell "invalid" apart from "valid and equal to the sentinel".
      ctx.fillStyle = '#010203';
      ctx.fillStyle = str;
      const a = ctx.fillStyle;
      ctx.fillStyle = '#030201';
      ctx.fillStyle = str;
      const b = ctx.fillStyle;
      if (a !== b) return null;
      // The getter may echo modern syntaxes (oklch(), lab(), ...) unconverted, so
      // read the actual sRGB pixel instead.
      const simple = parseSimple(a);
      if (simple) return simple;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) {
      return null;
    }
  }

  function num(tok, scale) {
    tok = tok.trim();
    if (tok.endsWith('%')) return (parseFloat(tok) / 100) * scale;
    return parseFloat(tok);
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  function parseAlpha(tok) {
    if (tok == null || tok === '') return 1;
    const v = num(tok, 1);
    return Number.isNaN(v) ? 1 : clamp(v, 0, 1);
  }

  // Handles: transparent, #rgb[a], #rrggbb[aa], rgb()/rgba() (comma or space syntax,
  // % channels, / alpha), hsl()/hsla(), color(srgb r g b / a).
  function parseSimple(s) {
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    let m;
    if (s[0] === '#') {
      const h = s.slice(1);
      if (!/^[0-9a-f]+$/.test(h)) return null;
      if (h.length === 3 || h.length === 4) {
        const v = h.split('').map((c) => parseInt(c + c, 16));
        return { r: v[0], g: v[1], b: v[2], a: h.length === 4 ? v[3] / 255 : 1 };
      }
      if (h.length === 6 || h.length === 8) {
        return {
          r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
          a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
        };
      }
      return null;
    }
    if ((m = /^rgba?\(\s*([^)]*)\)$/.exec(s))) {
      const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
      if (parts.length < 3) return null;
      const r = num(parts[0], 255), g = num(parts[1], 255), b = num(parts[2], 255);
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: parseAlpha(parts[3]) };
    }
    if ((m = /^hsla?\(\s*([^)]*)\)$/.exec(s))) {
      const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
      if (parts.length < 3) return null;
      const h = parseFloat(parts[0]);
      const sat = num(parts[1], 1), l = num(parts[2], 1);
      if ([h, sat, l].some(Number.isNaN)) return null;
      const [r, g, b] = hslToRgb(h, sat, l);
      return { r, g, b, a: parseAlpha(parts[3]) };
    }
    if ((m = /^color\(\s*srgb\s+([^)]*)\)$/.exec(s))) {
      const parts = m[1].split(/\s*\/\s*|\s+/).filter(Boolean);
      if (parts.length < 3) return null;
      const v = parts.slice(0, 3).map((p) => num(p, 1) * 255);
      if (v.some(Number.isNaN)) return null;
      return { r: clamp(v[0], 0, 255), g: clamp(v[1], 0, 255), b: clamp(v[2], 0, 255), a: parseAlpha(parts[3]) };
    }
    return null;
  }

  // Returns a parsed color or null. Results are memoized (including failures).
  function parse(str) {
    if (typeof str !== 'string') return null;
    const key = str.trim().toLowerCase();
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    let out = null;
    try { out = parseSimple(key) || canvasParse(key); } catch (e) { out = null; }
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, out);
    return out;
  }

  // WCAG relative luminance: 0 (black) .. 1 (white). Channels are gamma-decoded first
  // because perceived brightness is not linear in the sRGB values.
  function luminance(c) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  }

  // Source-over compositing of `top` on an opaque `bottom` (alpha of result = 1).
  function over(top, bottom) {
    const a = top.a;
    return {
      r: top.r * a + bottom.r * (1 - a),
      g: top.g * a + bottom.g * (1 - a),
      b: top.b * a + bottom.b * (1 - a),
      a: 1,
    };
  }

  const toCss = (c) => (c.a >= 1
    ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
    : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`);

  function toHsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s, l, a: c.a };
  }

  function fromHsl(h, s, l, a) {
    const [r, g, b] = hslToRgb(h, s, l);
    return { r, g, b, a: a == null ? 1 : a };
  }

  // WCAG contrast ratio between two relative luminances (1 = none, 21 = black/white).
  function contrast(lumA, lumB) {
    const hi = Math.max(lumA, lumB), lo = Math.min(lumA, lumB);
    return (hi + 0.05) / (lo + 0.05);
  }

  // ---------------------------------------------------------------- dark mapping
  // Works in HSL so hue is preserved (blue stays blue) and only lightness/saturation
  // move. Three roles because the same light color needs different treatment:
  //
  //   bg     light backgrounds become dark, darker the lighter they were, so the
  //          ordering "page < card < raised surface" still reads correctly
  //          (white page -> L .09, light-gray card (L .96) -> L .11, i.e. slightly
  //          lighter than the page). Backgrounds that are already dark are left alone.
  //   fg     dark text becomes light (black -> L .90, #333 -> .80); text that is
  //          already light stays. Mid grays stay mid so they remain readable.
  //   border light lines become dark-but-visible; dark lines become mid gray.
  //
  // Outputs of each role land in a range the same function leaves untouched
  // (bg < .5, fg >= .65), so re-applying it is harmless (idempotent).
  const BG_BASE = 0.09, BG_SPAN = 0.4;

  function mapColor(c, role) {
    const { h, s, l, a } = toHsl(c);
    let nl = l, ns = s;
    if (role === 'bg') {
      if (l >= 0.5) {
        nl = BG_BASE + (1 - l) * BG_SPAN;
        ns = s * (l > 0.8 ? 0.6 : 0.9); // pale tints turn into deep, calmer tints
      }
    } else if (role === 'border') {
      if (l >= 0.5) { nl = 0.1 + (1 - l) * 0.5; ns = s * 0.7; }
      else { nl = 0.5 - 0.4 * l; ns = s * 0.7; }
    } else if (l < 0.5) { // fg
      nl = 0.9 - 0.5 * l;
      ns = s * 0.85;
    }
    return fromHsl(h, ns, nl, a);
  }

  T.color = {
    parse, luminance, over, toCss, hslToRgb, toHsl, fromHsl, contrast, mapColor, clamp,
    _clearCache: () => cache.clear(),
  };
})();
