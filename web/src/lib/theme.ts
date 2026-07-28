import { useCallback, useEffect, useState } from 'react';

/**
 * Liidese teema.
 *
 * `auto` järgib seadme oma valikut — telefonis lülitub see ise õhtul tumedaks
 * ja see ongi enamikule õige. Käsitsi valik on siiski vajalik: paadis on kaks
 * päris olukorda, kus seade eksib. Ere päike pesab tumeda liidese loetamatuks
 * ka keskpäeval, ja öösel vahis rikub hele ekraan pimedaga harjunud silma —
 * kummalgi juhul ei tea seadme kellaaeg sellest midagi.
 */
export type Theme = 'auto' | 'light' | 'dark';

export const THEMES: Theme[] = ['auto', 'light', 'dark'];

const STORAGE_KEY = 'seapro.theme';

/** Millise teema seade ise valiks. */
function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' || saved === 'auto' ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Privaatrežiim — teema kehtib siis ainult selle seansi.
  }
}

/**
 * Paneb valiku külge nii, et CSS seda näeks.
 *
 * `data-theme` on ALATI konkreetne ('light' või 'dark'), mitte 'auto' — nii ei
 * pea CSS teadma automaatsest režiimist midagi ja kogu teemaloogika on ühes
 * kohas. Sama atribuudi paneb paika ka `index.html`-i sisene skript enne
 * esimest joonistust, muidu vilksataks vale teema.
 */
export function applyTheme(theme: Theme): void {
  const resolved = theme === 'auto' ? systemTheme() : theme;
  document.documentElement.dataset.theme = resolved;

  // Telefoni olekuriba värv käib teemaga kaasa — muidu jääb ülaserva riba,
  // mis kuulub nähtavalt teise rakendusse.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#dfeaf1' : '#0b3550');
}

export function useTheme(): { theme: Theme; setTheme(next: Theme): void } {
  const [theme, setThemeState] = useState<Theme>(loadTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    saveTheme(next);
    applyTheme(next);
  }, []);

  // Automaatses režiimis peab seadme vahetus mõjuma KOHE, ilma rakenduse
  // taaslaadimiseta — päikeseloojang ei ole hetk, mil kasutaja tahab
  // rakendust uuesti avada.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => applyTheme('auto');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return { theme, setTheme };
}
