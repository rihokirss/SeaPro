import type { ProviderCapabilities, TimeSeries, TimeStep } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchText } from '../http.js';
import spotList from '../stations/windfinder-spots.json' with { type: 'json' };
import { haversineKm } from './metocTaltech.js';
import { round, type PointQuery, type WeatherProvider } from './types.js';

interface Spot {
  slug: string;
  name: string;
  lat: number;
  lon: number;
}

const SPOTS = spotList as Spot[];

/**
 * Kui kaugel tohib lähim spot olla.
 *
 * Windfinderi spotid on KOHAD, mitte võrgustik — nimekirjas on ka sisemaiseid
 * punkte (lennuväljad, alevikud). Ilma piirita tagastaks avamerepunkti kohta
 * mõne kümne kilomeetri kaugusel asuva sisemaise koha tuule, mis mereolukorda
 * ei kirjelda.
 */
const MAX_SPOT_DISTANCE_KM = 25;

const BASE = 'https://www.windfinder.com';

/**
 * Windfinder.
 *
 * ⚠ AINUS ALLIKAS, MIS EI OLE LEPINGULINE API. Windfinderi avalik API on
 * tasuline B2B-teenus; siin parsime nende avalikku prognoosilehte. See
 * tähendab kolme asja, mis on koodi kujundanud:
 *
 *  1. **Klassinimed on hašitud.** Leht on ehitatud Astro + CSS-moodulitega,
 *     seega klass on kujul `_cell-wind-speeds_1swh1_235`, kus järelliide
 *     muutub iga nende deploy'ga. Sobitame AINULT prefiksi järgi.
 *
 *  2. **Parser võib iga hetk katki minna.** Sellepärast viskab ta valju vea
 *     ("struktuur muutus") ega tagasta vaikselt tühja või poolikut vastust.
 *     Vaikne tühi vastus näeks kasutajale välja nagu "tuult pole", mis on
 *     mereilmarakenduses ohtlikum kui nähtav veateade.
 *
 *  3. **Windfinder ei tohi olla ühegi tuumikfunktsiooni eeltingimus.** Ta on
 *     võrdlusallikas kõrvuti teistega; tema kadumine ei tohi midagi muud
 *     katki teha.
 *
 * Päringute maht hoitakse minimaalsena (TTL 30 min) — see on nii viisakus
 * kui enesekaitse.
 */
export class WindfinderProvider implements WeatherProvider {
  readonly caps: ProviderCapabilities = {
    id: 'windfinder',
    label: 'Windfinder',
    kind: 'forecast',
    variables: ['wind_speed', 'wind_gust', 'wind_dir', 'air_temp'],
    supportsGrid: false,
    supportsStations: false,
    forecastHours: 3 * 24,
    attribution: 'Windfinder.com',
    attributionUrl: 'https://www.windfinder.com/',
    enabled: true,
  };

  async point(q: PointQuery): Promise<TimeSeries[]> {
    // Windfinder töötab nimeliste spottidega, mitte koordinaatidega —
    // koordinaadipõhine URL vastab 404-ga. Lähima spoti leiame kohalikust
    // nimekirjast (`scripts/scrape-windfinder-spots.ts`).
    const spot = nearestSpot(q.lat, q.lon);
    if (!spot) return [];

    const url = `${BASE}/forecast/${spot.spot.slug}`;

    const { value: html } = await cache.get(`wf:${url}`, config.ttl.windfinder, () =>
      fetchText(url, {
        headers: {
          // Windfinder blokeerib tundmatud kliendid; anname end siiski ausalt
          // teada, lisades kontakti — nii saavad nad meiega ühendust võtta,
          // kui see neile ei sobi.
          Accept: 'text/html',
          'Accept-Language': 'en',
        },
        timeoutMs: 20_000,
        retries: 1,
      }),
    );

    const steps = parseForecastPage(html);
    if (steps.length === 0) return [];

    return [
      {
        providerId: this.caps.id,
        // Anname spoti koordinaadi, mitte küsitu — nii on kasutajale näha,
        // ET tegu on lähima nimelise kohaga, mitte täpselt selle punktiga.
        lat: spot.spot.lat,
        lon: spot.spot.lon,
        steps,
      },
    ];
  }
}

function nearestSpot(lat: number, lon: number): { spot: Spot; distanceKm: number } | null {
  let best: { spot: Spot; distanceKm: number } | null = null;
  for (const spot of SPOTS) {
    const d = haversineKm(lat, lon, spot.lat, spot.lon);
    if (!best || d < best.distanceKm) best = { spot, distanceKm: d };
  }
  return best && best.distanceKm <= MAX_SPOT_DISTANCE_KM ? best : null;
}

/**
 * Prefiksipõhised mustrid. Hašitud järelliide (`_1swh1_235`) jäetakse
 * sihilikult sobitamata — just see osa muutub nende deploy'ga.
 */
const CELL_WIND = /_cell-wind-speeds_[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
const DATA_MAJOR = /_data-major_[^"]*"[^>]*>([\d.,]+)\s*([a-z/]*)</i;
const DATA_MINOR = /_data-minor_[^"]*"[^>]*>[\s\S]*?([\d.,]+)\s*</i;

/** Suund on nooleikooni `alt`-atribuudis, nt alt="171.94°". */
const DIRECTION = /_cell-direction_[^"]*"[\s\S]*?alt="([\d.]+)°"/g;

/**
 * Parsib prognoosilehe tunniveerud.
 *
 * Struktuur ühe veeru kohta:
 *   <div class="_cell-direction_…"><img alt="171.94°" style="rotate(171.94deg)"></div>
 *   <div class="_cell-wind-speeds_…">
 *     <div class="_data-major_…">4 m/s</div>
 *     <div class="_data-minor_…">max 7</div>
 *   </div>
 *
 * Ajatempleid leht masinloetavalt ei anna — veerud on lihtsalt järjestikused
 * 3-tunnised sammud. Seetõttu ehitame ajatelje ise, alustades käesolevast
 * täistunnist. See on ligikaudne ja seda EI TOHI kasutada täpseks
 * ajavõrdluseks teiste allikatega; sobib trendi kõrvutamiseks.
 */
export function parseForecastPage(html: string): TimeStep[] {
  const speeds = [...html.matchAll(CELL_WIND)].map((m) => m[0]);
  const directions = [...html.matchAll(DIRECTION)].map((m) => Number(m[1]));

  if (speeds.length === 0) {
    throw new Error(
      'Windfinder: ühtki tuulekiiruse lahtrit ei leitud — lehe struktuur muutus, parser vajab parandust',
    );
  }

  const now = new Date();
  now.setUTCMinutes(0, 0, 0);

  const steps: TimeStep[] = [];

  for (let i = 0; i < speeds.length; i++) {
    const cell = speeds[i]!;

    const major = cell.match(DATA_MAJOR);
    if (!major) continue;

    const speed = Number(major[1]!.replace(',', '.'));
    const unit = (major[2] ?? '').toLowerCase();

    // Leht võib kasutada sõlmi või km/h sõltuvalt lokaadist. Teisendame
    // meie SI-lepingusse; tundmatu ühiku puhul jätame väärtuse vahele,
    // sest vale ühik on halvem kui puuduv väärtus.
    let ms: number | null;
    if (unit.startsWith('m/s') || unit === '') ms = speed;
    else if (unit.startsWith('kt') || unit.startsWith('kn')) ms = speed / 1.943844;
    else if (unit.startsWith('km')) ms = speed / 3.6;
    else if (unit.startsWith('mph')) ms = speed * 0.44704;
    else ms = null;

    if (ms === null) continue;

    const minor = cell.match(DATA_MINOR);
    const gustRaw = minor ? Number(minor[1]!.replace(',', '.')) : null;
    const gust =
      gustRaw === null || !Number.isFinite(gustRaw)
        ? null
        : unit.startsWith('kt') || unit.startsWith('kn')
          ? gustRaw / 1.943844
          : unit.startsWith('km')
            ? gustRaw / 3.6
            : unit.startsWith('mph')
              ? gustRaw * 0.44704
              : gustRaw;

    const dir = directions[i];

    steps.push({
      // Windfinderi tasuta vaade on 3-tunnise sammuga.
      time: new Date(now.getTime() + i * 3 * 3600_000).toISOString(),
      values: {
        wind_speed: round(ms),
        wind_gust: round(gust),
        wind_dir: dir !== undefined && Number.isFinite(dir) ? round(dir, 0) : null,
      },
    });
  }

  if (steps.length === 0) {
    throw new Error(
      'Windfinder: lahtrid leiti, aga ühtki väärtust ei õnnestunud lugeda — vorming muutus',
    );
  }

  return steps;
}

export const windfinder = new WindfinderProvider();
