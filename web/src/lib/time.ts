import type { Lang } from '../i18n';

/** Ümardab hetke täistunnini — kõik prognoosid on tunnisammuga. */
export function floorToHour(d: Date = new Date()): Date {
  const out = new Date(d);
  out.setMinutes(0, 0, 0);
  return out;
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3600_000);
}

export function hoursBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 3600_000);
}

/**
 * Kellaaeg kohalikus ajas. Merel mõeldakse kohalikus ajas, mitte UTC-s —
 * andmed liiguvad UTC-s, kuvatakse kohalikus.
 */
export function formatTime(iso: string | Date, lang: Lang): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleTimeString(lang === 'et' ? 'et-EE' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDay(iso: string | Date, lang: Lang): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString(lang === 'et' ? 'et-EE' : 'en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function formatDateTime(iso: string | Date, lang: Lang): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${formatDay(d, lang)} ${formatTime(d, lang)}`;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Vanus inimloetavalt: "12 min tagasi", "3 h tagasi". */
export function formatAge(
  ageSeconds: number | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (ageSeconds === null) return t('station.noData');
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return t('station.age.minutes', { n: Math.max(0, minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('station.age.hours', { n: hours });
  return t('station.age.days', { n: Math.round(hours / 24) });
}
