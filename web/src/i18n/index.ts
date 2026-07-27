import { createContext, useContext } from 'react';
import et from './et.json';
import en from './en.json';

export type Lang = 'et' | 'en';

const DICTS: Record<Lang, Record<string, string>> = { et, en };

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'et', label: 'Eesti' },
  { id: 'en', label: 'English' },
];

const STORAGE_KEY = 'seapro.lang';

export function detectLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'et' || saved === 'en') return saved;
  // Eestikeelne brauser saab eestikeelse liidese, muidu inglise.
  return navigator.language.toLowerCase().startsWith('et') ? 'et' : 'en';
}

export function saveLang(lang: Lang): void {
  localStorage.setItem(STORAGE_KEY, lang);
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function makeTranslate(lang: Lang): Translate {
  const dict = DICTS[lang];
  const fallback = DICTS.et;
  return (key, vars) => {
    // Puuduv tõlge kukub eesti keelde ja seejärel võtmele endale — nii on
    // puuduv string ekraanil kohe nähtav, mitte vaikselt tühi.
    let text = dict[key] ?? fallback[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  };
}

interface I18nValue {
  lang: Lang;
  t: Translate;
  setLang(lang: Lang): void;
}

export const I18nContext = createContext<I18nValue>({
  lang: 'et',
  t: makeTranslate('et'),
  setLang: () => {},
});

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
