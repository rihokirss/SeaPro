import type { BBox } from '@seapro/shared';
import { ROUTING_SERVICE_BBOX } from './routing/coverage.js';

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
  const [south, west, north, east] = parts as BBox;
  if (
    south < -90 || north > 90 || west < -180 || east > 180
    || south >= north || west >= east
  ) {
    throw new Error(`${name} koordinaadid või järjestus on vigane: ${raw}`);
  }
  return [south, west, north, east];
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

  /**
   * Valikuline Open-Meteo kommerts-API võti.
   *
   * Võtme olemasolul kasutab provider automaatselt reserveeritud `customer-`
   * endpointe. Võti jääb ainult serverisse ega lähe API vastustesse, logidesse
   * ega vahemäluvõtmetesse.
   */
  openMeteoApiKey: str('OPEN_METEO_API_KEY', ''),
  /** Standardpakett vaikimisi; Professionali puhul määra .env-is 5000000. */
  openMeteoMonthlyLimit: num('OPEN_METEO_MONTHLY_LIMIT', 1_000_000),

  /** Konfigureeritav, et Photoni avaliku demo saaks asendada oma instantsiga. */
  photonUrl: str('PHOTON_URL', 'https://photon.komoot.io'),

  ttl: {
    /**
     * Open-Meteo mudelijooksud uuenevad PARIMAL juhul kord tunnis (MET Nordic;
     * ICON-EU iga 3 h, GFS iga 6 h). Lühem TTL ei anna värskemat prognoosi,
     * kulutab ainult päringueelarvet — ja see eelarve on tänu punktipõhisele
     * arvestusele kitsas. Tund on siin andmete oma tempo, mitte oletus.
     */
    openMeteo: num('CACHE_TTL_OPENMETEO', 3600),
    metNo: num('CACHE_TTL_METNO', 1200),
    metoc: num('CACHE_TTL_METOC', 240),
    lainepoiss: num('CACHE_TTL_LAINEPOISS', 300),
    ilmateenistus: num('CACHE_TTL_ILMATEENISTUS', 300),
    // FMI jaamad raporteerivad 10 min sammuga, lainepoid 30 min.
    fmi: num('CACHE_TTL_FMI', 300),
    windfinder: num('CACHE_TTL_WINDFINDER', 1800),
    ais: num('CACHE_TTL_AIS', 30),
    search: num('CACHE_TTL_SEARCH', 7 * 24 * 3600),
  },

  backgroundPoll: bool('BACKGROUND_POLL', true),

  defaultLat: num('DEFAULT_LAT', 59.0),
  defaultLon: num('DEFAULT_LON', 23.5),
  defaultZoom: num('DEFAULT_ZOOM', 7),
  // Kogu Läänemeri: Taani väinadest Botnia lahe põhjaosani.
  aisBbox: bbox('AIS_BBOX', [53.0, 9.0, 66.0, 31.5]),
  /** Avaliku grid-API kulupiir; hoitakse AIS-ist eraldi seadistatavana. */
  weatherGridBbox: bbox('WEATHER_GRID_BBOX', [53.0, 12.0, 66.7, 31.5]),
  /** Avaliku punktiprognoosi kulupiir; võib tulevikus grid'ist erineda. */
  weatherPointBbox: bbox('WEATHER_POINT_BBOX', [53.0, 12.0, 66.7, 31.5]),
  /** Automaatmarsruudi v1 katvus: Eesti ja Soome merealad. */
  routingBbox: bbox('ROUTING_BBOX', ROUTING_SERVICE_BBOX),
  routingMaxDistanceNm: num('ROUTING_MAX_DISTANCE_NM', 500),
  /** Kogu külma snapshot'i, klassifitseerimise ja otsingu ühine tähtaeg. */
  routingPlanTimeoutMs: num('ROUTING_PLAN_TIMEOUT_MS', 90_000),
  routingMaxConcurrentPlans: num('ROUTING_MAX_CONCURRENT_PLANS', 2),
  routingSearchTimeoutMs: num('ROUTING_SEARCH_TIMEOUT_MS', 45_000),
  routingSearchMaxNodes: num('ROUTING_SEARCH_MAX_NODES', 1_000_000),
  /** Logib iga marsruudiplaani faasiajad; benchmarki ja profiilimise jaoks. */
  routingTimingsLog: bool('ROUTING_TIMINGS_LOG', false),
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
        'ja Transpordiameti Eesti AIS-voost. Vt docs/api-keys.md.',
    );
  }
}
