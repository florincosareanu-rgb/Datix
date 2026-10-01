// Aplică tema (luminoasă/întunecată) înainte de afișare, ca să nu apară un „flash”.
(function () {
  try {
    var pref = localStorage.getItem('datix-theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    /* localStorage indisponibil */
  }
})();
