// Tema aplicației: sistem / luminoasă / întunecată (salvată doar pe acest dispozitiv).
// Aceeași logică rulează și înainte de încărcare, în public/theme.js (fără „flash”).

export type ThemePref = 'system' | 'light' | 'dark';

const PAGE_COLOR = { light: '#f9f9f7', dark: '#121211' } as const;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem('datix-theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // bara de stare din iOS urmează tema aleasă
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const forDark = (m.getAttribute('media') ?? '').includes('dark');
    m.setAttribute('content', pref === 'system' ? PAGE_COLOR[forDark ? 'dark' : 'light'] : PAGE_COLOR[pref]);
  });
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem('datix-theme');
    else localStorage.setItem('datix-theme', pref);
  } catch {
    /* localStorage indisponibil: tema se aplică doar în sesiunea curentă */
  }
  applyTheme(pref);
}
