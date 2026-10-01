// Aplică tema (luminoasă/întunecată) înainte de afișare, ca să nu apară un „flash”.
// Logica e oglindită în src/lib/theme.ts.
(function () {
  try {
    var pref = localStorage.getItem('datix-theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (pref !== 'system') {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', dark ? '#121211' : '#f9f9f7');
    }
  } catch (e) {
    /* localStorage indisponibil */
  }
})();
