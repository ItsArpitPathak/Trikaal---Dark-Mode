# Trikaal – testing

Two layers: an **automated suite** (logic, DOM behaviour, popup UI) and a **manual
checklist** for the things only a real Chrome can prove (real sites, restarts, the
extension install itself).

---

## 1. Automated tests

There are three layers, from fastest to most realistic. All are dev-only (not in the packaged
extension) and need only Python 3 and an installed Chrome or Edge.

| Command | What it runs |
| --- | --- |
| `python tests/run-headless.py` | Every suite below in headless Chrome, unthrottled (about a minute). Prints a summary; exit status 1 on any failure. |
| `python tests/e2e-headless.py` | **The real extension in real Chrome** (see below). |
| manual: open `/tests/all.html` | The same suites in any browser tab (details further down). |

### 1a. Real-browser end-to-end (`tests/e2e-headless.py`)

Loads the unpacked extension into headless Chrome through the DevTools `Extensions.loadUnpacked`
command, so Chrome itself validates the manifest, injects the content scripts (isolated **and**
MAIN world), runs the service worker and provides the real `chrome.storage`. Settings are driven
through the worker; assertions are made on real pages. It verifies, among other things:

* manifest loads, shortcut `Alt+Shift+D` is registered, service worker `importScripts` works
* Light injects nothing; Dark reverts live to Light without a reload
* Dark on a plain article, a web-app page, shadow DOM, a same-origin iframe, an SPA,
  a page served with a **strict CSP**, and a page using a **cross-origin stylesheet**; contrast audit on every text element
* already-dark pages are left alone; `color-scheme: light dark` + dark OS is treated as already dark
* per-site overrides, exclusions, Auto with live OS-theme emulation, sliders, engine switch, all live
* **no flash on load:** every animation frame is on a dark canvas and the body is only shown once themed
* the early-paint guard is registered for exactly the right sites and follows settings
* **settings persist across a full browser restart**
* **performance:** a generated ~6000-element page is themed with no main-thread task over 50 ms
  (measured with Chrome's own long-task observer)
* the real popup page and keyboard-shortcut logic; `chrome://` and `about:blank` stay untouched
* zero console errors or exceptions originate from the extension
* when the network is reachable: real **Wikipedia, MDN, example.com** (readable, dark) and **GitHub**
  (left alone under a dark OS, darkened under a light one)

```bash
python tests/e2e-headless.py                       # everything (external sites auto-skipped if offline)
python tests/e2e-headless.py --no-external         # local fixtures only
python tests/e2e-headless.py --only flash          # scenarios whose name contains "flash"
python tests/e2e-headless.py --out some/folder     # where screenshots go (default tests/e2e-out)
```

Screenshots of each scenario are written as PNGs: look at them. The runner emulates a **light** OS
theme in every tab so the host machine's own theme can never leak into a result.
Needs Chrome 111+ (it passes `--enable-unsafe-extension-debugging`).

### 1b. Mock-based suites (`tests/run-headless.py`, or in a tab)

These run in a normal page against a mocked `chrome` API, so they need no extension install.
`python tests/run-headless.py [p5 p6 ...]` runs them all in headless Chrome (it also sets a light
OS theme for you). To use a normal browser tab instead:

```bash
# from the project folder (any static server works; Python is just handy)
python -m http.server 8765
```

Open `http://localhost:8765/tests/all.html` (runs every suite, each in its own iframe).
Results are printed as JSON; `failed` must be `0`. Run one suite with
`/tests/all.html?suites=p6`.

**In a tab:** set the emulated OS theme to **Light** first (DevTools → ⋮ → More tools → Rendering →
*Emulate CSS media feature prefers-color-scheme: light*) and keep the tab visible: background tabs
throttle timers heavily.

| Suite | Covers |
| --- | --- |
| `p2` | settings model, storage round-trips, live updates between tabs, popup basics |
| `p4` | invert-filter engine: media re-inversion, background images, dynamic content |
| `p5` | colour parsing, already-dark detection (backgrounds, `color-scheme`, meta tag, SPAs), verdict cache |
| `p6` | HSL mapping, value/gradient/variable rewriting, the recolour engine on a realistic app page, shadow DOM, performance |
| `p7` | Auto mode, exclusions, sliders, engine choice, keyboard shortcut, popup UI, accessibility, manifest integrity, no-network/no-eval scan |
| `p8` | release checks: docs present, frame host resolution, throttling, privacy control, iframes, CSP fallback |
| `p9` | early paint guard: which sites get it, service-worker registration, reveal logic, detection not fooled by the guard |

`tests/prof.html?n=4000` profiles the recolour engine on a large DOM (see section 3).

---

## 2. Manual checklist (real Chrome)

Load the extension: `chrome://extensions` → **Developer mode** → **Load unpacked** →
select this folder. Open the **service worker** link on the extension card and keep its
console visible: there must be **no errors** at any point. Set `DEBUG = true` in
`content/content.js` if you want each mode change logged to the page console.

Tick every box in **Light** and **Dark** unless stated.

### 2.1 Text-heavy sites
Try: Wikipedia article, a long blog post, MDN docs, a news article.
- [ ] Dark: page is dark, body text clearly readable, links distinguishable and not neon.
- [ ] Code blocks, tables (zebra rows), blockquotes and borders all remain visible.
- [ ] Inline images/diagrams look natural (not inverted, not washed out).
- [ ] Select text: selection highlight is visible. Find-in-page highlights are visible.
- [ ] Light: page is pixel-identical to the extension being disabled.

### 2.2 Web apps
Try: Gmail, Google Docs/Drive, GitHub (light theme), a Notion/Trello-style app, a webmail.
- [ ] Dark: readable, no black-on-black or white-on-white text, buttons and menus legible.
- [ ] Open menus, dialogs, tooltips, dropdowns, hover and focus states: all still readable.
- [ ] Navigate inside the SPA without reloading: new views are themed (no light flashes of whole panels).
- [ ] Type in inputs, textareas, rich-text editors: caret and text visible.
- [ ] Scroll long lists / infinite scroll: new rows are themed as they appear; scrolling stays smooth.
- [ ] Embedded iframes (maps, video, widgets) look sensible.

### 2.3 Image-heavy sites
Try: Unsplash, Pinterest, a shopping site (Amazon, IKEA), a photo gallery, a news front page.
- [ ] Photos, product shots, thumbnails, video posters are **not** altered (colours natural).
- [ ] Hero banners with text over a photo keep the original text colour and stay readable.
- [ ] Logos on transparent backgrounds are visible (a dark logo that vanishes on dark is a known limit, see README).
- [ ] CSS background images (carousels, hero sections) are unchanged.
- [ ] `<canvas>`, `<video>`, SVG illustrations unchanged.
- [ ] Brand colours (buttons, badges) are still recognisable (same hue), only darker.

### 2.4 Already-dark sites
Try: GitHub with the dark theme, YouTube in dark mode, Reddit dark, Twitter/X dim or lights-out, VS Code docs dark.
- [ ] Dark leaves them **alone** (not turned light, not double-darkened).
- [ ] Switch the site's own theme light → dark → light while Dark is on: Trikaal switches itself off/on within ~1 s.
- [ ] Reload a known-dark site: no light or inverted flash on load (the verdict is remembered).
- [ ] Light fully reverts a Dark page without a reload.

### 2.5 PDFs and browser pages (must not break)
- [ ] Open a PDF in the built-in viewer (e.g. a PDF URL): opens normally, no console errors; toggling modes does not break the viewer.
- [ ] `chrome://extensions`, `chrome://settings`, the New Tab page, `chrome://newtab`: unaffected (extensions cannot run there). Popup opens and shows *"This page can't be themed"*; the **All sites** default can still be changed.
- [ ] Chrome Web Store, `about:blank`, `file://` pages (if "Allow access to file URLs" is off): popup shows the same message; no errors.
- [ ] The keyboard shortcut on those pages does nothing and throws nothing.

### 2.6 Flash of white on load
(The automated end-to-end run already samples every animation frame, but eyeball it on real sites too.)
Use DevTools → Network → throttle **Slow 3G** and *Disable cache*, then hard-reload (Ctrl+Shift+R) light sites in Dark.
Record the screen or use the Performance panel's screenshots.
- [ ] Dark: no white frame; you see a dark canvas, then the themed page (it appears within about a second at worst).
- [ ] Dark: the page appears already in its dark styling, never light first.
- [ ] Already-dark sites: shown as the site designed them, no light or inverted flash.
- [ ] In `chrome://extensions` → Trikaal → *service worker* console: `chrome.scripting.getRegisteredContentScripts()` lists `trikaal-early-forced` only for sites that use Dark, and nothing in Light.
- [ ] A page can never stay blank: even with Trikaal's content script blocked, the body appears after about 1.2 s.
- [ ] Just after *installing* the extension the very first load may flash once (the guard is not registered yet); the next loads must not.

### 2.7 Persistence
- [ ] Set a global default (All sites → Dark) and a per-site override (This site → Light); close the popup, reload both sites: choices applied.
- [ ] Quit Chrome completely, relaunch: settings unchanged.
- [ ] Open a new window and a new tab on the same site: same mode, instantly.
- [ ] Change the mode in the popup with two tabs of the same site open: **both** update live, no reload.
- [ ] Per-site override on `a.com` does not change `b.com`.
- [ ] Sign into Chrome on another profile/device with sync: settings follow (Chrome sync, not Trikaal).

### 2.8 OS theme and DevTools emulation
DevTools → ⋮ → More tools → **Rendering** → *Emulate CSS media feature `prefers-color-scheme`*.
- [ ] Open the popup with *dark* then *light* emulation: popup is readable in both (text contrast, focus ring, selected segment).
- [ ] Advanced → **Follow my system theme (Auto)**: dark emulation → Dark, light → Light, changing emulation updates open tabs live.
- [ ] A site with `color-scheme: light dark` and OS dark is treated as already dark (no double-darkening).

### 2.9 Controls and polish
- [ ] **Keyboard shortcut** `Alt+Shift+D` (change at `chrome://extensions/shortcuts`): toggles Light ↔ Dark for the current site; the badge flashes `L`/`D`.
- [ ] **Never force dark on this site** checkbox: Dark turns off immediately on that site and its subdomains; choosing Dark for the site again removes the exclusion.
- [ ] Exclusion list: add `https://www.example.com/path` (becomes `www.example.com`), remove entries, invalid input is rejected with a message.
- [ ] **Brightness / contrast / sepia** sliders change the open Dark page about a quarter-second after you stop dragging; *Reset adjustments* restores it. They do nothing in Light/Dark.
- [ ] **Dark method**: switching *Recolor* ↔ *Invert filter* swaps engines live without residue.
- [ ] **Forget remembered sites** works and shows a confirmation.
- [ ] Keyboard only: Tab reaches every control in a sensible order; arrow keys move within the segmented controls; focus ring always visible; Esc closes the popup.
- [ ] Screen reader (NVDA/VoiceOver): groups announced as *Apply to* / *Mode*, sliders announce name and value, status messages are read.

### 2.10 Robustness
- [ ] Sites with strict CSP (GitHub, Google properties): theming still applies, no CSP errors attributable to Trikaal.
- [ ] Heavy pages (a 5k+ element page, Reddit threads, long GitHub diffs): no visible jank while the theme is applied; CPU settles to idle afterwards (Task Manager: Shift+Esc).
- [ ] Pages with Shadow DOM (YouTube, GitHub, Salesforce-style apps): inner components themed.
- [ ] Switching modes 20 times quickly leaves **no** `trikaal-*` elements or `data-trikaal-*` attributes (DevTools → Elements, search "trikaal"). In Light there must be **none**.
- [ ] Disable then re-enable the extension in `chrome://extensions`: pages recover on reload; no orphaned styling on already-open tabs after disabling (reload the tab if needed).
- [ ] Network panel: **zero** requests originate from the extension.

---

## 3. Profiling a heavy page

1. Chrome DevTools → **Performance** → record while loading a heavy page in Dark.
2. Look at the main thread: Trikaal work appears as many short tasks (target ≲ 12 ms each).
   A long task (> 50 ms) right after the theme is applied is normally Chrome's own
   style recalculation for the page, not Trikaal.
3. `http://localhost:8765/tests/prof.html?n=4000&inline=7` prints per-slice statistics
   (`engine.stats`: slices, elements, read ms, commit ms). Reference result on a
   software-rendered test browser: **4000 elements in ≈ 0.3 s across ≈ 19 slices, no long tasks.**
4. Observers are scoped and throttled: attribute changes use a filter (`class`, `style`),
   elements that change more than 8 times per second are re-checked once per second, and
   already-dark re-checks run at most every 600 ms.
