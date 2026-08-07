import type { NavigationAid } from '@seapro/shared';

type AidCategory = NonNullable<NavigationAid['category']>;

/** ITU-R M.1371 AIS Message 21 AToN type -> kaardi normaliseeritud liik. */
export function categoryFromAtonType(type: number | undefined): AidCategory | undefined {
  if (type === undefined) return undefined;
  const direct: Partial<Record<number, AidCategory>> = {
    5: 'lighthouse', 6: 'lighthouse',
    7: 'leading-front', 8: 'leading-rear',
    9: 'cardinal-north', 10: 'cardinal-east', 11: 'cardinal-south', 12: 'cardinal-west',
    13: 'lateral-port', 14: 'lateral-starboard',
    15: 'preferred-port', 16: 'preferred-starboard',
    17: 'isolated-danger', 18: 'safe-water', 19: 'special',
    20: 'cardinal-north', 21: 'cardinal-east', 22: 'cardinal-south', 23: 'cardinal-west',
    24: 'lateral-port', 25: 'lateral-starboard',
    26: 'preferred-port', 27: 'preferred-starboard',
    28: 'isolated-danger', 29: 'safe-water', 30: 'special',
  };
  return direct[type];
}

/** Väylävirasto `navigointilajikoodi` -> IALA märgiliik. */
export function categoryFromFinnishNavigationCode(code: number | undefined): AidCategory | undefined {
  if (code === undefined) return undefined;
  const categories: Partial<Record<number, AidCategory>> = {
    1: 'lateral-port',
    2: 'lateral-starboard',
    3: 'cardinal-north',
    4: 'cardinal-south',
    5: 'cardinal-west',
    6: 'cardinal-east',
    7: 'isolated-danger',
    8: 'safe-water',
    9: 'special',
  };
  return categories[code];
}

/**
 * Nutimeri registris pole eraldi IALA liigi välja; ametlik eestikeelne nimi,
 * märgi klass ja tule värv kannavad sama info. Nime kontroll on enne värvi,
 * sest valge tuli võib kuuluda nii kardinaalile, teljepoile kui tuletornile.
 */
export function categoryFromRegistry(
  name: string,
  kind: NavigationAid['kind'],
  lightColour?: string,
  registryType?: string,
): AidCategory {
  const value = normalize(`${registryType ?? ''} ${name}`);
  const colour = normalize(lightColour ?? '');

  // Funktsioon on siin ehitise liigist tähtsam: tuletorn võib olla ühtlasi
  // sihi alumine või ülemine märk, nagu Suurupi 374/375.
  if (value.includes('sihi alumine')) return 'leading-front';
  if (value.includes('sihi ulemine')) return 'leading-rear';
  if (value.includes('tuletorn')) return 'lighthouse';
  if (value.includes('sihi')) return 'leading';
  if (/pohja(?:poi|tooder)/.test(value)) return 'cardinal-north';
  if (/ida(?:poi|tooder)/.test(value)) return 'cardinal-east';
  if (/louna(?:poi|tooder)/.test(value)) return 'cardinal-south';
  if (/laane(?:poi|tooder)/.test(value)) return 'cardinal-west';
  if (value.includes('vasaku kulje')) return 'lateral-port';
  if (value.includes('parema kulje')) return 'lateral-starboard';
  if (value.includes('teljepoi') || value.includes('teljetooder')) return 'safe-water';
  if (
    value.includes('ohupoi')
    || value.includes('uksikohu')
    || value.includes('eraldiasuva ohu')
    || value.includes('eraldiseisva ohu')
  ) return 'isolated-danger';
  if (value.includes('erimark') || value.includes('eriotstarbeline') || value.includes('piirireziimi')) return 'special';

  // Nimetud sadama ujuvmärgil on värv sageli ainus külge määrav väli.
  if (kind !== 'fixed') {
    if (colour === 'punane') return 'lateral-port';
    if (colour === 'roheline') return 'lateral-starboard';
    if (colour === 'kollane') return 'special';
  }
  if (value.includes('tulepaak') || value.includes('paevamark') || kind === 'fixed') {
    return 'beacon';
  }
  return 'unknown';
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
