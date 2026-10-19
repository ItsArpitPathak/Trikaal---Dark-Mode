// Runs in the PAGE's JavaScript world (manifest `"world": "MAIN"`), because the isolated
// content-script world cannot see when a page script calls attachShadow().
//
// Announces open shadow roots as they are attached. A content script can only see a shadow
// root that already exists when it looks; many components (ads, widgets, design-system
// elements) attach theirs later, after the host is in the page. The event bubbles out of
// nested shadow trees (composed) to the document, where the recolour engine listens.
(() => {
  'use strict';
  if (window.__trikaalMain) return;
  window.__trikaalMain = true;

  try {
    const nativeAttach = Element.prototype.attachShadow;
    if (typeof nativeAttach !== 'function') return;
    Element.prototype.attachShadow = function attachShadow(init) {
      const root = nativeAttach.apply(this, arguments);
      try {
        if (init && init.mode === 'open') this.dispatchEvent(new Event('trikaal-shadow-attached', { bubbles: true, composed: true }));
      } catch (e) { /* never break the page's own attachShadow call */ }
      return root;
    };
  } catch (e) { /* leave attachShadow alone */ }
})();
