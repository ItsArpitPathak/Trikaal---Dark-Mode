#!/usr/bin/env python3
"""Runs the whole Trikaal test suite in headless Chrome and prints the result.

Dev tool only (not shipped). Needs Python 3 and an installed Chrome or Edge; it uses
no third-party packages: it starts a static file server for the project folder, launches
the browser with the DevTools protocol enabled, loads tests/all.html and reads the
aggregate result back over a tiny built-in WebSocket client.

Usage:
    python tests/run-headless.py                 # all suites
    python tests/run-headless.py p5 p6           # selected suites
    python tests/run-headless.py --browser "C:/path/to/chrome.exe"

Exit status: 0 when every test passed, 1 otherwise.
"""
import functools
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
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALL_SUITES = ['p2', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']


from cdp_lite import Cdp, find_browser  # noqa: E402


def main(argv):
    browser = None
    suites = []
    it = iter(argv)
    for a in it:
        if a == '--browser':
            browser = next(it)
        else:
            suites.append(a)
    suites = suites or ALL_SUITES

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    handler.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    handler.func.log_message = lambda self, *a, **k: None  # silence request logging
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix='trikaal-test-')
    debug_port = 9333
    proc = subprocess.Popen([
        find_browser(browser), '--headless=new', '--disable-gpu', '--no-first-run',
        '--no-default-browser-check', f'--user-data-dir={profile}', f'--remote-debugging-port={debug_port}',
        '--window-size=1280,900', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    code = 1
    try:
        target = None
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json', timeout=2))
                pages = [t for t in tabs if t.get('type') == 'page']
                if pages:
                    target = pages[0]
                    break
            except Exception:
                pass
            time.sleep(0.2)
        if not target:
            sys.exit('Browser did not expose a DevTools page')
        cdp = Cdp(target['webSocketDebuggerUrl'])
        cdp.call('Page.enable')
        # The Dark-mode tests assume a light OS theme.
        cdp.call('Emulation.setEmulatedMedia', features=[{'name': 'prefers-color-scheme', 'value': 'light'}])
        url = f'http://127.0.0.1:{port}/tests/all.html?suites={",".join(suites)}&t={int(time.time())}'
        print('running', ' '.join(suites), 'in', os.path.basename(find_browser(browser)))
        cdp.call('Page.navigate', url=url)
        start = time.time()
        shown = ''
        result = None
        while time.time() - start < 900:
            time.sleep(1)
            raw = cdp.eval('JSON.stringify({f: !!window.__finished, a: window.__all || null})')
            if not raw:
                continue
            state = json.loads(raw)
            per = (state['a'] or {}).get('perSuite', {})
            line = '  ' + '  '.join(f'{k}: {v}' for k, v in per.items())
            if line != shown:
                print(line)
                shown = line
            if state['f']:
                result = state['a']
                break
        if result is None:
            print('TIMED OUT waiting for the suites to finish')
        else:
            print(f'\n{result["passed"]} passed, {result["failed"]} failed in {time.time() - start:.0f}s')
            for f in result['failures']:
                print(f'  FAIL [{f["suite"]}] {f["name"]}\n       {f["error"]}')
            code = 0 if result['failed'] == 0 else 1
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
