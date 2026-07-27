import type {
  GridFrame,
  ProviderCapabilities,
  StationReading,
  TimeSeries,
  Variable,
} from '@seapro/shared';

export interface PointQuery {
  lat: number;
  lon: number;
  /** Mitu tundi ette. Vaatlusprovideritele tähendab: mitu tundi TAGA ajalugu. */
  hours: number;
  /** Millised muutujad huvitavad. Tühi = kõik, mida provider oskab. */
  variables?: Variable[];
  /** Millised mudelid. Tühi = provideri vaikimisi valik. */
  models?: string[];
}

export interface GridQuery {
  /** [lõuna, lääs, põhi, ida] */
  bbox: [number, number, number, number];
  /** Mitu punkti võrgustiku pikemal küljel. Server piirab ülemise raja. */
  steps: number;
  variables: Variable[];
  /** ISO 8601 UTC ajahetk, mille kohta väli tahetakse. */
  time: string;
  modelId?: string;
}

/**
 * Iga andmeallikas implementeerib selle. Frontend ei tea ühestki providerist
 * midagi peale `caps` — kogu allikaspetsiifika lõpeb siin failis.
 */
export interface WeatherProvider {
  readonly caps: ProviderCapabilities;

  /** Ajarida ühe punkti kohta. Võib tagastada mitu seeriat (üks mudeli kohta). */
  point(q: PointQuery): Promise<TimeSeries[]>;

  /** Väli kaardikihi jaoks. Ainult kui `caps.supportsGrid`. */
  grid?(q: GridQuery): Promise<GridFrame>;

  /**
   * Kogu ööpäev korraga.
   *
   * Klient hoiab need mälus ja vahetab tunde ilma võrguta — ajaliuguri
   * liigutamine peab olema hetkeline, mitte HTTP-ringi taga.
   */
  gridDay?(q: GridQuery): Promise<GridFrame[]>;

  /** Mõõtejaamad koos viimaste väärtustega. Ainult kui `caps.supportsStations`. */
  stations?(): Promise<StationReading[]>;

  /**
   * Taustatöö, mida server kutsub perioodiliselt.
   * Kasutavad providerid, mille allikas ei kannata päringutulva (METOC).
   */
  warm?(): Promise<void>;
  /** Kui tihti `warm()` kutsuda, sekundites. */
  readonly warmIntervalSeconds?: number;
}

/** Abifunktsioon: teeb tühja ajasammu kõigi küsitud muutujatega null-idena. */
export function emptyValues(variables: Variable[]): Partial<Record<Variable, number | null>> {
  const out: Partial<Record<Variable, number | null>> = {};
  for (const v of variables) out[v] = null;
  return out;
}

/** Ümardab liigsed komakohad — allikad annavad mõnikord 13 kohta. */
export function round(value: number | null | undefined, decimals = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Parsib arvu, mis võib olla "NaN", "?", "" või puuduv.
 * LainePoiss kirjutab mõõtmata välja sõna-sõnalt "NaN", METOC "?".
 */
export function parseNullableFloat(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'NaN' || trimmed === '?' || trimmed === '-') return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}
