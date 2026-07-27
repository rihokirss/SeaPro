import type {
  ProviderCapabilities,
  StationReading,
  TimeSeries,
  TimeStep,
} from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchJson, fetchText } from '../http.js';
import { haversineKm } from './metocTaltech.js';
import { parseNullableFloat, round, type PointQuery, type WeatherProvider } from './types.js';

const BASE = 'https://lainepoiss.eu';
const CONF_URL = `${BASE}/dashboard/buoys_conf.json`;

interface BuoyConf {
  no: number;
  name: string;
  /** Nt "../lp_data/LP_15/" — suhteline dashboard'i suhtes. */
  directory: string;
  show: boolean;
  active: boolean;
  showDataFrom: string | null;
  showDataTo: string | null;
}

/**
 * `web.txt` rea veerud. Kinnitatud portaali oma skriptist (`lp_script.js`),
 * mis loeb cols[5] = Hmax, cols[7] = Pdir_naut, cols[8] = mean_dir.
 */
const COL = {
  date: 0,
  time: 1,
  lat: 2,
  lon: 3,
  hs: 4,
  hmax: 5,
  period: 6,
  peakDir: 7,
  meanDir: 8,
  battery: 9,
} as const;

const EXPECTED_COLS = 10;

/**
 * Kui vana tohib poi viimane mõõtmine olla, et teda kaardil näidata.
 *
 * Konfiguratsioon loetleb ka ammu lõpetatud paigaldusi — Atlandi ookeani ja
 * Ålesundi poisid aastatest 2022–2023, mille viimased read on endiselt
 * failides alles. Need pole "praegune mereolukord" ja Läänemere kaardil oleks
 * nende näitamine otsene eksitus.
 */
const MAX_AGE_SECONDS = 48 * 3600;

/**
 * Kui kaugele tulevikku ajatempel tohib ulatuda.
 *
 * Andmetes esineb rikutud ridu — üks poi raporteeris kuupäeva aastal 2226.
 * Ilma selle kontrollita tõuseks selline rida "kõige värskemaks" ja kuvaks
 * vale mõõtmise praegusena.
 */
const MAX_FUTURE_SECONDS = 3600;

interface BuoySample {
  time: string;
  lat: number;
  lon: number;
  hs: number | null;
  hmax: number | null;
  period: number | null;
  dir: number | null;
}

/**
 * LainePoiss — Eesti lainepoide võrk (WiseParker OÜ).
 *
 * Kõige lihtsam allikas kogu projektis: konfiguratsioon on JSON, andmed on
 * tühikutega eraldatud tekstifail. Samas ka üks väärtuslikumaid — päris
 * MÕÕDETUD lainekõrgus Eesti vetes, mida globaalsed lainemudelid (EWAM, GWAM)
 * madalas ja saarterohkes Läänemeres sageli valesti hindavad.
 *
 * Kaks asja, mida parser peab taluma:
 *  1. Positsioon tuleb andmereast endast — poi triivib ankru otsas ja teda
 *     tõstetakse hooajati ümber. Staatiline koordinaat oleks vale.
 *  2. Veerud võivad sisaldada sõna "NaN" (nt poil 35 puudub Hmax ja mean_dir).
 */
export class LainePoissProvider implements WeatherProvider {
  readonly caps: ProviderCapabilities = {
    id: 'lainepoiss',
    label: 'LainePoiss',
    kind: 'observation',
    variables: ['wave_height', 'wave_max_height', 'wave_period', 'wave_dir'],
    supportsGrid: false,
    supportsStations: true,
    forecastHours: 0,
    attribution: 'LainePoiss® / WiseParker OÜ',
    attributionUrl: 'https://lainepoiss.eu/dashboard/',
    enabled: true,
  };

  readonly warmIntervalSeconds = 300;

  async stations(): Promise<StationReading[]> {
    const buoys = await this.#config();
    // `allSettled`, mitte `all`: konfiguratsioonis on poisid (nt 24 ja 28),
    // millel andmefaili polegi ja mis vastavad 404-ga. Üks selline ei tohi
    // kogu poide võrku ekraanilt kustutada.
    const results = await Promise.allSettled(buoys.map((b) => this.#readBuoy(b)));
    return results
      .filter(
        (r): r is PromiseFulfilledResult<StationReading | null> => r.status === 'fulfilled',
      )
      .map((r) => r.value)
      .filter((r): r is StationReading => r !== null);
  }

  async point(q: PointQuery): Promise<TimeSeries[]> {
    const buoys = await this.#config();
    const settled = await Promise.allSettled(buoys.map((b) => this.#readBuoy(b)));
    const readings = settled
      .filter(
        (r): r is PromiseFulfilledResult<StationReading | null> => r.status === 'fulfilled',
      )
      .map((r) => r.value)
      .filter((r): r is StationReading => r !== null && r.observedAt !== null);

    let best: StationReading | null = null;
    let bestDist = Infinity;
    for (const r of readings) {
      const d = haversineKm(q.lat, q.lon, r.lat, r.lon);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    // Lainepoi mõõdab ühte kohta. Üle 30 km kaugusel on lainestik juba teine.
    if (!best || bestDist > 30) return [];

    // Anname lühikese ajaloo, et graafikul oleks trend näha.
    const conf = buoys.find((b) => String(b.no) === best!.id);
    const history = conf ? await this.#history(conf, q.hours) : [];

    return [
      {
        providerId: this.caps.id,
        lat: best.lat,
        lon: best.lon,
        updatedAt: best.observedAt ?? undefined,
        steps: history,
      },
    ];
  }

  async warm(): Promise<void> {
    const buoys = await this.#config();
    for (const b of buoys) {
      try {
        await this.#readBuoy(b);
      } catch {
        // Üksik poi vait — ülejäänud võrk töötab edasi.
      }
    }
  }

  /** Ainult need poid, mida portaal ise näitab või mis on aktiivsed. */
  async #config(): Promise<BuoyConf[]> {
    const { value } = await cache.get('lp:conf', 6 * 3600, () =>
      fetchJson<BuoyConf[]>(CONF_URL),
    );
    return value.filter((b) => b.show || b.active);
  }

  async #readBuoy(conf: BuoyConf): Promise<StationReading | null> {
    const samples = await this.#samples(conf);
    const last = samples.at(-1);

    const name = cleanName(conf.name, conf.no);

    if (!last) {
      return null;
    }

    const ageSeconds = Math.max(0, (Date.now() - new Date(last.time).getTime()) / 1000);

    // Lõpetatud paigaldus — portaal ise märgib selle `showDataTo`-ga, aga
    // vanuse kontroll katab ka need, mida pole märgitud.
    if (ageSeconds > MAX_AGE_SECONDS) return null;

    return {
      id: String(conf.no),
      providerId: this.caps.id,
      name,
      kind: 'buoy',
      lat: last.lat,
      lon: last.lon,
      // Poi triivib ja teda tõstetakse ümber — marker peab andmetega kaasa liikuma.
      mobile: true,
      observedAt: last.time,
      ageSeconds,
      values: {
        wave_height: last.hs,
        wave_max_height: last.hmax,
        wave_period: last.period,
        wave_dir: last.dir,
      },
    };
  }

  async #history(conf: BuoyConf, hours: number): Promise<TimeStep[]> {
    const samples = await this.#samples(conf);
    const cutoff = Date.now() - hours * 3600_000;
    return samples
      .filter((s) => new Date(s.time).getTime() >= cutoff)
      .map((s) => ({
        time: s.time,
        values: {
          wave_height: s.hs,
          wave_max_height: s.hmax,
          wave_period: s.period,
          wave_dir: s.dir,
        },
      }));
  }

  async #samples(conf: BuoyConf): Promise<BuoySample[]> {
    // Tee tuleb konfist, mitte numbrist kokku pandult — kataloogi nimi on
    // portaali enda otsustada ja võib erineda poi numbrist.
    const path = conf.directory.replace(/^\.\./, '');
    const key = `lp:web:${conf.no}`;
    const { value } = await cache.get(key, config.ttl.lainepoiss, () =>
      fetchText(`${BASE}${path}web.txt`, { timeoutMs: 20_000, retries: 1 }),
    );
    return parseWebTxt(value);
  }
}

/**
 * Parsib `web.txt`.
 *
 * Vorming: `2026-07-27 16:01:55 59.3911 24.0698 0.272 0.505 2.964 310 316 4.07`
 * Ajad on UTC-s (portaali graafikud kuvavad neid UTC-na).
 *
 * Failis on kogu poi eluaja ajalugu, mis võib olla sadu tuhandeid ridu.
 * Loeme ainult lõpu — vanem ajalugu pole selles rakenduses kasutusel.
 */
export function parseWebTxt(text: string, maxRows = 4000): BuoySample[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];

  const start = Math.max(0, lines.length - maxRows);
  const out: BuoySample[] = [];

  for (let i = start; i < lines.length; i++) {
    const cols = lines[i]!.trim().split(/\s+/);
    // Vale veergude arv = rida on rikutud või formaat muutus; jäta vahele,
    // aga ära viska viga — üks katkine rida ei tohi kogu poid kustutada.
    if (cols.length !== EXPECTED_COLS) continue;

    const lat = parseNullableFloat(cols[COL.lat]);
    const lon = parseNullableFloat(cols[COL.lon]);
    if (lat === null || lon === null) continue;

    const time = `${cols[COL.date]}T${cols[COL.time]}Z`;
    const stamp = new Date(time).getTime();
    if (Number.isNaN(stamp)) continue;
    // Tulevikus olev ajatempel on rikutud rida, mitte prognoos.
    if (stamp > Date.now() + MAX_FUTURE_SECONDS * 1000) continue;

    out.push({
      time,
      lat,
      lon,
      hs: round(parseNullableFloat(cols[COL.hs])),
      hmax: round(parseNullableFloat(cols[COL.hmax])),
      period: round(parseNullableFloat(cols[COL.period])),
      // Eelistame tipplaine suunda; kui see puudub, võtame keskmise.
      dir: parseNullableFloat(cols[COL.peakDir]) ?? parseNullableFloat(cols[COL.meanDir]),
    });
  }

  if (out.length === 0 && lines.length > 0) {
    throw new Error(
      `LainePoiss: ükski ${lines.length} reast ei vastanud ${EXPECTED_COLS}-veerulisele vormingule`,
    );
  }

  return out;
}

/** Konfiguratsioonis on nimed kujul "15 - Pakri" või "28" või "1 - ". */
function cleanName(raw: string, no: number): string {
  const withoutNumber = raw.replace(/^\s*\d+\s*-?\s*/, '').trim();
  return withoutNumber.length > 0 ? withoutNumber : `LP ${no}`;
}

export const lainepoiss = new LainePoissProvider();
