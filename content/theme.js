// Trikaal theme manager: applies exactly one mode and tears the previous one down
// completely, so switching modes never leaves residue behind.
//
//   light  -> nothing injected
//   forced -> the Dark engine (window.Trikaal.forced); "forced" is the id of the mode the
//             popup calls "Dark"
(() => {
  'use strict';
  const T = (window.Trikaal = window.Trikaal || {});

  let current = null;

  function teardown() {
    try { if (T.forced) T.forced.disable(); } catch (err) { /* nothing else to clean up */ }
    current = null;
  }

  function apply(mode) {
    teardown();
    current = mode;
    try {
      if (mode === 'forced') T.forced.enable(); // ends the early guard itself once themed
      else T.util.endEarly(); // 'light' (or unknown): nothing to wait for, show the page
    } catch (e) {
      teardown();
      T.util.endEarly();
    }
  }

  T.theme = { apply, teardown, getCurrent: () => current };
})();
