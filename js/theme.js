'use strict';
// Nastaví téma ještě před vykreslením stránky (žádný „flash").
// Priorita: ?theme=light|dark v URL (např. při vložení přes iframe) → uložená volba → dark.
(function () {
  var KEY = 'simulator-linky.theme';
  var theme = null;
  try {
    var q = new URLSearchParams(location.search).get('theme');
    if (q === 'light' || q === 'dark') theme = q;
  } catch (e) { /* ignore */ }
  if (!theme) {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') theme = saved;
    } catch (e) { /* localStorage nemusí být dostupné */ }
  }
  document.documentElement.setAttribute('data-theme', theme || 'dark');
})();
