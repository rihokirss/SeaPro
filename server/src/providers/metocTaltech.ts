import type {
  ProviderCapabilities,
  StationReading,
  TimeSeries,
  Variable,
} from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchText } from '../http.js';
import stationList from '../stations/metoc.json' with { type: 'json' };
import { parseNullableFloat, round, type PointQuery, type WeatherProvider } from './types.js';

const PORTAL = 'http://on-line.msi.ttu.ee/metoc/';

interface StationDef {
  id: string;
  name: string;
  kind: 'coastal' | 'offshore' | 'buoy';
  lat: number;
  lon: number;
}

const STATIONS = stationList as StationDef[];

/**
 * TalTech Meresüsteemide instituudi METOC portaal.
 *
 * Portaalil pole API-t. Andmed tulevad kahest PHP otspunktist, mis mõlemad
 * ootavad POST-i ja vastavad HTML-i või semikooloniga eraldatud tekstiga:
 *
 *   get_param_value.php  site=kihnu&param=wind_speed  ->  "4.9;6.0;213"
 *   infowindow.php       station=kihnu                ->  HTML-tabel
 *
 * Kasutame `infowindow.php`-d, sest see annab ÜHE päringuga kõik parameetrid
 * pluss mõõtmise ajatempli. `get_param_value.php` nõuaks parameetri kohta
 * eraldi päringut ega ütle, kui vana väärtus on.
 *
 * CORS puudub, seega brauser ei saa siia otse pöörduda — proxy on kohustuslik.
 * Server on vana (Apache 2.2 / PHP 5.3), seega pärime taustal ühe korra
 * intervalli kohta, sõltumata kasutajate arvust.
 */
export class MetocProvider implements WeatherProvider {
  readonly caps: ProviderCapabilities = {
    id: 'metoc',
    label: 'TalTech METOC',
    kind: 'observation',
    variables: [
      'wind_speed',
      'wind_gust',
      'wind_dir',
      'wave_height',
      'wave_max_height',
      'wave_period',
      'air_temp',
      'sea_temp',
      'pressure',
      'humidity',
      'visibility',
      'sea_level',
    ],
    supportsGrid: false,
    supportsStations: true,
    // Eesti rannikuvesi. Väljaspool seda pole mõtet providerilt küsida.
    bbox: [57.5, 21.5, 59.8, 28.3],
    forecastHours: 0,
    attribution: 'TalTech Meresüsteemide instituut / Transpordiamet',
    attributionUrl: 'http://on-line.msi.ttu.ee/metoc/',
    enabled: true,
  };

  readonly warmIntervalSeconds = 240;

  async stations(): Promise<StationReading[]> {
    const readings = await Promise.all(STATIONS.map((s) => this.#readStation(s)));
    return readings.filter((r): r is StationReading => r !== null);
  }

  /**
   * Punktipäring: leiab lähima jaama ja annab selle hetkeväärtused ühe
   * ajasammuna. Vaatlusjaam ei prognoosi, seega ajarida on üheelemendiline.
   */
  async point(q: PointQuery): Promise<TimeSeries[]> {
    const nearest = nearestStation(q.lat, q.lon);
    // Üle 40 km kaugusel olev rannikujaam ei kirjelda enam seda punkti.
    if (!nearest || nearest.distanceKm > 40) return [];

    const reading = await this.#readStation(nearest.station);
    if (!reading?.observedAt) return [];

    return [
      {
        providerId: this.caps.id,
        lat: reading.lat,
        lon: reading.lon,
        updatedAt: reading.observedAt,
        steps: [{ time: reading.observedAt, values: reading.values }],
      },
    ];
  }

  async warm(): Promise<void> {
    // Järjestikku, mitte paralleelselt: 36 korraga saabuvat päringut võib
    // vana PHP-serveri kergesti üle koormata. Kogu ring võtab paar sekundit,
    // mis mahub 4-minutilisse intervalli kergesti ära.
    for (const station of STATIONS) {
      try {
        await this.#readStation(station);
      } catch {
        // Üksik kukkunud jaam ei tohi ringi katkestada.
      }
    }
  }

  async #readStation(def: StationDef): Promise<StationReading | null> {
    const key = `metoc:${def.id}`;
    try {
      const { value } = await cache.get(key, config.ttl.metoc, () =>
        fetchText(`${PORTAL}infowindow.php`, {
          form: { station: def.id },
          timeoutMs: 12_000,
          retries: 1,
        }),
      );

      const parsed = parseInfoWindow(value);
      const ageSeconds = parsed.observedAt
        ? Math.max(0, (Date.now() - new Date(parsed.observedAt).getTime()) / 1000)
        : null;

      return {
        ...def,
        providerId: this.caps.id,
        observedAt: parsed.observedAt,
        values: parsed.values,
        ageSeconds,
      };
    } catch {
      // Jaam ei vasta ja varukoopiat pole — näitame jaama kaardil ikkagi,
      // aga andmeteta. Nii ei kao jaamavõrk ekraanilt allika tõrke ajal.
      return { ...def, providerId: this.caps.id, observedAt: null, values: {}, ageSeconds: null };
    }
  }
}

/**
 * Sildid, mida METOC-i infoaken kasutab, meie muutujateks.
 * Portaal on ingliskeelne ja sildid on olnud stabiilsed, aga kuna tegu on
 * HTML-i parsimisega, sobitame ainult prefiksi järgi — nii ei lagune parser,
 * kui nad lisavad sulgudesse täpsustuse.
 */
const LABEL_MAP: [RegExp, Variable | 'wind_speed_gust'][] = [
  [/^wind speed \/ gust/i, 'wind_speed_gust'],
  [/^wind speed/i, 'wind_speed'],
  [/^wind gust/i, 'wind_gust'],
  [/^wind direction/i, 'wind_dir'],
  [/^mean wave height/i, 'wave_height'],
  [/^max(imum)? wave height/i, 'wave_max_height'],
  [/^mean (wave )?period/i, 'wave_period'],
  [/^air temperature/i, 'air_temp'],
  [/^water temperature/i, 'sea_temp'],
  [/^air pressure/i, 'pressure'],
  [/^humidity/i, 'humidity'],
  [/^visibility/i, 'visibility'],
  [/^sea ?level/i, 'sea_level'],
];

/**
 * Veetaseme rida on kujul "Sealevel (EH2000 / BK77): +43 / +19 cm".
 * Võtame EH2000 (esimese) — see on Eesti kehtiv kõrgussüsteem — ja
 * teisendame SENTIMEETRID MEETRITEKS, sest kogu ülejäänud süsteem on SI-s.
 * Ilma teisenduseta näitaks kaart veetaset 43 meetrit.
 */
const SEALEVEL_CM_TO_M = 0.01;

interface ParsedWindow {
  observedAt: string | null;
  values: Partial<Record<Variable, number | null>>;
}

/**
 * Parsib `infowindow.php` HTML-tabeli.
 *
 * Tabeli read on kujul:
 *   <tr><td align=right>Wind speed / gust:</td><td>4.9 / 6.0 m/s</td></tr>
 *
 * Sildi lahtris võib olla <a>-link (graafiku avamiseks), seetõttu eemaldame
 * sildist kõik tagid enne sobitamist.
 */
export function parseInfoWindow(html: string): ParsedWindow {
  const values: ParsedWindow['values'] = {};
  let observedAt: string | null = null;

  const rows = [...html.matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)];

  if (rows.length === 0) {
    throw new Error('METOC: infoaknast ei leitud ühtki tabelirida — HTML-i struktuur muutus');
  }

  for (const [, labelRaw, valueRaw] of rows) {
    const label = stripTags(labelRaw ?? '').replace(/:$/, '').trim();
    const text = stripTags(valueRaw ?? '').trim();

    if (/^last data/i.test(label)) {
      observedAt = parseEstonianTimestamp(text);
      continue;
    }

    const hit = LABEL_MAP.find(([re]) => re.test(label));
    if (!hit) continue;

    if (hit[1] === 'sea_level') {
      const first = text.split('/')[0] ?? '';
      const cm = parseNullableFloat(first.replace(/[^\d.,+-]/g, ''));
      values.sea_level = cm === null ? null : round(cm * SEALEVEL_CM_TO_M);
      continue;
    }

    if (hit[1] === 'wind_speed_gust') {
      // "4.9 / 6.0 m/s" -> kaks eraldi väärtust
      const parts = text.split('/');
      values.wind_speed = round(parseNullableFloat(parts[0] ?? null));
      values.wind_gust = round(parseNullableFloat((parts[1] ?? '').replace(/[^\d.,-]/g, '')));
      continue;
    }

    values[hit[1]] = round(parseNullableFloat(text.replace(/[^\d.,+-]/g, '')));
  }

  return { observedAt, values };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/**
 * METOC näitab aega kujul "27.07.2026 18:50" Eesti KOHALIKUS ajas.
 * Teisendame UTC-sse, sest kogu ülejäänud süsteem räägib UTC-s.
 * Eesti on UTC+2 talvel ja UTC+3 suvel — arvutame nihke Intl API abil,
 * et suveaja üleminek ei tekitaks tunniviga.
 */
function parseEstonianTimestamp(text: string): string | null {
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;

  // Alusta oletusest, et loetud aeg ON UTC, siis korrigeeri tegeliku nihke võrra.
  const asUtc = Date.UTC(+yyyy!, +mm! - 1, +dd!, +hh!, +min!);
  const offsetMs = tallinnOffsetMs(new Date(asUtc));
  return new Date(asUtc - offsetMs).toISOString();
}

/** Tallinna ajavööndi nihe UTC-st antud hetkel, millisekundites. */
function tallinnOffsetMs(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Tallinn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - at.getTime();
}

function nearestStation(
  lat: number,
  lon: number,
): { station: StationDef; distanceKm: number } | null {
  let best: { station: StationDef; distanceKm: number } | null = null;
  for (const station of STATIONS) {
    const d = haversineKm(lat, lon, station.lat, station.lon);
    if (!best || d < best.distanceKm) best = { station, distanceKm: d };
  }
  return best;
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const metoc = new MetocProvider();
