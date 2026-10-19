# Trikaal

A Chrome extension (Manifest V3) that gives any website **Light** and **Dark**
modes. Plain JavaScript, HTML and CSS: no build step, no dependencies. Everything runs locally;
no network requests, no analytics. See [PRIVACY.md](PRIVACY.md).

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin Trikaal from the puzzle-piece menu and click the icon to open the popup.

If something is wrong, the extension card shows an **Errors** button. After editing code click
the reload icon on the card, then refresh the page you are testing.

## The two modes

| Mode | What happens |
| --- | --- |
| **Light** | The site renders exactly as its author designed it. Nothing is injected. |
| **Dark** | Rewrites the page's colours to dark while keeping hues, photos and video untouched. Sites that are already dark are detected and left alone. |

Choose a mode **for this site** or **for all sites**. The choice is saved, shared across tabs and
windows, survives restarts and applies instantly without a reload.

### Advanced (popup → Advanced)

* **Follow my system theme (Auto)** – OS dark → Dark, OS light → Light.
* **Dark method** – *Recolor the page* (default, real colour rewriting) or *Invert filter* (simple fallback).
* **Brightness / contrast / sepia** sliders for Dark.
* **Never force dark on …** – exclusion list (a site and its subdomains). Also a checkbox in the main view.
* **Forget remembered sites** – clears the local "already dark" cache.

### Keyboard shortcut

`Alt+Shift+D` toggles **Light ↔ Dark** for the current site and flashes `L`/`D` on
the toolbar icon. Change it at `chrome://extensions/shortcuts`.

## How Dark works

1. **Detection first.** Before forcing, Trikaal works out whether the page is already dark: the
   effective background (walking up from `<body>`, compositing transparency, sampling the middle of
   the viewport for SPAs), `color-scheme` and `<meta name="color-scheme">`, and light-on-nothing text.
   It re-checks after `DOMContentLoaded`, after `load`, and whenever the page's theme attributes change.
   A verdict cache (local only) lets known-dark sites skip forcing from the first paint.
2. **Recolouring** (`content/rewrite.js`). Readable stylesheet rules are copied into Trikaal's own
   stylesheet with colours converted in **HSL**: light backgrounds → dark (preserving the "page < card"
   layering), dark text → light, borders adjusted, hue kept, saturation never increased. Gradients and
   custom properties (`--bg`) are converted; `:hover`/`:focus`, media queries, `@layer`, `@keyframes`
   keep working. A second pass reads computed styles for anything the first missed (inline styles,
   cross-origin stylesheets, legacy attributes) and fixes unreadable text using contrast ratios.
3. **Dynamic pages.** MutationObservers feed a time-sliced queue (a few ms per slice) so SPAs,
   infinite scroll, new stylesheets and **open Shadow DOM** (including roots a component attaches after it was inserted) are themed as they appear.
   Images, video, canvas and CSS background images are never touched.
4. **No white flash.** Settings are read asynchronously, which is too late for the very first
   frames. So the service worker registers a tiny CSS-only content script
   (`content/early-forced.css`) for exactly the sites that will be themed.
   Chrome injects them before the first paint: the page sits on a dark canvas with its body hidden
   until Trikaal has themed it, then `html[data-trikaal-off]` switches the guard off. A CSS-only timer
   reveals the page after 1.2 s no matter what, so a page can never stay blank. Light sites never get
   the guard. (Detection measures the page with the guard switched off, so the guard is never mistaken
   for the site's own dark theme.)
5. **Clean removal.** Everything Trikaal adds lives in namespaced `<style>` elements and
   `data-trikaal-*` attributes; switching mode removes all of it. Light leaves nothing behind.

## Permissions

| Permission | Why |
| --- | --- |
| `<all_urls>` (host access) | Theme any website you choose. |
| `storage` | Save your settings (and, locally, which sites were already dark). |
| `scripting` | Register the early-paint CSS described above (no code is injected or executed). |

## Project layout

```
manifest.json            MV3 manifest
shared/storage.js        settings model + chrome.storage helpers (popup, content scripts, worker)
content/util.js          small helpers (wait for <html>, task scheduler, frame host)
content/color.js         colour parser, WCAG luminance/contrast, HSL dark mapping
content/detect.js        already-dark detection + local verdict cache
content/forced-dark.js   Dark session (detection loop, filter engine, adjustments)
content/rewrite.js       recolouring engine
content/early-forced.css early paint guard for Dark (registered by the service worker)
content/main-world.js    page-world hook that announces shadow roots attached late
content/theme.js         applies exactly one mode and tears the previous one down
content/controller.js    keeps a page's mode in sync with settings
content/content.js       bootstrap
background/service-worker.js   keyboard shortcut + early-paint script registration
popup/                   popup UI
tests/                   automated suites + real-browser runners (dev only, not shipped)
scripts/                 packaging scripts (dev only)
```

## Known limitations

* Chrome does not let extensions inject into `chrome://` pages, the Chrome Web Store or other extensions' pages.
* Cross-origin stylesheets cannot be read, so Trikaal recolours those pages from computed styles
  (still correct for the normal state; `:hover` rules inside such sheets keep their original colours).
* Closed Shadow DOM and dark logos on transparent images are not recoloured.
* Text drawn over a photo keeps the author's colour (the photo is not darkened).
* The early paint guard is registered by the service worker, so the very first page load right after
  *installing* the extension (before it has registered) can still flash once.
* If you switch a tab from Dark to Light without reloading, one harmless `data-trikaal-off`
  attribute stays on `<html>` of that tab until it is reloaded (it is what keeps the guard switched off).
* Very large pages theme progressively (a few milliseconds per frame) rather than in one blocking pass.

## Development

* Logging: set `DEBUG = true` in `content/content.js` to log each mode change to the page console.
* Tests (automated, real-browser end-to-end) and the manual checklist: [TESTING.md](TESTING.md). Packaging and store listing: [PACKAGING.md](PACKAGING.md).
