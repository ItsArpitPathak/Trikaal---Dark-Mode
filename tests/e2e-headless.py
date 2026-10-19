#!/usr/bin/env python3
"""End-to-end tests of the REAL extension in a real (headless) Chrome.

Dev tool only (not shipped). Unlike the mock-based suites, this loads the unpacked extension
through the DevTools `Extensions.loadUnpacked` command, so Chrome itself validates the
manifest, injects the content scripts (isolated and MAIN world), runs the service worker and
serves the real `chrome.storage`. Scenarios drive settings through the service worker and
assert on what actually happens to real pages: Light/Dark/Forced Dark, live updates without
reload, per-site overrides, exclusions, Auto + OS-theme emulation, flash-free first paint,
shadow DOM, iframes, SPAs, a strict-CSP page, a cross-origin stylesheet, restart persistence
and the popup. If the network is reachable it also runs a few real websites.

Usage:
    python tests/e2e-headless.py [--out DIR] [--no-external] [--only SUBSTRING] [--browser PATH]

Needs Python 3 and Chrome 111+ (uses --enable-unsafe-extension-debugging). Exit status 0 = all passed.
"""
import base64
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp_lite import Cdp, find_browser  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEBUG_PORT = 9446

# ----------------------------------------------------------------------------- page-side helpers
# Audits a page: every element that shows text must have contrast >= 3 against what is behind
# it, and no visible background may stay light. Walks into open shadow roots.
AUDIT_JS = r"""
(() => {
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  function behind(el) {
    const chain = []; for (let n = el; n; n = up(n)) chain.push(n);
    let color = { r: 255, g: 255, b: 255, a: 1 }, image = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const s = getComputedStyle(chain[i]); const bg = parse(s.backgroundColor);
      if (bg && bg.a > 0) { color = over(bg, color); if (bg.a >= 0.99) image = false; }
      if (s.backgroundImage.includes('url(')) image = true;
    }
    return { color, image };
  }
  const roots = [document]; const all = [];
  const collect = (root) => root.querySelectorAll('*').forEach((el) => { all.push(el); if (el.shadowRoot) { roots.push(el.shadowRoot); collect(el.shadowRoot); } });
  collect(document);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'OPTION', 'IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'IFRAME', 'NOSCRIPT', 'TEMPLATE', 'svg']);
  const hasText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());
  let checked = 0; const bad = [], light = [];
  for (const el of all) {
    if (SKIP.has(el.nodeName) || el instanceof SVGElement) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const bg = parse(s.backgroundColor);
    if (bg && bg.a > 0.5 && !s.backgroundImage.includes('url(') && lum(bg) >= 0.2 && el.getBoundingClientRect().width > 0) light.push((el.id || el.className || el.nodeName) + ' ' + s.backgroundColor);
    if (hasText(el) || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.nodeName)) {
      const b = behind(el); if (b.image) continue;
      const fg = parse(s.color); if (!fg) continue;
      const shown = fg.a < 1 ? over(fg, b.color) : fg;
      const l1 = lum(shown), l2 = lum(b.color);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      checked++;
      if (ratio < 3) bad.push((el.id || el.className || el.nodeName) + ' ' + ratio.toFixed(2) + ' fg ' + s.color + ' on rgb(' + Math.round(b.color.r) + ',' + Math.round(b.color.g) + ',' + Math.round(b.color.b) + ')');
    }
  }
  return { checked, bad: bad.slice(0, 10), badCount: bad.length, light: light.slice(0, 10), lightCount: light.length };
})()
"""

RESIDUE_JS = """document.querySelectorAll('#trikaal-rw-base, [data-trikaal-dyn], [data-trikaal-i], #trikaal-forced-style, #trikaal-style, #trikaal-adjust, [data-trikaal-keep], [data-trikaal-scheme]').length"""

FRAME_SAMPLER = """(() => { const s = []; window.__fr = s;
  const tick = () => { const cs = getComputedStyle(document.documentElement); const b = document.body;
    s.push({ bg: cs.backgroundColor, scheme: cs.colorScheme, body: !!b, state: document.readyState,
             bbg: b ? getComputedStyle(b).backgroundColor : null,
             op: b ? getComputedStyle(b).opacity : null,
             off: document.documentElement.hasAttribute('data-trikaal-off'),
             base: !!document.getElementById('trikaal-rw-base') });
    if (s.length < 60) requestAnimationFrame(tick); };
  requestAnimationFrame(tick); })()"""


def flash_problems(frames, native_dark_body=None):
    """A painted frame must never show an unthemed page: the canvas has to be dark from the
    very first frame, and the body may only be visible once Forced Dark is installed.
    For a page that is dark by itself (native_dark_body = its body colour) the guard is
    released at once and the page's own dark colours are what is painted."""
    bad = []
    for i, f in enumerate(frames):
        if native_dark_body and f['off'] and not f['base']:
            if f['bbg'] != native_dark_body:
                bad.append(f'frame {i}: natively dark page showed {f["bbg"]} {f}')
            continue
        if f['scheme'] != 'dark':
            bad.append(f'frame {i}: canvas not dark {f}')
        elif f['body'] and f['op'] != '0' and not f['base']:
            bad.append(f'frame {i}: body visible before Forced Dark was installed {f}')
    return bad


LONGTASK_SAMPLER = """(() => { window.__lt = [];
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); } catch (e) {} })()"""

# ----------------------------------------------------------------------------- servers
class Handler(http.server.SimpleHTTPRequestHandler):
    xo_base = ''  # origin used for the cross-origin stylesheet page

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        path = self.path.split('?')[0]
        if path.endswith('/csp.html') or path.endswith('/csp.css'):
            # No inline styles and no inline script: injected <style> must still work.
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'")
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0].endswith('/big.html'):
            # A large, realistic-ish page: many cards with class- and inline-driven light colours.
            n = 6000
            if '?n=' in self.path:
                n = int(self.path.split('?n=')[1].split('&')[0])
            rules = ''.join(f'.c{i % 40}{{background:#{(0xf0 + i % 15):02x}{(0xf0 + i % 13):02x}{(0xf0 + i % 11):02x};color:#{i % 5}{i % 5}{i % 5};border:1px solid #ddd}}\n' for i in range(400))
            rows = ''.join(
                f'<div class="card c{i % 40}"><h3>Item {i}</h3><p>Some text for item {i} <a href="#">link</a></p>'
                f'<span style="background:#fafafa;padding:2px">tag {i % 9}</span></div>\n' for i in range(n // 5))
            body = ('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Big page</title>'
                    f'<style>body{{margin:0;background:#fff;color:#222;font:14px sans-serif}}.card{{padding:6px;margin:4px}}\n{rules}</style></head>'
                    f'<body><h1>Big page</h1>{rows}</body></html>').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split('?')[0].endswith('/xo.html'):
            body = open(os.path.join(ROOT, 'tests', 'pages', 'xo.html'), encoding='utf-8').read().replace('__XO__', Handler.xo_base).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def serve():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ----------------------------------------------------------------------------- browser session
class Tab:
    def __init__(self, session, target_id, cdp):
        self.session, self.id, self.cdp = session, target_id, cdp
        for method in ('Page.enable', 'Runtime.enable', 'Log.enable'):
            cdp.call(method)

    def eval(self, expr, await_promise=False):
        return self.cdp.eval(expr, await_promise)

    def goto(self, url, timeout=25):
        self.cdp.call('Page.navigate', url=url)
        end = time.time() + timeout
        time.sleep(0.15)
        while time.time() < end:
            try:
                if self.eval('document.readyState') == 'complete' and (url.startswith(('about:', 'chrome:')) or self.eval('location.href').split('#')[0] != 'about:blank'):
                    return
            except RuntimeError:
                pass  # execution context replaced while navigating
            time.sleep(0.1)
        raise TimeoutError('page did not finish loading: ' + url)

    def wait_for(self, expr, timeout=8.0):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = self.eval(expr)
                if last:
                    return last
            except RuntimeError:
                pass
            time.sleep(0.1)
        return last

    def settle(self, quiet=0.6, timeout=10.0):
        """Waits until the recolour engine stops adding element rules."""
        end, prev, stable_since = time.time() + timeout, -1, time.time()
        while time.time() < end:
            n = self.eval("document.querySelectorAll('[data-trikaal-i]').length") or 0
            if n != prev:
                prev, stable_since = n, time.time()
            elif time.time() - stable_since >= quiet:
                return
            time.sleep(0.1)

    def emulate_scheme(self, value):
        self.cdp.call('Emulation.setEmulatedMedia', features=[{'name': 'prefers-color-scheme', 'value': value}])

    def screenshot(self, name):
        if not self.session.out:
            return
        data = self.cdp.call('Page.captureScreenshot', format='png')['data']
        with open(os.path.join(self.session.out, name + '.png'), 'wb') as f:
            f.write(base64.b64decode(data))

    def errors(self):
        self.cdp.pump(0.2)
        out = []
        for ev in self.cdp.events:
            m, p = ev.get('method'), ev.get('params', {})
            if m == 'Runtime.exceptionThrown':
                d = p['exceptionDetails']
                out.append('exception: ' + (d.get('exception', {}).get('description') or d.get('text', ''))[:200] + ' @ ' + str(d.get('url', '')))
            elif m == 'Runtime.consoleAPICalled' and p.get('type') == 'error':
                out.append('console.error: ' + ' '.join(str(a.get('value', a.get('description', ''))) for a in p.get('args', []))[:200])
            elif m == 'Log.entryAdded' and p['entry'].get('level') == 'error':
                out.append('log: ' + p['entry'].get('text', '')[:160] + ' ' + p['entry'].get('url', ''))
        return out

    def close(self):
        try:
            self.session.browser.call('Target.closeTarget', targetId=self.id)
        except Exception:
            pass


class Session:
    def __init__(self, browser_path, profile, http_port, out):
        self.browser_path, self.profile, self.http_port, self.out = browser_path, profile, http_port, out
        self.proc = self.browser = self.sw = None
        self.ext_id = None
        self.tabs = []
        self.collected_errors = []

    def start(self):
        self.proc = subprocess.Popen([
            self.browser_path, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            f'--user-data-dir={self.profile}', f'--remote-debugging-port={DEBUG_PORT}',
            '--enable-unsafe-extension-debugging', '--window-size=1280,900', 'about:blank',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ver = None
        for _ in range(100):
            try:
                ver = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DEBUG_PORT}/json/version', timeout=2))
                break
            except Exception:
                time.sleep(0.2)
        if not ver:
            raise RuntimeError('browser did not start')
        self.version = ver['Browser']
        self.browser = Cdp(ver['webSocketDebuggerUrl'])
        self.ext_id = self.browser.call('Extensions.loadUnpacked', path=ROOT)['id']
        self._connect_sw()

    def _connect_sw(self):
        sw_ws = None
        for _ in range(100):
            for t in self._targets():
                if t['type'] == 'service_worker' and t['url'].startswith(f'chrome-extension://{self.ext_id}/background/service-worker.js'):
                    sw_ws = t['webSocketDebuggerUrl']
            if sw_ws:
                break
            time.sleep(0.2)
        if not sw_ws:
            raise RuntimeError('Trikaal service worker did not start')
        self.sw = Cdp(sw_ws)
        self.sw.call('Runtime.enable')

    def reload_extension(self):
        """Like clicking reload on chrome://extensions: open pages keep an orphaned content script."""
        self.browser.call('Extensions.uninstall', id=self.ext_id)
        time.sleep(0.5)
        self.ext_id = self.browser.call('Extensions.loadUnpacked', path=ROOT)['id']
        self._connect_sw()

    def _targets(self):
        return json.load(urllib.request.urlopen(f'http://127.0.0.1:{DEBUG_PORT}/json', timeout=3))

    def stop(self):
        for t in list(self.tabs):
            self.collected_errors += t.errors()
        try:
            self.sw.pump(0.2)
            for ev in self.sw.events:
                if ev.get('method') == 'Runtime.exceptionThrown':
                    self.collected_errors.append('service worker exception: ' + json.dumps(ev['params']['exceptionDetails'])[:300])
        except Exception:
            pass
        if self.proc:
            if os.name == 'nt':  # kill the whole process tree so the profile lock and debug port are released
                subprocess.run(['taskkill', '/PID', str(self.proc.pid), '/T', '/F'], capture_output=True)
            else:
                self.proc.terminate()
            try:
                self.proc.wait(10)
            except Exception:
                self.proc.kill()
            for _ in range(50):  # wait until the debugging port is really closed
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{DEBUG_PORT}/json/version', timeout=0.5)
                    time.sleep(0.2)
                except Exception:
                    break
            self._wait_profile_released()

    def _wait_profile_released(self):
        """Chrome's helper processes can outlive the main one and keep the profile's storage
        lock; a browser restarted too early then fails with 'LOCK: Access denied'."""
        if os.name != 'nt':
            time.sleep(1.0)
            return
        marker = os.path.basename(self.profile)
        for _ in range(40):
            out = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 f"Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{marker}*' -and $_.ProcessId -ne $PID }} | ForEach-Object {{ $_.ProcessId }}"],
                capture_output=True, text=True).stdout.split()
            if not out:
                break
            for pid in out:
                subprocess.run(['taskkill', '/PID', pid, '/T', '/F'], capture_output=True)
            time.sleep(0.5)
        time.sleep(1.5)

    def sw_eval(self, expr):
        t0 = time.time()
        try:
            return self.sw.eval(expr, await_promise=True)
        finally:
            self.sw_time = getattr(self, 'sw_time', 0.0) + time.time() - t0

    def put(self, core=None, sites=None, excluded=None):
        data = {'trikaal': core or {'defaultMode': 'light'}, 'trikaal.sites': sites or {}, 'trikaal.excluded': excluded or []}
        self.sw_eval('chrome.storage.local.clear().then(() => chrome.storage.sync.clear()).then(() => chrome.storage.sync.set(%s)).then(() => self.__trikaalSyncEarly()).then(() => true)' % json.dumps(data))

    def get_settings(self):
        return self.sw_eval("chrome.storage.sync.get(null)")

    def open(self, url, scheme='light', script=None):
        tid = self.browser.call('Target.createTarget', url='about:blank')['targetId']
        ws = next(t['webSocketDebuggerUrl'] for t in self._targets() if t['id'] == tid)
        tab = Tab(self, tid, Cdp(ws))
        self.tabs.append(tab)
        if scheme:  # the host machine's own theme must never leak into the tests
            tab.emulate_scheme(scheme)
        if script:
            tab.cdp.call('Page.addScriptToEvaluateOnNewDocument', source=script)
        tab.goto(url)
        return tab

    def close_tab(self, tab):
        self.collected_errors += tab.errors()
        tab.close()
        if tab in self.tabs:
            self.tabs.remove(tab)

    def url(self, path, host='127.0.0.1'):
        return f'http://{host}:{self.http_port}/tests/pages/{path}'


# ----------------------------------------------------------------------------- scenarios
TESTS = []


def scenario(name, external=False):
    def deco(fn):
        TESTS.append((name, fn, external))
        return fn
    return deco


def forced_ready(tab):
    ok = tab.wait_for("!!document.getElementById('trikaal-rw-base')", 10)
    assert ok, 'Forced Dark never started (no #trikaal-rw-base)'
    tab.settle()


def audit(tab):
    return tab.eval(AUDIT_JS)


FORCED = {'defaultMode': 'forced'}


def check(cond, message):
    if not cond:
        raise AssertionError(message)


@scenario('extension loads: manifest valid, service worker running, shortcut registered')
def t_loads(s):
    assert s.sw_eval('chrome.runtime.getManifest().version') == '1.0.0'
    assert s.sw_eval('chrome.runtime.getManifest().name') == 'Trikaal'
    cmds = s.sw_eval('chrome.commands.getAll()')
    cycle = [c for c in cmds if c['name'] == 'cycle-mode']
    assert cycle and cycle[0]['shortcut'] == 'Alt+Shift+D', cmds
    assert s.sw_eval("typeof self.Trikaal.storage.cycleMode") == 'function', 'importScripts of shared/storage.js worked'


@scenario('Light: nothing injected; MAIN-world script present but inert; isolated world not visible to the page')
def t_light(s):
    s.put({'defaultMode': 'light'})
    tab = s.open(s.url('article.html'))
    time.sleep(0.8)
    check(tab.eval(RESIDUE_JS) == 0, 'residue in Light: ' + str(tab.eval(RESIDUE_JS)))
    check(tab.eval("getComputedStyle(document.documentElement).colorScheme") == 'normal', 'color-scheme not normal')
    check(tab.eval("window.__trikaalMain === true"), 'MAIN-world script missing: ' + str(tab.eval("typeof window.__trikaalMain")))
    check(tab.eval("typeof window.__trikaalLoaded === 'undefined'"), 'isolated-world variable leaked to the page')
    check(tab.eval("matchMedia('(prefers-color-scheme: dark)').matches") is False, 'matchMedia should be light')
    s.close_tab(tab)


@scenario('Forced Dark: plain article becomes dark and readable; images natural')
def t_forced_article(s):
    s.put(FORCED)
    tab = s.open(s.url('article.html'))
    forced_ready(tab)
    r = audit(tab)
    assert r['badCount'] == 0 and r['lightCount'] == 0, r
    assert r['checked'] >= 4, r
    assert tab.eval("getComputedStyle(document.getElementById('photo')).filter") == 'none'
    assert tab.eval("document.getElementById('photo').hasAttribute('data-trikaal-i')") is False
    assert 'data:image/svg+xml' in tab.eval("document.getElementById('photo').src")
    tab.screenshot('forced-article')
    s.close_tab(tab)


@scenario('Forced Dark: web-app style page (variables, gradients, inline styles, form controls)')
def t_forced_app(s):
    s.put(FORCED)
    tab = s.open(s.url('app.html'))
    forced_ready(tab)
    r = audit(tab)
    assert r['badCount'] == 0 and r['lightCount'] == 0, r
    tab.screenshot('forced-app')
    s.close_tab(tab)


@scenario('Forced Dark leaves an already-dark site alone (no rewrite, colours unchanged)')
def t_already_dark(s):
    s.put(FORCED)
    tab = s.open(s.url('dark.html'))
    time.sleep(1.8)
    assert tab.eval(RESIDUE_JS) == 0, 'dark site must not be touched'
    assert tab.eval("getComputedStyle(document.body).backgroundColor") == 'rgb(13, 17, 23)'
    # Second visit: the remembered verdict means not even a tentative first paint.
    tab2 = s.open(s.url('dark.html'))
    time.sleep(1.0)
    assert tab2.eval(RESIDUE_JS) == 0
    s.close_tab(tab)
    s.close_tab(tab2)


@scenario('Forced Dark first paint is flash-free: every animation frame is on a dark canvas, body only shown once themed')
def t_flash(s):
    s.put(FORCED)
    for page in ('article.html', 'app.html', 'dark.html'):
        tab = s.open(s.url(page), script=FRAME_SAMPLER)
        time.sleep(1.6)
        frames = tab.eval('window.__fr')
        check(frames, 'no frames sampled for ' + page)
        problems = flash_problems(frames, 'rgb(13, 17, 23)' if page == 'dark.html' else None)
        check(not problems, f'{page}: ' + '; '.join(problems[:3]))
        check(tab.eval("getComputedStyle(document.body).opacity") == '1', page + ': body must end up visible')
        s.close_tab(tab)


@scenario('early guard: registered for exactly the sites that will be themed, and follows settings changes')
def t_early_registration(s):
    def scripts():
        return {r['id']: r for r in s.sw_eval('chrome.scripting.getRegisteredContentScripts()')}
    s.put({'defaultMode': 'light'})
    check(scripts() == {}, 'nothing registered in Light: ' + str(list(scripts())))
    s.put(FORCED, sites={'localhost': 'light'}, excluded=['bank.example'])
    r = scripts()
    check(set(r) == {'trikaal-early-forced'}, str(list(r)))
    f = r['trikaal-early-forced']
    check(f['css'] == ['content/early-forced.css'] and f['runAt'] == 'document_start' and f['allFrames'] is True, str(f))
    check(f['matches'] == ['<all_urls>'], str(f['matches']))
    check('*://localhost/*' in f['excludeMatches'] and '*://*.bank.example/*' in f['excludeMatches'], str(f['excludeMatches']))
    s.put({'defaultMode': 'light'}, sites={'127.0.0.1': 'forced'})
    r = scripts()
    check(set(r) == {'trikaal-early-forced'} and r['trikaal-early-forced']['matches'] == ['*://127.0.0.1/*'], str(r))
    s.put({'defaultMode': 'light'})
    check(scripts() == {}, 'removed again')


@scenario('early guard: a site that resolves to Light never gets hidden or marked (no residue)')
def t_early_light_site(s):
    s.put(FORCED, sites={'127.0.0.1': 'light'})
    tab = s.open(s.url('article.html'), script=FRAME_SAMPLER)
    time.sleep(1.0)
    check(tab.eval("getComputedStyle(document.documentElement).getPropertyValue('--trikaal-early') === ''"), 'guard must not apply to a Light site')
    check(tab.eval("document.documentElement.hasAttribute('data-trikaal-off')") is False, 'no marker attribute')
    frames = tab.eval('window.__fr')
    check(all(f['op'] in (None, '1') for f in frames), 'body was hidden on a Light site: ' + str(frames[:2]))
    check(tab.eval(RESIDUE_JS) == 0, 'residue')
    s.close_tab(tab)


@scenario('live update without reload: Forced -> Light -> Forced across an open tab')
def t_live(s):
    s.put(FORCED)
    tab = s.open(s.url('article.html'))
    forced_ready(tab)
    t0 = tab.eval('performance.timeOrigin')
    s.put({'defaultMode': 'light'})
    assert tab.wait_for(RESIDUE_JS + ' === 0', 5), 'all residue removed live'
    s.put(FORCED)
    forced_ready(tab)
    assert tab.eval('performance.timeOrigin') == t0
    assert audit(tab)['badCount'] == 0
    s.close_tab(tab)


@scenario('two tabs of the same site update together; another site is independent')
def t_two_tabs(s):
    s.put({'defaultMode': 'light'}, sites={'127.0.0.1': 'forced'})
    a = s.open(s.url('article.html'))
    b = s.open(s.url('app.html'))
    c = s.open(s.url('article.html', host='localhost'))
    forced_ready(a); forced_ready(b)
    time.sleep(0.6)
    assert c.eval(RESIDUE_JS) == 0, 'localhost has no override and the default is light'
    s.put({'defaultMode': 'light'}, sites={'127.0.0.1': 'light', 'localhost': 'forced'})
    assert a.wait_for(RESIDUE_JS + ' === 0', 5) and b.wait_for(RESIDUE_JS + ' === 0', 5)
    forced_ready(c)
    for t in (a, b, c):
        s.close_tab(t)


@scenario('exclusions: excluded host is never forced; removing the exclusion forces it live')
def t_excluded(s):
    s.put(FORCED, excluded=['127.0.0.1'])
    tab = s.open(s.url('article.html'))
    time.sleep(1.0)
    assert tab.eval(RESIDUE_JS) == 0
    s.put(FORCED, excluded=[])
    forced_ready(tab)
    s.put(FORCED, excluded=['127.0.0.1'])
    assert tab.wait_for(RESIDUE_JS + ' === 0', 5)
    s.close_tab(tab)


@scenario('Auto follows the emulated OS theme live (dark -> Forced Dark, light -> Light)')
def t_auto(s):
    s.put({'defaultMode': 'auto'})
    tab = s.open(s.url('article.html'), scheme='light')
    time.sleep(0.8)
    assert tab.eval(RESIDUE_JS) == 0, 'OS light -> Light'
    tab.emulate_scheme('dark')
    forced_ready(tab)
    tab.screenshot('auto-os-dark')
    tab.emulate_scheme('light')
    assert tab.wait_for(RESIDUE_JS + ' === 0', 5), 'OS light again -> Light, live'
    s.close_tab(tab)


@scenario('page that supports light+dark and an OS in dark mode is treated as already dark (no double-darkening)')
def t_scheme_dark_os(s):
    s.put(FORCED)
    tab = s.open(s.url('schemes.html'), scheme='dark')
    time.sleep(1.8)
    assert tab.eval(RESIDUE_JS) == 0
    s.close_tab(tab)


@scenario('brightness/contrast/sepia sliders and the invert-filter engine (real settings path)')
def t_adjust(s):
    s.put({'defaultMode': 'forced', 'forcedAdjust': {'brightness': 80, 'contrast': 110, 'sepia': 20}})
    tab = s.open(s.url('article.html'))
    forced_ready(tab)
    assert tab.eval("getComputedStyle(document.documentElement).filter") == 'brightness(0.8) contrast(1.1) sepia(0.2)'
    s.put({'defaultMode': 'forced', 'forcedEngine': 'filter', 'forcedAdjust': {'brightness': 100, 'contrast': 100, 'sepia': 0}})
    assert tab.wait_for("!!document.getElementById('trikaal-forced-style')", 6), 'filter engine took over live'
    assert 'invert(1)' in tab.eval("getComputedStyle(document.documentElement).filter")
    assert tab.eval("!document.getElementById('trikaal-rw-base')")
    tab.screenshot('forced-filter-engine')
    s.put({'defaultMode': 'light'})
    assert tab.wait_for(RESIDUE_JS + ' === 0', 5)
    s.close_tab(tab)


@scenario('open shadow DOM is themed')
def t_shadow(s):
    s.put(FORCED)
    tab = s.open(s.url('shadow.html'))
    forced_ready(tab)
    r = audit(tab)
    assert r['badCount'] == 0 and r['lightCount'] == 0, r
    bg = tab.eval("getComputedStyle(document.getElementById('host').shadowRoot.getElementById('inner')).backgroundColor")
    assert bg != 'rgb(245, 245, 245)', 'shadow box was recoloured: ' + bg
    s.close_tab(tab)


@scenario('web components that attach their shadow root AFTER insertion are themed')
def t_shadow_late(s):
    s.put(FORCED)
    tab = s.open(s.url('shadow-late.html'))
    forced_ready(tab)
    time.sleep(1.2)
    tab.eval('window.__addMore(); window.__addMore();')
    time.sleep(1.5)
    tab.settle()
    r = audit(tab)
    check(r['badCount'] == 0 and r['lightCount'] == 0, str(r))
    n = tab.eval("document.querySelectorAll('late-box').length")
    check(n == 3, f'{n} components present')
    s.close_tab(tab)


@scenario('same-origin iframe is themed independently (all_frames)')
def t_iframe(s):
    s.put(FORCED)
    tab = s.open(s.url('frames.html'))
    assert tab.wait_for("!!document.getElementById('f').contentDocument.getElementById('trikaal-rw-base')", 10), 'frame was themed'
    time.sleep(1.0)
    frame_bg = tab.eval("getComputedStyle(document.getElementById('f').contentDocument.querySelector('header')).backgroundColor")
    assert frame_bg != 'rgb(242, 242, 242)', frame_bg
    tab.screenshot('forced-iframe')
    s.close_tab(tab)


@scenario('SPA: route changes and generated rows are themed as they appear')
def t_spa(s):
    s.put(FORCED)
    tab = s.open(s.url('spa.html'))
    forced_ready(tab)
    tab.eval('window.__route(); window.__route();')
    time.sleep(0.5)
    tab.settle()
    r = audit(tab)
    assert r['badCount'] == 0 and r['lightCount'] == 0, r
    s.close_tab(tab)


@scenario('strict Content-Security-Policy page (no inline styles allowed) is still themed')
def t_csp(s):
    s.put(FORCED)
    tab = s.open(s.url('csp.html'))
    forced_ready(tab)
    r = audit(tab)
    assert r['badCount'] == 0 and r['lightCount'] == 0, r
    tab.screenshot('forced-csp')
    errs = [e for e in tab.errors() if 'Content Security Policy' in e and 'trikaal' in e.lower()]
    assert not errs, errs
    s.close_tab(tab)


@scenario('cross-origin stylesheet (unreadable CSSOM) is themed from computed styles')
def t_cross_origin(s):
    s.put(FORCED)
    tab = s.open(s.url('xo.html'))
    forced_ready(tab)
    readable = tab.eval("(() => { try { document.styleSheets[0].cssRules; return true; } catch (e) { return false; } })()")
    assert readable is False, 'fixture should really be cross-origin'
    r = audit(tab)
    assert r['badCount'] == 0 and r['lightCount'] == 0, r
    tab.screenshot('forced-cross-origin')
    s.close_tab(tab)


@scenario('performance: a ~6000-element page is themed without long main-thread tasks (Chrome long-task observer)')
def t_perf(s):
    page = s.url('big.html?n=6000')
    # baseline: the same page with the extension idle (Light), so we only attribute OUR cost
    s.put({'defaultMode': 'light'})
    base = s.open(page, script=LONGTASK_SAMPLER)
    time.sleep(1.5)
    base_lt = base.eval('window.__lt')
    n_elements = base.eval('document.querySelectorAll("*").length')
    s.close_tab(base)
    s.put(FORCED)
    tab = s.open(page, script=LONGTASK_SAMPLER)
    ok = tab.wait_for("!!document.getElementById('trikaal-rw-base')", 15)
    check(ok, 'Forced Dark did not start')
    tab.settle(quiet=1.0, timeout=30)
    lt = tab.eval('window.__lt')
    stats = tab.eval('({ rules: document.querySelectorAll("[data-trikaal-i]").length, elements: document.querySelectorAll("*").length })')
    print(f'        {n_elements} elements; long tasks (>50ms) light: {base_lt} | forced: {lt}; element rules: {stats["rules"]}')
    worst = max(lt or [0])
    check(worst < 600, f'a single long task of {worst}ms: {lt}')
    check(sum(1 for d in lt if d > 200) <= 3, 'too many >200ms tasks: ' + str(lt))
    r = audit(tab)
    check(r['badCount'] <= max(5, r['checked'] * 0.01) and r['lightCount'] <= 5, r)
    tab.screenshot('forced-big-page')
    s.close_tab(tab)


@scenario('real popup page: loads, shows controls, writes settings through real chrome.storage')
def t_popup(s):
    s.put({'defaultMode': 'light'})
    tab = s.open(f'chrome-extension://{s.ext_id}/popup/popup.html')
    assert tab.wait_for("document.getElementById('host').textContent.length > 0", 5)
    assert 'can' in tab.eval("document.getElementById('host').textContent"), 'extension pages cannot be themed'
    tab.eval("document.querySelector('input[name=mode][value=forced]').click()")
    time.sleep(0.6)
    assert s.get_settings()['trikaal']['defaultMode'] == 'forced'
    tab.eval("document.getElementById('brightness').value = 70; document.getElementById('brightness').dispatchEvent(new Event('change', {bubbles: true}))")
    time.sleep(0.6)
    assert s.get_settings()['trikaal']['forcedAdjust']['brightness'] == 70
    tab.eval("document.getElementById('advanced').open = true")
    tab.screenshot('popup')
    assert not tab.errors(), tab.errors()
    s.close_tab(tab)


@scenario('clicking Light/Dark in the REAL popup changes the open tab instantly (no reload)')
def t_popup_live(s):
    s.put({'defaultMode': 'light'})
    page = s.open(s.url('article.html'))
    time.sleep(0.8)
    t0 = page.eval('performance.timeOrigin')
    # The popup asks chrome.tabs.query for "the active tab"; point it at the article tab.
    url = page.eval('location.href')
    patch = "chrome.tabs.query = async () => [{ id: 1, url: %s }];" % json.dumps(url)
    pop = s.open(f'chrome-extension://{s.ext_id}/popup/popup.html', script=patch)
    check(pop.wait_for("document.getElementById('host').textContent === '127.0.0.1'", 5), 'popup sees the page host: ' + str(pop.eval("document.getElementById('host').textContent")))
    pop.eval("document.querySelector('input[name=mode][value=forced]').click()")
    check(page.wait_for("!!document.getElementById('trikaal-rw-base')", 6), 'page turned Dark live after clicking Dark in the popup')
    page.settle()
    check(audit(page)['lightCount'] == 0, 'page is really dark')
    pop.eval("document.querySelector('input[name=mode][value=light]').click()")
    check(page.wait_for(RESIDUE_JS + ' === 0', 6), 'page back to Light live after clicking Light')
    check(page.eval('performance.timeOrigin') == t0, 'no reload happened')
    s.close_tab(pop)
    s.close_tab(page)


@scenario('extension reloaded while a page is open: that page still switches Light/Dark live')
def t_reload_live(s):
    s.put({'defaultMode': 'light'})
    page = s.open(s.url('article.html'))
    time.sleep(0.8)
    s.reload_extension()  # the page's old content script is now orphaned
    time.sleep(2.0)  # onInstalled re-injects the current scripts into open tabs
    s.put(FORCED)
    forced_ready(page)
    s.put({'defaultMode': 'light'})
    check(page.wait_for(RESIDUE_JS + ' === 0', 6), 'back to Light live after the reload')
    s.put(FORCED)
    forced_ready(page)
    s.close_tab(page)


@scenario('keyboard-shortcut logic through the real service worker toggles Light/Dark for the active tab')
def t_shortcut(s):
    s.put({'defaultMode': 'light'})
    tab = s.open(s.url('article.html'))
    time.sleep(0.5)
    s.browser.call('Target.activateTarget', targetId=tab.id)
    seen = []
    for _ in range(3):
        # The SW handler is registered with chrome.commands; invoke the same function the listener runs.
        s.sw_eval("""(async () => {
          const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return !!t; })()""")
        s.sw_eval("""(async () => { const S = self.Trikaal.storage;
          const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
          const host = new URL(t.url).hostname; await S.update((x) => S.cycleMode(x, host)); return true; })()""")
        time.sleep(0.7)
        seen.append('forced' if tab.eval("!!document.getElementById('trikaal-rw-base')") else 'light')
    assert seen == ['forced', 'light', 'forced'], seen
    s.close_tab(tab)


@scenario('persistence: settings survive a full browser restart and apply from the first paint')
def t_restart(s):
    s.put({'defaultMode': 'forced', 'forcedAdjust': {'brightness': 90, 'contrast': 100, 'sepia': 0}}, sites={'127.0.0.1': 'forced', 'example.org': 'light'}, excluded=['bank.example'])
    before = s.get_settings()
    s.stop()
    s.start()
    after = s.get_settings()
    assert after == before, (before, after)
    # The unpacked extension is loaded afresh by the test harness, so let its worker finish
    # re-registering the guard before the first page (a real installed extension keeps the
    # registration across restarts, persistAcrossSessions).
    s.sw_eval('self.__trikaalSyncEarly()')
    tab = s.open(s.url('article.html'), script=FRAME_SAMPLER)
    forced_ready(tab)
    time.sleep(0.8)
    problems = flash_problems(tab.eval('window.__fr'))
    check(not problems, 'after a restart the guard must still be there from the first frame: ' + '; '.join(problems[:3]))
    check(tab.eval("getComputedStyle(document.documentElement).filter") == 'brightness(0.9)', 'slider value restored')
    s.close_tab(tab)


@scenario('browser pages and non-web URLs are unaffected and error-free (chrome://, about:blank)')
def t_nonweb(s):
    s.put(FORCED)
    for url in ('chrome://version', 'about:blank'):
        tab = s.open(url)
        time.sleep(0.5)
        assert tab.eval(RESIDUE_JS) == 0
        s.close_tab(tab)


# ---- real websites (only when the network is reachable) ---------------------------------
EXTERNAL = [
    ('wikipedia', 'https://en.wikipedia.org/wiki/Dark_mode', 'light'),
    ('mdn', 'https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme', 'light'),
    ('hackernews', 'https://news.ycombinator.com/', 'light'),
    ('example', 'https://example.com/', 'light'),
]


def reachable(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'Mozilla/5.0'}), timeout=6)
        return True
    except Exception:
        return False


def make_external(name, url):
    @scenario(f'real site: {name} in Forced Dark is dark and readable', external=True)
    def run(s):
        if not reachable(url):
            raise Skip(f'{url} unreachable')
        s.put(FORCED)
        tab = s.open(url, scheme='light')
        ok = tab.wait_for("!!document.getElementById('trikaal-rw-base')", 15)
        assert ok, 'Forced Dark did not start on ' + name
        tab.settle(quiet=1.0, timeout=15)
        r = audit(tab)
        total = max(r['checked'], 1)
        assert r['badCount'] <= max(3, total * 0.02), f'{name}: {r["badCount"]}/{total} low-contrast text elements: {r["bad"]}'
        assert r['lightCount'] <= 3, f'{name}: light backgrounds left: {r["light"]}'
        tab.screenshot('site-' + name)
        s.close_tab(tab)


for _n, _u, _s in EXTERNAL:
    make_external(_n, _u)


@scenario('real site: GitHub follows the OS theme (dark OS -> left alone; light OS -> darkened)', external=True)
def t_github(s):
    url = 'https://github.com/microsoft/vscode'
    if not reachable(url):
        raise Skip('github.com unreachable')
    s.put(FORCED)
    tab = s.open(url, scheme='dark')
    time.sleep(5)
    native_dark = tab.eval("document.documentElement.getAttribute('data-color-mode') + '/' + document.documentElement.getAttribute('data-dark-theme')")
    forced_on = tab.eval("!!document.getElementById('trikaal-rw-base')")
    tab.screenshot('site-github-os-dark')
    assert not forced_on, f'already-dark GitHub (OS dark) must not be recoloured ({native_dark})'
    s.close_tab(tab)
    tab = s.open(url, scheme='light')
    ok = tab.wait_for("!!document.getElementById('trikaal-rw-base')", 15)
    assert ok, 'light GitHub should be darkened'
    tab.settle(quiet=1.0, timeout=15)
    tab.screenshot('site-github-os-light-forced')
    s.close_tab(tab)


class Skip(Exception):
    pass


# ----------------------------------------------------------------------------- runner
def main(argv):
    out_dir = os.path.join(ROOT, 'tests', 'e2e-out')
    only = None
    external = True
    browser = None
    it = iter(argv)
    for a in it:
        if a == '--out':
            out_dir = next(it)
        elif a == '--only':
            only = next(it).lower()
        elif a == '--no-external':
            external = False
        elif a == '--browser':
            browser = next(it)
    os.makedirs(out_dir, exist_ok=True)

    main_srv, xo_srv = serve(), serve()
    Handler.xo_base = f'http://127.0.0.1:{xo_srv.server_address[1]}'
    profile = tempfile.mkdtemp(prefix='trikaal-e2e-')
    session = Session(find_browser(browser), profile, main_srv.server_address[1], out_dir)
    results = []
    try:
        session.start()
        print('browser:', session.version, '| extension id:', session.ext_id)
        for name, fn, is_ext in TESTS:
            if only and only not in name.lower():
                continue
            if is_ext and not external:
                continue
            t0 = time.time()
            try:
                fn(session)
                results.append((name, 'PASS', ''))
                print(f'  PASS  {name}  ({time.time() - t0:.1f}s)')
            except Skip as e:
                results.append((name, 'SKIP', str(e)))
                print(f'  SKIP  {name}: {e}')
            except Exception as e:  # noqa: BLE001
                results.append((name, 'FAIL', f'{type(e).__name__}: {e}'))
                print(f'  FAIL  {name}\n        {type(e).__name__}: {str(e)[:600]}')
                for tab in list(session.tabs):
                    session.close_tab(tab)
        session.stop()
        errs = [e for e in session.collected_errors if 'chrome-extension://' in e or 'Trikaal' in e or 'trikaal' in e.lower() or 'service worker' in e]
        print('\nextension-originated console errors/exceptions:', len(errs))
        for e in errs[:10]:
            print('   ', e)
        results.append(('no console errors or exceptions originate from the extension', 'FAIL' if errs else 'PASS', '; '.join(errs[:3])))
    finally:
        session.stop() if session.proc and session.proc.poll() is None else None
        main_srv.shutdown(); xo_srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    passed = sum(1 for r in results if r[1] == 'PASS')
    failed = [r for r in results if r[1] == 'FAIL']
    skipped = [r for r in results if r[1] == 'SKIP']
    print(f'\n{passed} passed, {len(failed)} failed, {len(skipped)} skipped. Screenshots: {out_dir}')
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
