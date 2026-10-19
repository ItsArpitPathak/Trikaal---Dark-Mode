# Trikaal – packaging and Chrome Web Store release

## 1. Pre-flight

1. Run the automated suites and the real-browser end-to-end run (see [TESTING.md](TESTING.md)):
   `python tests/run-headless.py` and `python tests/e2e-headless.py` must both report no failures.
2. Walk the manual checklist (section 2 of TESTING.md) on at least Chrome stable.
3. Confirm `DEBUG = false` in `content/content.js` (it is by default).
4. Bump `"version"` in `manifest.json` (Chrome Web Store requires every upload to be a higher version).
5. Confirm there are no stray files in the package (step 2 does this for you).

## 2. Build the zip

Only these paths ship: `manifest.json`, `background/`, `content/`, `popup/`, `shared/`, `icons/`.
**Not** included: `tests/`, `scripts/`, `dist/`, `.claude/`, `*.md`.

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

macOS / Linux:

```bash
bash scripts/package.sh
```

Output: `dist/trikaal-<version>.zip`. Check the contents (`manifest.json` must be at the **root** of
the zip, not inside a folder; entries use forward slashes). Test the exact zip by unzipping it into a
fresh folder and loading that with **Load unpacked**.

Expected size: well under 100 KB.

## 3. Chrome Web Store listing

Developer dashboard: <https://chrome.google.com/webstore/devconsole> (one-time registration fee applies).
Upload the zip, then fill in the listing.

**Name:** Trikaal – Dark Mode for Any Website

**Summary (≤ 132 chars):**
Dark mode for every website. Smart detection leaves dark sites alone. 100% local, no tracking.

**Category:** Accessibility (alternative: Productivity)

**Language:** English

**Detailed description:**

> Trikaal gives every website two clear modes, per site or for all sites:
>
> • LIGHT – the site exactly as its author designed it. Nothing is changed.
> • DARK – Colours are rewritten to dark (hue preserved, so brand colours stay recognisable), photos, video and logos stay natural, and text stays readable.
>
> SMART, NOT HEAVY-HANDED
> Dark checks whether a page is already dark and leaves it alone, so you never get a double-darkened or washed-out page. It re-checks when a site switches theme.
>
> BUILT FOR REAL WEBSITES
> Works with single-page apps, infinite scroll, Shadow DOM and embedded frames. Applies at page start to avoid the white flash, and updates instantly with no reload.
>
> YOUR CONTROL
> • Per-site or all-sites choice, saved across tabs, windows and restarts
> • Keyboard shortcut (Alt+Shift+D) to cycle modes
> • "Never force dark on this site" list
> • Brightness, contrast and sepia sliders
> • Optional Auto mode that follows your system theme
> • A choice of recolour or classic invert engine
> • Accessible popup: keyboard friendly, screen-reader labelled, works in light and dark system themes
>
> PRIVATE BY DESIGN
> No analytics. No tracking. No network requests. No remote code. Everything happens inside your browser, and removing the extension removes everything. Full policy: see the privacy policy link.
>
> Note: Chrome does not allow extensions to change chrome:// pages, the Chrome Web Store or other extensions' pages.

**Single purpose (store form):** Apply light, dark or forced-dark colour themes to websites the user visits.

**Permission justifications (store form):**

| Permission | Justification |
| --- | --- |
| Host permissions (`<all_urls>`) | The extension's single purpose is to theme any website the user chooses; a content script must run on every site to apply or remove the theme. It only changes how pages look and reads no page content for any other purpose. |
| `storage` | Saves the user's mode choices, per-site overrides, exclusion list and slider values, and (locally) which sites were found to be already dark. |
| `scripting` | Registers two small CSS files (bundled with the extension) as content scripts so dark mode applies before the first paint and the page never flashes white. No code is injected or executed through this permission. |

**Data usage disclosures (store form):** The extension does not collect or transmit any user data.
Tick none of the data categories; certify that data is not sold, not used for unrelated purposes and
not used for creditworthiness or lending. Remote code: **No**.

**Privacy policy URL:** host `PRIVACY.md` somewhere public (for example the repository's rendered
`PRIVACY.md` page or a GitHub Pages site) and paste that URL.

## 4. Screenshot and promo suggestions

Store images: screenshots **1280×800** (or 640×400), up to 5, PNG/JPEG without transparency; small
promo tile 440×280; optional marquee 1400×560. Use a clean browser profile, 100 % zoom, no personal tabs.

1. **Hero before/after** – a text-heavy site (e.g. a Wikipedia article) split light | Dark with the popup open (*Dark* highlighted). Caption: "Any website, dark in one click."
2. **Two modes** – the popup's Light / Dark control with a short caption per mode.
3. **Smart detection** – an already-dark site (e.g. GitHub dark) beside a forced light site, caption "Already dark? Trikaal leaves it alone."
4. **Images stay natural** – an image-heavy page (e.g. a photo gallery or shop) in Dark; caption "Photos and video are never altered."
5. **Controls** – popup with *Advanced* open: sliders, exclusion list, Auto, keyboard shortcut. Caption "Fine-tune it your way."

Tips: capture both light and dark system themes of the popup for variety; keep captions to ≤ 6 words;
use the placeholder icon replacement (a 128×128 PNG) before publishing if you want a branded icon.

## 5. After publishing

* Review can take from hours to several days. Keep the Load-unpacked build to hand for bug reports.
* To release an update: fix → run tests → bump `version` → package → upload as a new version.
