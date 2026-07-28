import type {
  ProviderCapabilities,
  StationKind,
  StationReading,
  TimeSeries,
  Variable,
} from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchText } from '../http.js';
import { haversineKm } from './metocTaltech.js';
import { round, type PointQuery, type WeatherProvider } from './types.js';

const WFS_URL = 'https://opendata.fmi.fi/wfs';

/**
 * Katteala: Soome laht, Ahvenamaa, Saaristomeri ja Selkameri lõunaosa.
 * FMI järjekord on lääs,lõuna,ida,põhja.
 *
 * See EI ole kogu Soome. Kaks põhjust: kaugemad jaamad ei kirjelda ühtki vett,
 * kuhu siit purjetatakse, ja `weather` päring tagastab ilma bbox'ita
 * `numberReturned="0"` — piir peab niikuinii olema, seega olgu ta valitud,
 * mitte juhuslik. Mõõdetud jaamade arv: 19,59,31,61 -> 54; 19,59,31,62 -> 80;
 * kogu rannik 19,59,31,66 -> 147.
 */
const BBOX = '19,59,31,62';

/**
 * NB: bbox'i austab AINULT `weather` päring. `wave` ja `mareograph` tagastavad
 * kogu Soome jaamad sõltumata sellest, mis siin kirjas on — mõõdetuna ulatuvad
 * nad Perämereni (Kemi Ajos 65.7 N). Me ei filtreeri neid välja: Selkämeri ja
 * Perämeri poid on ainsad mõõdetud lained sealkandis ja nende äraviskamine
 * oleks info kaotamine, mitte korrastamine. `caps.bbox` kirjeldab seetõttu
 * TEGELIKKU ulatust, mitte seda konstanti.
 */

/**
 * Ilmatieteen laitos (FMI) — Soome ametlik vaatlusvõrk.
 *
 * Kolm eraldi salvestatud päringut, aga ÜKS vorming: kõik tulevad
 * `multipointcoverage`-ina, kus jaamad, ajad ja väärtused on kolmes
 * paralleelses loendis. Seetõttu piisab ühest parserist.
 *
 *   weather     rannikujaamad (Utö, Nyhamn, Russarö, Kilpilahti sadam …)
 *   wave        lainepoid (Suomenlahti, Pohjois-Itämeri, Helsinki Suomenlinna …)
 *   mareograph  veetasemejaamad (Helsinki Kaivopuisto, Hanko, Degerby …)
 *
 * Võtit ei vaja — kontrollitud päris päringutega, kõik kolm vastavad 200-ga
 * ilma ühegi autentimiseta. Litsents CC BY 4.0.
 *
 * See täidab Eesti võrgu tühimiku: METOC ja Ilmateenistus lõpevad Eesti
 * rannikul, FMI katab Soome lahe PÕHJAKALDA ja Ahvenamaa. Kaatrimehele on see
 * sama lahe teine pool, mitte võõras riik.
 */

/** Üks salvestatud päring: URL-i parameetrid ja väljade tõlge. */
interface Query {
  storedQuery: string;
  /** Lisaparameetrid; `weather` nõuab selget välja-loendit. */
  params?: Record<string, string>;
  fields: Record<string, Variable>;
  kind: StationKind;
}

const QUERIES: Query[] = [
  {
    storedQuery: 'fmi::observations::weather::multipointcoverage',
    // Ilma selleta tuleb FMI vaikimisi valik, mis ei sisalda nähtavust ega
    // sademeid. NB: tundmatu nimi annab 400 ja tapab TERVE päringu, mitte ei
    // jäta ühte veergu vahele — nt "TW_PT1H_AVG" siin ei kõlba.
    //
    // See päring nõuab ka bbox'i: ilma selleta vastab ta 200-ga, aga
    // `numberReturned="0"`, mitte veaga. Vaikne tühjus on siin lõks —
    // provider paistis töötavat, aga ilmajaamu ei tulnud ühtegi.
    params: { parameters: 't2m,ws_10min,wg_10min,wd_10min,rh,p_sea,vis,ri_10min' },
    fields: {
      t2m: 'air_temp',
      ws_10min: 'wind_speed',
      wg_10min: 'wind_gust',
      wd_10min: 'wind_dir',
      rh: 'humidity',
      p_sea: 'pressure',
      // FMI annab nähtavuse juba MEETRITES (mõõdetud: 35239, 75000), erinevalt
      // Ilmateenistusest, kes annab kilomeetrites. Teisendust siin ei ole.
      vis: 'visibility',
      ri_10min: 'precipitation',
    },
    kind: 'coastal',
  },
  {
    storedQuery: 'fmi::observations::wave::multipointcoverage',
    fields: {
      WaveHs: 'wave_height',
      ModalWDi: 'wave_dir',
      WTP: 'wave_period',
      TWATER: 'sea_temp',
    },
    kind: 'buoy',
  },
  {
    storedQuery: 'fmi::observations::mareograph::multipointcoverage',
    fields: {
      WATLEV: 'sea_level',
      TW_PT1H_AVG: 'sea_temp',
    },
    kind: 'coastal',
  },
];

/**
 * Väljad, mis vajavad ühikuteisendust meie SI-lepingusse.
 *
 * Mareograaf annab veetaseme MILLIMEETRITES (mõõdetud: 199, 302). Ilma
 * teisenduseta näitaks kaart veetaset 199 meetrit. Täpselt sama lõks oli
 * METOC-il, kus number oli sentimeetrites — kaks allikat, kaks eri ühikut,
 * kumbki neist mitte meie oma.
 */
const UNIT_SCALE: Partial<Record<string, number>> = {
  WATLEV: 0.001,
};

export class FmiProvider implements WeatherProvider {
  readonly caps: ProviderCapabilities = {
    id: 'fmi',
    label: 'Ilmatieteen laitos',
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
      'wave_height',
      'wave_dir',
      'wave_period',
      'sea_level',
    ],
    supportsGrid: false,
    supportsStations: true,
    bbox: [59.0, 19.0, 66.0, 30.0],
    forecastHours: 0,
    attribution: 'Ilmatieteen laitos (CC BY 4.0)',
    attributionUrl: 'https://en.ilmatieteenlaitos.fi/open-data',
    enabled: true,
  };

  readonly warmIntervalSeconds = 300;

  async stations(): Promise<StationReading[]> {
    const parsed = await this.#load();
    const now = Date.now();

    return parsed.map((s) => ({
      id: s.id,
      providerId: this.caps.id,
      name: s.name,
      kind: s.kind,
      lat: s.lat,
      lon: s.lon,
      observedAt: s.observedAt,
      ageSeconds: s.observedAt
        ? Math.max(0, Math.round((now - new Date(s.observedAt).getTime()) / 1000))
        : null,
      values: s.values,
    }));
  }

  async point(q: PointQuery): Promise<TimeSeries[]> {
    const parsed = await this.#load();

    let best: ParsedStation | null = null;
    let bestDist = Infinity;
    for (const s of parsed) {
      const d = haversineKm(q.lat, q.lon, s.lat, s.lon);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    // Sama piir mis Ilmateenistusel: kaugem jaam ei kirjelda enam seda punkti.
    if (!best || bestDist > 30 || !best.observedAt) return [];

    return [
      {
        providerId: this.caps.id,
        lat: best.lat,
        lon: best.lon,
        updatedAt: best.observedAt,
        steps: [{ time: best.observedAt, values: best.values }],
      },
    ];
  }

  async warm(): Promise<void> {
    await this.#load();
  }

  async #load(): Promise<ParsedStation[]> {
    // `allSettled`, mitte `all`: kui üks kolmest päringust katkeb (FMI on
    // korduvalt tagastanud 400 ühe tundmatu parameetri pärast), peavad
    // ülejäänud jaamad ikka kaardile jõudma.
    const results = await Promise.allSettled(
      QUERIES.map(async (q) => {
        const params = new URLSearchParams({
          service: 'WFS',
          version: '2.0.0',
          request: 'getFeature',
          storedquery_id: q.storedQuery,
          bbox: BBOX,
          ...(q.params ?? {}),
        });
        const key = `fmi:${params.toString()}`;
        const { value } = await cache.get(key, config.ttl.fmi, () =>
          fetchText(`${WFS_URL}?${params}`, { timeoutMs: 30_000 }),
        );
        return parseMultiPointCoverage(value, q);
      }),
    );

    // Sama koht võib esineda mitmes päringus (nt rannikujaam, kus on ka
    // mareograaf). Liidame väärtused kokku, et kaardile ei tekiks kahte
    // markerit samasse punkti.
    const byId = new Map<string, ParsedStation>();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const s of r.value) {
        const existing = byId.get(s.id);
        if (!existing) {
          byId.set(s.id, s);
          continue;
        }
        existing.values = { ...existing.values, ...s.values };
        // Poi on täpsem kirjeldus kui rannikujaam — las see võidab.
        if (s.kind === 'buoy') existing.kind = 'buoy';
        if (
          s.observedAt &&
          (!existing.observedAt || s.observedAt > existing.observedAt)
        ) {
          existing.observedAt = s.observedAt;
        }
      }
    }
    return [...byId.values()];
  }
}

export interface ParsedStation {
  id: string;
  name: string;
  kind: StationKind;
  lat: number;
  lon: number;
  observedAt: string | null;
  values: Partial<Record<Variable, number | null>>;
}

/** `<gml:Point gml:id="point-101003">` -> nimi ja koordinaat. */
const POINT_RE =
  /<gml:Point[^>]*gml:id="point-([^"]+)"[^>]*>\s*<gml:name>([^<]*)<\/gml:name>\s*<gml:pos>\s*([-\d.]+)\s+([-\d.]+)/g;

const FIELD_RE = /<swe:field\s+name="([^"]+)"/g;

function block(xml: string, tag: string): string | null {
  const start = xml.indexOf(`<${tag}>`);
  if (start < 0) return null;
  const end = xml.indexOf(`</${tag}>`, start);
  if (end < 0) return null;
  return xml.slice(start + tag.length + 2, end);
}

/** Ühine võti jaama sidumiseks andmereaga. Kraadid, viis kohta ~1 m täpsus. */
function posKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/**
 * Parsib FMI `multipointcoverage` vastuse.
 *
 * Vormingu tuum on KOLM paralleelset loendit:
 *   `<gml:Point>`      jaamad — nimi ja koordinaat
 *   `<gmlcov:positions>`  read kujul "lat lon unix_aeg"
 *   `<gml:doubleOrNilReasonTupleList>` sama arv ridu, veerud `<swe:field>` järjekorras
 *
 * Rida seotakse jaamaga KOORDINAADI, mitte järjekorra kaudu — jaamade loend ja
 * ridade järjekord ei ole sama asi ja järjekorrale toetumine annaks vaikselt
 * vale jaama väärtused.
 *
 * Puuduv mõõtmine on sõna-sõnalt "NaN". Iga välja jaoks võtame VIIMASE
 * mitte-NaN väärtuse eraldi, sest parameetrid raporteerivad eri sammuga:
 * tuul iga 10 min, veetemperatuur kord tunnis. Ühe "viimase rea" võtmine
 * jätaks poole väljadest tühjaks.
 */
export function parseMultiPointCoverage(xml: string, q: Query): ParsedStation[] {
  const fields: string[] = [];
  for (const m of xml.matchAll(FIELD_RE)) fields.push(m[1]!);
  if (fields.length === 0) return [];

  const positions = block(xml, 'gmlcov:positions');
  const tuples = block(xml, 'gml:doubleOrNilReasonTupleList');
  if (!positions || !tuples) return [];

  const posRows = positions.trim().split('\n');
  const valRows = tuples.trim().split('\n');
  if (posRows.length !== valRows.length) return [];

  /** posKey -> väljanimi -> [aeg, väärtus] */
  const latest = new Map<string, Map<string, [number, number]>>();

  for (let i = 0; i < posRows.length; i++) {
    const p = posRows[i]!.trim().split(/\s+/);
    if (p.length < 3) continue;
    const lat = Number(p[0]);
    const lon = Number(p[1]);
    const time = Number(p[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(time)) continue;

    const cells = valRows[i]!.trim().split(/\s+/);
    const key = posKey(lat, lon);
    let perField = latest.get(key);
    if (!perField) {
      perField = new Map();
      latest.set(key, perField);
    }

    for (let c = 0; c < fields.length && c < cells.length; c++) {
      const raw = cells[c]!;
      if (raw === 'NaN') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      const prev = perField.get(fields[c]!);
      if (!prev || time > prev[0]) perField.set(fields[c]!, [time, n]);
    }
  }

  const out: ParsedStation[] = [];
  for (const m of xml.matchAll(POINT_RE)) {
    const [, id, name, latRaw, lonRaw] = m;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const perField = latest.get(posKey(lat, lon));
    if (!perField || perField.size === 0) continue;

    const values: Partial<Record<Variable, number | null>> = {};
    let newest = 0;
    for (const [field, variable] of Object.entries(q.fields)) {
      const hit = perField.get(field);
      if (!hit) continue;
      const scale = UNIT_SCALE[field] ?? 1;
      values[variable] = round(hit[1] * scale, 3);
      if (hit[0] > newest) newest = hit[0];
    }
    if (Object.keys(values).length === 0) continue;

    out.push({
      id: `fmi-${id}`,
      name: (name ?? '').trim(),
      // "aaltopoiju" = lainepoi. Nimi on ainus koht, kus FMI seda ütleb.
      kind: /aaltopoiju/i.test(name ?? '') ? 'buoy' : q.kind,
      lat,
      lon,
      observedAt: newest > 0 ? new Date(newest * 1000).toISOString() : null,
      values,
    });
  }
  return out;
}

export const fmi = new FmiProvider();
