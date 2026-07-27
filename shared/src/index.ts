/**
 * SeaPro ühised tüübid — kasutavad nii server kui web.
 *
 * ÜHIKUTE REEGEL: server normaliseerib KÕIK väärtused siia loetletud SI-ühikutesse.
 * Teisendused (sõlmed, Bft, jalad) toimuvad ainult UI kihis. Ükski provider ei tohi
 * tagastada oma algset ühikut.
 */

// ---------------------------------------------------------------------------
// Muutujad
// ---------------------------------------------------------------------------

/** Kõik toetatud mõõdetavad/prognoositavad suurused. */
export const VARIABLES = [
  'wind_speed',       // m/s, 10 m kõrgusel
  'wind_gust',        // m/s
  'wind_dir',         // kraadi, KUST puhub (meteoroloogiline konventsioon)
  'wave_height',      // m, oluline lainekõrgus (Hs)
  'wave_max_height',  // m, maksimaalne lainekõrgus (Hmax)
  'wave_period',      // s
  'wave_dir',         // kraadi, kust lained tulevad
  'swell_height',     // m
  'swell_period',     // s
  'swell_dir',        // kraadi
  'sea_temp',         // °C
  'air_temp',         // °C
  'pressure',         // hPa
  'humidity',         // %
  'visibility',       // m
  'precipitation',    // mm/h
  'cloud_cover',      // %
  'sea_level',        // m (EH2000 või mudeli MSL — vt provideri märkust)
  'current_speed',    // m/s
  'current_dir',      // kraadi, KUHU liigub (ookeanograafiline konventsioon)
] as const;

export type Variable = (typeof VARIABLES)[number];

/** SI-ühik, milles server iga muutujat tagastab. Ainult kuvamiseks/kontrolliks. */
export const VARIABLE_UNITS: Record<Variable, string> = {
  wind_speed: 'm/s',
  wind_gust: 'm/s',
  wind_dir: '°',
  wave_height: 'm',
  wave_max_height: 'm',
  wave_period: 's',
  wave_dir: '°',
  swell_height: 'm',
  swell_period: 's',
  swell_dir: '°',
  sea_temp: '°C',
  air_temp: '°C',
  pressure: 'hPa',
  humidity: '%',
  visibility: 'm',
  precipitation: 'mm/h',
  cloud_cover: '%',
  sea_level: 'm',
  current_speed: 'm/s',
  current_dir: '°',
};

/** Suunamuutujad — neid ei tohi lineaarselt interpoleerida ega keskmistada. */
export const DIRECTION_VARIABLES: ReadonlySet<Variable> = new Set<Variable>([
  'wind_dir',
  'wave_dir',
  'swell_dir',
  'current_dir',
]);

// ---------------------------------------------------------------------------
// Providerid
// ---------------------------------------------------------------------------

export type ProviderKind =
  | 'forecast'      // mudelprognoos (Open-Meteo, met.no, Windfinder)
  | 'observation';  // päris mõõdetud andmed (METOC, LainePoiss, Ilmateenistus)

export interface ProviderModel {
  id: string;
  label: string;
  /** Lühikirjeldus UI tooltipile, nt "DWD ICON-EU, 7 km, Euroopa". */
  note?: string;
}

/** [lõuna, lääs, põhi, ida] — WGS84 kraadid. */
export type BBox = [number, number, number, number];

export interface ProviderCapabilities {
  id: string;
  /** Kuvatav nimi (ei tõlgita — need on pärisnimed). */
  label: string;
  kind: ProviderKind;
  variables: Variable[];
  /** Valitavad mudelid; puudub, kui providereil pole mudelivalikut. */
  models?: ProviderModel[];
  /** Kas provider oskab ühe päringuga mitut punkti (võrgustiku kiht). */
  supportsGrid: boolean;
  /** Kas provider pakub nimelisi mõõtejaamu/poisid. */
  supportsStations: boolean;
  /** Katvuspiirkond; puudub = globaalne. */
  bbox?: BBox;
  /** Mitu tundi ette prognoos ulatub. Vaatlusprovideritel 0. */
  forecastHours: number;
  /** Atributsioon, mis PEAB UI-s nähtav olema. */
  attribution: string;
  attributionUrl?: string;
  /** Kas provider on hetkel kasutatav (nt aisstream ilma võtmeta = false). */
  enabled: boolean;
  /** Miks välja lülitatud, kui enabled=false. */
  disabledReason?: string;
}

// ---------------------------------------------------------------------------
// Ajaread
// ---------------------------------------------------------------------------

/** Üks ajahetk. Puuduv muutuja = null (mitte 0, mitte NaN). */
export interface TimeStep {
  /** ISO 8601 UTC, nt "2026-07-27T16:00:00Z". */
  time: string;
  values: Partial<Record<Variable, number | null>>;
}

export interface TimeSeries {
  providerId: string;
  /** Mudeli id, kui provider tagastas konkreetse mudeli. */
  modelId?: string;
  /** Punkt, mille kohta andmed KEHTIVAD (võib erineda küsitust — mudeli lähim ruut). */
  lat: number;
  lon: number;
  /** Millal allikas andmeid viimati uuendas, kui teada. */
  updatedAt?: string;
  steps: TimeStep[];
}

/** Üks provider võib tagastada mitu seeriat (üks mudeli kohta). */
export interface PointResult {
  lat: number;
  lon: number;
  series: TimeSeries[];
  /** Providerid, mis ebaõnnestusid — UI näitab neid eraldi, mitte ei vaiki maha. */
  errors: ProviderError[];
}

export interface ProviderError {
  providerId: string;
  message: string;
  /** Kas viga on ajutine (võrk/allikas maas) või struktuurne (parser katki). */
  kind: 'unavailable' | 'parse' | 'unsupported' | 'config';
}

// ---------------------------------------------------------------------------
// Võrgustik (kaardikihid)
// ---------------------------------------------------------------------------

export interface GridPoint {
  lat: number;
  lon: number;
  values: Partial<Record<Variable, number | null>>;
}

export interface GridFrame {
  providerId: string;
  modelId?: string;
  time: string;
  variables: Variable[];
  points: GridPoint[];
}

// ---------------------------------------------------------------------------
// Mõõtejaamad ja poid
// ---------------------------------------------------------------------------

export type StationKind = 'coastal' | 'offshore' | 'buoy' | 'unknown';

export interface Station {
  /** Unikaalne providersiseselt, nt "kihnu" või "15". */
  id: string;
  providerId: string;
  name: string;
  kind: StationKind;
  lat: number;
  lon: number;
  /**
   * Kas jaama asukoht võib ajas muutuda (triiviv poi).
   * Nii tead, et markerit peab andmetega koos uuendama.
   */
  mobile?: boolean;
}

export interface StationReading extends Station {
  /** Viimase mõõtmise aeg, ISO 8601 UTC. Null = andmed puuduvad. */
  observedAt: string | null;
  values: Partial<Record<Variable, number | null>>;
  /** Vanus sekundites serveri vastuse hetkel — UI värvib markeri selle järgi. */
  ageSeconds: number | null;
}

/** METOC-i originaali värskuseastmed; kasutame sama loogikat kõigi jaamade jaoks. */
export type Freshness = 'fresh' | 'stale' | 'old' | 'none';

export function freshnessOf(ageSeconds: number | null): Freshness {
  if (ageSeconds === null) return 'none';
  if (ageSeconds < 5 * 3600) return 'fresh';
  if (ageSeconds < 24 * 3600) return 'stale';
  return 'old';
}

// ---------------------------------------------------------------------------
// AIS
// ---------------------------------------------------------------------------

export interface Vessel {
  mmsi: number;
  name?: string;
  callSign?: string;
  imo?: number;
  /** AIS ship type kood (0-99). */
  shipType?: number;
  lat: number;
  lon: number;
  /** Kiirus üle põhja, sõlmedes — AIS-i natiivne ühik, jääb sõlmedeks. */
  sog?: number;
  /** Kurss üle põhja, kraadi. */
  cog?: number;
  /** Vööri suund, kraadi. */
  heading?: number;
  /** AIS navigational status kood. */
  navStat?: number;
  destination?: string;
  /** ISO 8601 UTC. */
  timestamp: string;
  /** Kust see positsioon tuli. */
  source: 'digitraffic' | 'aisstream';
}

// ---------------------------------------------------------------------------
// Trackid (kaatri rajad) — liides valmis, implementatsioon tuleb hiljem
// ---------------------------------------------------------------------------

export interface TrackSummary {
  id: string;
  name: string;
  providerId: string;
  /** ISO 8601 UTC. */
  startedAt?: string;
  endedAt?: string;
  /** Meetrites. */
  distance?: number;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  time?: string;
  /** Sõlmedes. */
  speed?: number;
  course?: number;
}

export interface Track extends TrackSummary {
  points: TrackPoint[];
}

// ---------------------------------------------------------------------------
// Ühikuteisendused (UI kiht)
// ---------------------------------------------------------------------------

export type SpeedUnit = 'ms' | 'kn' | 'bft' | 'kmh';

export function msToKnots(ms: number): number {
  return ms * 1.943844;
}

export function msToKmh(ms: number): number {
  return ms * 3.6;
}

/** Beauforti aste (0-12) tuule kiirusest m/s. */
export function msToBeaufort(ms: number): number {
  // Ametlik Beauforti skaala alampiirid m/s.
  const limits = [0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let bft = 0;
  for (const limit of limits) {
    if (ms >= limit) bft++;
    else break;
  }
  return bft;
}

export function convertSpeed(ms: number, unit: SpeedUnit): number {
  switch (unit) {
    case 'ms': return ms;
    case 'kn': return msToKnots(ms);
    case 'kmh': return msToKmh(ms);
    case 'bft': return msToBeaufort(ms);
  }
}

/** Suund kraadides → 16-punktiline kompassiruum, nt 213 → "SSW". */
export function degreesToCompass(deg: number): string {
  const points = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return points[idx] ?? 'N';
}
