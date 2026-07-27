import type { ProviderCapabilities, StationReading, TimeSeries, Variable } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchText } from '../http.js';
import { haversineKm } from './metocTaltech.js';
import { parseNullableFloat, round, type PointQuery, type WeatherProvider } from './types.js';

const OBSERVATIONS_URL = 'https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php';

/**
 * Riigi Ilmateenistus (Keskkonnaagentuur) — Eesti ametlik vaatlusvõrk.
 *
 * Täiendab METOC-i: METOC on mereseireks (lained, veetase, avamerejaamad),
 * Ilmateenistus annab tiheda rannikuvõrgu koos õhurõhu ja nähtavusega, mida
 * paljudel METOC-i jaamadel pole.
 *
 * Vorming on XML ilma skeemita. Kirjutasime lihtsa regex-parseri, mitte
 * XML-teegi: struktuur on lame ja stabiilne (`<station>` sees lihtväljad),
 * ning sõltuvuse lisamine ühe faili pärast poleks õigustatud. Parser ei tohi
 * ühe katkise jaama peale tervikut maha visata.
 */
export class IlmateenistusProvider implements WeatherProvider {
  readonly caps: ProviderCapabilities = {
    id: 'ilmateenistus',
    label: 'Riigi Ilmateenistus',
    kind: 'observation',
    variables: [
      'wind_speed',
      'wind_gust',
      'wind_dir',
      'air_temp',
      'sea_temp',
      'pressure',
      'humidity',
      'visibility',
      'precipitation',
    ],
    supportsGrid: false,
    supportsStations: true,
    bbox: [57.3, 21.5, 59.9, 28.3],
    forecastHours: 0,
    attribution: 'Riigi Ilmateenistus / Keskkonnaagentuur',
    attributionUrl: 'https://www.ilmateenistus.ee/',
    enabled: true,
  };

  readonly warmIntervalSeconds = 300;

  async stations(): Promise<StationReading[]> {
    const { observedAt, stations } = await this.#load();

    const ageSeconds = observedAt
      ? Math.max(0, (Date.now() - new Date(observedAt).getTime()) / 1000)
      : null;

    return stations.map((s) => ({
      id: slug(s.name),
      providerId: this.caps.id,
      name: s.name,
      // Ilmateenistuse võrk on maismaa- ja rannikujaamad; avamerejaamu pole.
      kind: 'coastal' as const,
      lat: s.lat,
      lon: s.lon,
      observedAt,
      ageSeconds,
      values: s.values,
    }));
  }

  async point(q: PointQuery): Promise<TimeSeries[]> {
    const { observedAt, stations } = await this.#load();
    if (!observedAt) return [];

    let best: ParsedStation | null = null;
    let bestDist = Infinity;
    for (const s of stations) {
      const d = haversineKm(q.lat, q.lon, s.lat, s.lon);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    // Üle 30 km kaugusel olev ilmajaam ei kirjelda enam seda punkti.
    if (!best || bestDist > 30) return [];

    return [
      {
        providerId: this.caps.id,
        lat: best.lat,
        lon: best.lon,
        updatedAt: observedAt,
        steps: [{ time: observedAt, values: best.values }],
      },
    ];
  }

  async warm(): Promise<void> {
    await this.#load();
  }

  async #load(): Promise<ParsedObservations> {
    const { value } = await cache.get('ilm:observations', config.ttl.ilmateenistus, () =>
      fetchText(OBSERVATIONS_URL, { timeoutMs: 20_000 }),
    );
    return parseObservations(value);
  }
}

interface ParsedStation {
  name: string;
  lat: number;
  lon: number;
  values: Partial<Record<Variable, number | null>>;
}

interface ParsedObservations {
  /** Kogu faili ühine vaatlusaeg, ISO 8601 UTC. */
  observedAt: string | null;
  stations: ParsedStation[];
}

/**
 * Väljad, mis vajavad ühikuteisendust meie SI-lepingusse.
 *
 * Ilmateenistus annab nähtavuse KILOMEETRITES ("32"), meie leping on meetrites.
 * Ilma teisenduseta näitaks rakendus 32 m nähtavust — see on udu, mitte selge
 * ilm, ja täpselt vastupidine tegelikkusele. Sama väli tuleb METOC-ist juba
 * meetrites (36492), seega vahe pole ilmne enne kui neid kõrvutada.
 */
const UNIT_SCALE: Partial<Record<Variable, number>> = {
  visibility: 1000,
};

/** XML-välja nimi -> meie muutuja. */
const FIELD_MAP: Record<string, Variable> = {
  windspeed: 'wind_speed',
  windspeedmax: 'wind_gust',
  winddirection: 'wind_dir',
  airtemperature: 'air_temp',
  watertemperature: 'sea_temp',
  airpressure: 'pressure',
  relativehumidity: 'humidity',
  visibility: 'visibility',
  precipitations: 'precipitation',
};

export function parseObservations(xml: string): ParsedObservations {
  // Ajatempel on Unixi sekundites juurelemendi atribuudis.
  const tsMatch = xml.match(/<observations[^>]*timestamp="(\d+)"/);
  const observedAt = tsMatch ? new Date(Number(tsMatch[1]) * 1000).toISOString() : null;

  const blocks = [...xml.matchAll(/<station>([\s\S]*?)<\/station>/g)];
  if (blocks.length === 0) {
    throw new Error('Ilmateenistus: ühtki <station> elementi ei leitud — XML-i kuju muutus');
  }

  const stations: ParsedStation[] = [];

  for (const [, body] of blocks) {
    if (!body) continue;

    const name = field(body, 'name');
    const lat = parseNullableFloat(field(body, 'latitude'));
    const lon = parseNullableFloat(field(body, 'longitude'));

    // Koordinaadita jaama ei saa kaardile panna; nimeta jaama ei saa kuvada.
    if (!name || lat === null || lon === null) continue;

    const values: ParsedStation['values'] = {};
    let hasAny = false;
    for (const [tag, variable] of Object.entries(FIELD_MAP)) {
      const v = parseNullableFloat(field(body, tag));
      if (v === null) continue;
      values[variable] = round(v * (UNIT_SCALE[variable] ?? 1));
      hasAny = true;
    }

    // Jaam ilma ühegi mõõteväärtuseta on kaardil ainult müra.
    if (!hasAny) continue;

    stations.push({ name, lat, lon, values });
  }

  return { observedAt, stations };
}

function field(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  const value = m?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

/** Jaamanimest stabiilne id — XML ei anna jaamadele numbrilist võtit. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[äöõü]/g, (c) => ({ ä: 'a', ö: 'o', õ: 'o', ü: 'u' })[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const ilmateenistus = new IlmateenistusProvider();
