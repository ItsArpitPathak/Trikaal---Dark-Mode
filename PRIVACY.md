# Trikaal – privacy policy

**Trikaal does not collect, transmit or share any data. Everything happens inside your browser.**

## What Trikaal does with web pages
To switch a site to dark, Trikaal reads the colours and styles of the page you are
viewing and adds style rules to it, **locally, in the page**. Page content, text, form
fields, cookies, passwords and browsing history are not read, stored or sent anywhere.

## What Trikaal stores (on your device)
| Data | Where | Why |
| --- | --- | --- |
| Your settings: default mode, per-site modes, the list of sites you excluded, the Dark method, brightness / contrast / sepia values | `chrome.storage.sync` | So your choices persist across tabs, windows and restarts. |
| For each site where Dark ran: its hostname and whether it was already dark (up to the 300 most recent) | `chrome.storage.local` | So known-dark sites can load without a flash. Clear it any time with **Advanced → Forget remembered sites**. |

Notes:
* `chrome.storage.sync` is synchronised by **Chrome itself** across devices where you are
  signed in to Chrome with sync enabled. Trikaal has no servers and never receives it.
  Hostnames you customised or excluded are part of that synced data.
* Removing the extension deletes all of the above.

## Network access
Trikaal makes **no network requests**: no analytics, no telemetry, no crash reporting, no
remote configuration, no fonts or scripts loaded from the internet. It contains no remote
code and never uses `eval` or equivalent. (The automated tests in the repository scan the
shipped files for network APIs and `eval`.)

## Permissions, and why
* **Host access to all sites (`<all_urls>`)** – required to theme any website you visit.
  Content scripts run locally and only change how the page looks.
* **`storage`** – saves the settings described above.
* **`scripting`** – registers two tiny stylesheets that Chrome applies before a page paints, so you do
  not see a white flash before dark mode applies. It only registers CSS files bundled with the extension;
  no scripts are injected or run through it.

## Children
Trikaal does not knowingly collect information from anyone, including children.

## Changes
If this policy ever changes it will be updated here and in the extension's store listing
before the change ships.

## Contact
Questions: open an issue in the project repository or contact the publisher listed on the
Chrome Web Store page.
