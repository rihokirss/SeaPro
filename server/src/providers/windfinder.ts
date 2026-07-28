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
const DATA_MAJOR = /_data-major_[^"]*"[^>]*>([\d.,]+)\s*([a-z/]*)</i;
const DATA_MINOR = /_data-minor_[^"]*"[^>]*>[\s\S]*?([\d.,]+)\s*</i;

/**
 * Üks läbijooks kogu lehest, dokumendi järjekorras. Iga veerg annab
 * täpselt kolm märki samas järjekorras: TIME -> DIR -> WIND.
 */
const TOKEN = new RegExp(
  [
    // Päevapäis, nt "Tuesday, Jul 28"
    String.raw`(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s*(?<mon>[A-Z][a-z]{2})[a-z]*\s+(?<dom>\d{1,2})`,
    // Tunnisilt, nt "00h" (võib olla pesastatud elementide sees)
    String.raw`_cell-timespan_[^"]*"[^>]*>(?:\s*<[^>]+>)*?\s*(?<hour>\d{2})h`,
    // Suund nooleikooni alt-atribuudis, nt alt="171.94°"
    String.raw`_cell-direction_[^"]*"[\s\S]{0,400}?alt="(?<dir>[\d.]+)°"`,
    // Tuulelahter koos major/minor väärtustega
    String.raw`(?<wind>_cell-wind-speeds_[^"]*"[\s\S]*?<\/div>\s*<\/div>)`,
  ].join('|'),
  'g',
);

/** Ajavöönd on lehel Astro andmete sees, nt "Europe/Helsinki". */
const TIMEZONE = /Europe\/[A-Za-z_]+/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parsib prognoosilehe veerud.
 *
 * Struktuur ühe veeru kohta:
 *   <div class="_cell-timespan_…">00h</div>
 *   <div class="_cell-direction_…"><img alt="171.94°" style="rotate(171.94deg)"></div>
 *   <div class="_cell-wind-speeds_…">
 *     <div class="_data-major_…">4 m/s</div>
 *     <div class="_data-minor_…">max 7</div>
 *   </div>
 *
 * AJATELG LOETAKSE LEHELT, mitte ei ehitata ise.
 *
 * Varem eeldas kood, et esimene veerg on käesolev tund, ja liikus sealt
 * 3-tunniste sammudega. See oli vale: leht algab alati päeva esimesest
 * veerust (00h kohalikku aega), ka siis, kui see on juba minevikus.
 * 28.07.2026 andis see 17 tunni nihke — väärtused olid õiged, aga rippusid
 * vale aja küljes, mis on graafikul teiste allikate kõrval eksitav.
 *
 * Kellaajad on spoti KOHALIKUS ajas; ajavöönd tuleb lehelt endalt, sest
 * fikseeritud nihe läheks suve- ja talveaja vahetusel valeks.
 */
export function parseForecastPage(html: string, now: Date = new Date()): TimeStep[] {
  // Kõik meie spotid on EE/FI/Ahvenamaa, mis jagavad sama vööndit — seega
  // varuvariant on ohutu, kui Astro andmete kuju muutub.
  const tz = html.match(TIMEZONE)?.[0] ?? 'Europe/Helsinki';

  const steps: TimeStep[] = [];
  let date: { month: number; dom: number } | null = null;
  let hour: number | null = null;
  let dir: number | null = null;
  let sawWindCell = false;

  for (const m of html.matchAll(TOKEN)) {
    const g = m.groups!;

    if (g.mon !== undefined) {
      const month = MONTHS.indexOf(g.mon.toLowerCase());
      if (month >= 0) date = { month, dom: Number(g.dom) };
      continue;
    }
    if (g.hour !== undefined) {
      hour = Number(g.hour);
      continue;
    }
    if (g.dir !== undefined) {
      const d = Number(g.dir);
      dir = Number.isFinite(d) ? d : null;
      continue;
    }
    if (g.wind === undefined) continue;

    sawWindCell = true;
    const cell = g.wind;

    const major = cell.match(DATA_MAJOR);
    if (!major || date === null || hour === null) continue;

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

    steps.push({
      time: new Date(
        zonedHourToUtc(resolveYear(date.month, date.dom, now), date.month, date.dom, hour, tz),
      ).toISOString(),
      values: {
        wind_speed: round(ms),
        wind_gust: round(gust),
        wind_dir: dir !== null ? round(dir, 0) : null,
      },
    });
  }

  if (!sawWindCell) {
    throw new Error(
      'Windfinder: ühtki tuulekiiruse lahtrit ei leitud — lehe struktuur muutus, parser vajab parandust',
    );
  }
  if (steps.length === 0) {
    throw new Error(
      'Windfinder: lahtrid leiti, aga ühtki väärtust ei õnnestunud lugeda — vorming muutus',
    );
  }

  return steps;
}

/**
 * Päevapäis annab kuu ja päeva, aga MITTE aastat. Valime aasta, mille korral
 * kuupäev jääb vaatlushetkele kõige lähemale — see teeb õige valiku ka
 * aastavahetusel, kus leht näitab korraga detsembrit ja jaanuari.
 */
function resolveYear(month: number, dom: number, now: Date): number {
  const y = now.getUTCFullYear();
  let best = y;
  let bestDist = Infinity;
  for (const candidate of [y - 1, y, y + 1]) {
    const dist = Math.abs(Date.UTC(candidate, month, dom) - now.getTime());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/**
 * Kohalik seinakellaaeg -> UTC ajatempel.
 *
 * Node-is puudub selleks otsene API, seega küsime vööndi nihke Intl-ilt ja
 * korrigeerime. Teine ring on vajalik kellakeeramise öödel, kus esimene
 * oletus võib sattuda vale nihkega poolele.
 */
function zonedHourToUtc(year: number, month: number, dom: number, hour: number, tz: string): number {
  const naive = Date.UTC(year, month, dom, hour);
  const first = tzOffsetMs(naive, tz);
  const ts = naive - first;
  const second = tzOffsetMs(ts, tz);
  return second === first ? ts : naive - second;
}

/** Kui palju vööndi kellaaeg antud hetkel UTC-st erineb. */
function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
    ts
  );
}

export const windfinder = new WindfinderProvider();
