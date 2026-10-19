// Trikaal background service worker.
//  1. Keyboard shortcut: toggles Light <-> Dark for the active tab's site and
//     flashes the new mode on the toolbar badge.
//  2. Early paint guard: keeps the "early" CSS content scripts registered for exactly the
//     sites that will be themed, so Chrome injects them before the first paint (see
//     content/early-forced.css). Registered scripts persist, so this also works on the very
//     first load after a browser start.
'use strict';

importScripts('../shared/storage.js');

const S = self.Trikaal.storage;
const BADGES = { light: 'L', forced: 'D' };
const BADGE_MS = 1800;

// ------------------------------------------------------------------ keyboard shortcut
async function showBadge(tabId, mode) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f52d9' });
    await chrome.action.setBadgeText({ tabId, text: BADGES[mode] || '' });
    setTimeout(() => { chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); }, BADGE_MS);
  } catch (e) { /* tab closed meanwhile */ }
}

async function cycleActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const host = tab && S.hostFromUrl(tab.url);
    if (!host) return; // chrome://, the Web Store, file:// ... nothing to theme
    const next = await S.update((s) => S.cycleMode(s, host));
    await showBadge(tab.id, S.resolveMode(next, host, false));
  } catch (e) { /* never throw from a service-worker event */ }
}

// Returning the promise changes nothing for Chrome; it lets tests await the result.
chrome.commands.onCommand.addListener((command) => {
  if (command === 'cycle-mode') return cycleActiveTab();
});

// ------------------------------------------------------------------ early paint guard
const EARLY = {
  forced: { id: 'trikaal-early-forced', css: ['content/early-forced.css'] },
};

let syncChain = Promise.resolve();

// Makes the registered early scripts match the current settings. Calls are serialized so
// two quick settings changes can never race each other into a half-updated registration.
function syncEarly() {
  syncChain = syncChain.then(doSyncEarly, doSyncEarly);
  return syncChain;
}

async function doSyncEarly() {
  try {
    const groups = S.earlyGroups(await S.load());
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const have = new Set(registered.map((r) => r.id));
    // Registrations persist across sessions: drop one left by a version that had a Dark guard.
    if (have.has('trikaal-early-dark')) await chrome.scripting.unregisterContentScripts({ ids: ['trikaal-early-dark'] });
    for (const [mode, cfg] of Object.entries(EARLY)) {
      const g = groups[mode];
      if (!g) {
        if (have.has(cfg.id)) await chrome.scripting.unregisterContentScripts({ ids: [cfg.id] });
        continue;
      }
      const def = {
        id: cfg.id,
        matches: g.matches,
        css: cfg.css,
        runAt: 'document_start',
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true,
      };
      def.excludeMatches = g.excludeMatches; // always sent: update() keeps fields it is not given
      if (have.has(cfg.id)) await chrome.scripting.updateContentScripts([def]);
      else await chrome.scripting.registerContentScripts([def]);
    }
  } catch (e) {
    // Worst case the guard is missing and the very first frames may show the unthemed
    // page; theming itself is unaffected. Never let this break the worker.
  }
}

// Exposed for tests and debugging.
self.__trikaalSyncEarly = syncEarly;

chrome.storage.onChanged.addListener((changes, area) => {
  if (S.changed(changes, area)) syncEarly();
});
// Runs inside a page: removes everything an older copy of the content script left behind
// (after an extension reload it is orphaned: still running, but cut off from chrome.*).
function cleanOldInstance() {
  try {
    const T = window.Trikaal;
    if (T && T.forced) T.forced.disable();
    if (T && T.theme) T.theme.teardown();
  } catch (e) { /* nothing to clean */ }
  window.Trikaal = undefined;
  window.__trikaalLoaded = false;
}

// Pages that were already open when the extension was installed, updated or reloaded have
// no working content script, so switching modes would do nothing until a reload. Put the
// current scripts into them now.
async function refreshOpenTabs() {
  try {
    const scripts = chrome.runtime.getManifest().content_scripts;
    const isolated = scripts.find((c) => !c.world).js;
    const main = scripts.find((c) => c.world === 'MAIN').js;
    for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
      try {
        const target = { tabId: tab.id, allFrames: true };
        await chrome.scripting.executeScript({ target, func: cleanOldInstance });
        await chrome.scripting.executeScript({ target, files: isolated });
        await chrome.scripting.executeScript({ target, world: 'MAIN', files: main });
      } catch (e) { /* discarded, restricted or closed tab: skip it */ }
    }
  } catch (e) { /* never break the worker */ }
}
self.__trikaalRefreshOpenTabs = refreshOpenTabs;

chrome.runtime.onInstalled.addListener(() => {
  syncEarly();
  refreshOpenTabs();
});
chrome.runtime.onStartup.addListener(() => { syncEarly(); });
syncEarly(); // also on every worker wake-up: cheap, and repairs a lost registration
