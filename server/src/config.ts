import type { BBox } from '@seapro/shared';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Keskkonnamuutuja ${name} peab olema arv, sai: ${raw}`);
  }
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function bbox(name: string, fallback: BBox): BBox {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${name} peab olema "lõuna,lääs,põhi,ida", sai: ${raw}`);
  }
  return parts as BBox;
}

const contactEmail = str('CONTACT_EMAIL', '');
const appVersion = str('APP_VERSION', '0.1.0');

export const config = {
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  nodeEnv: str('NODE_ENV', 'development'),
  logLevel: str('LOG_LEVEL', 'info'),

  contactEmail,
  appVersion,

  /**
   * User-Agent, mille saadame KÕIGI väljaminevate päringutega.
   * MET Norway ToS nõuab tuvastatavat kontakti ja vastab muidu 403-ga —
   * seetõttu hoiatame käivitusel, kui CONTACT_EMAIL on täitmata.
   */
  userAgent: contactEmail
    ? `SeaPro/${appVersion} (+${contactEmail})`
    : `SeaPro/${appVersion}`,

  aisstreamKey: str('AISSTREAM_KEY', ''),

  ttl: {
    openMeteo: num('CACHE_TTL_OPENMETEO', 900),
    metNo: num('CACHE_TTL_METNO', 1200),
    metoc: num('CACHE_TTL_METOC', 240),
    lainepoiss: num('CACHE_TTL_LAINEPOISS', 300),
    ilmateenistus: num('CACHE_TTL_ILMATEENISTUS', 300),
    windfinder: num('CACHE_TTL_WINDFINDER', 1800),
    ais: num('CACHE_TTL_AIS', 30),
  },

  backgroundPoll: bool('BACKGROUND_POLL', true),

  defaultLat: num('DEFAULT_LAT', 59.0),
  defaultLon: num('DEFAULT_LON', 23.5),
  defaultZoom: num('DEFAULT_ZOOM', 7),
  aisBbox: bbox('AIS_BBOX', [57.0, 20.0, 60.5, 29.0]),
} as const;

export function warnAboutConfig(log: (msg: string) => void): void {
  if (!config.contactEmail) {
    log(
      'CONTACT_EMAIL on täitmata — MET Norway blokeerib anonüümsed päringud (403). ' +
        'Täida see .env failis.',
    );
  }
  if (!config.aisstreamKey) {
    log(
      'AISSTREAM_KEY puudub — AIS töötab ainult Digitraffici kaudu ' +
        '(Soome laht kaetud, Liivi laht mitte). Vt docs/api-keys.md.',
    );
  }
}
