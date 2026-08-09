import { createContext, useContext } from 'react';
import et from './et.json';
import en from './en.json';
import fi from './fi.json';

export type Lang = 'et' | 'en' | 'fi';

const DICTS: Record<Lang, Record<string, string>> = { et, en, fi };

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'et', label: 'Eesti' },
  { id: 'en', label: 'English' },
  { id: 'fi', label: 'Suomi' },
];

const STORAGE_KEY = 'seapro.lang';

export function detectLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'et' || saved === 'en' || saved === 'fi') return saved;
  const browserLang = navigator.language.toLowerCase();
  if (browserLang.startsWith('et')) return 'et';
  if (browserLang.startsWith('fi')) return 'fi';
  return 'en';
}

export function saveLang(lang: Lang): void {
  localStorage.setItem(STORAGE_KEY, lang);
}

export function localeTag(lang: Lang): 'et-EE' | 'en-GB' | 'fi-FI' {
  if (lang === 'et') return 'et-EE';
  if (lang === 'fi') return 'fi-FI';
  return 'en-GB';
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
