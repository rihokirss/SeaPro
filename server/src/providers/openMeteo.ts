import type {
  GridFrame,
  GridPoint,
  ProviderCapabilities,
  TimeSeries,
  TimeStep,
  Variable,
} from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { HttpError, fetchJson } from '../http.js';
import { rateLimiter } from '../rateLimit.js';
import { round, type GridQuery, type PointQuery, type WeatherProvider } from './types.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

/**
 * Open-Meteo muutuja -> meie muutuja.
 * Kiirused küsime otse m/s-is (`wind_speed_unit=ms`), nii et teisendust pole vaja.
 */
const ATMO_VARS: Record<string, Variable> = {
  wind_speed_10m: 'wind_speed',
  wind_gusts_10m: 'wind_gust',
  wind_direction_10m: 'wind_dir',
  temperature_2m: 'air_temp',
  pressure_msl: 'pressure',
  relative_humidity_2m: 'humidity',
  precipitation: 'precipitation',
  cloud_cover: 'cloud_cover',
  visibility: 'visibility',
};

const MARINE_VARS: Record<string, Variable> = {
  wave_height: 'wave_height',
  wave_direction: 'wave_dir',
  wave_period: 'wave_period',
  swell_wave_height: 'swell_height',
  swell_wave_direction: 'swell_dir',
  swell_wave_period: 'swell_period',
  sea_surface_temperature: 'sea_temp',
  sea_level_height_msl: 'sea_level',
  ocean_current_velocity: 'current_speed',
  ocean_current_direction: 'current_dir',
};

const ATMO_BY_VARIABLE = invert(ATMO_VARS);
const MARINE_BY_VARIABLE = invert(MARINE_VARS);

function invert(map: Record<string, Variable>): Partial<Record<Variable, string>> {
  const out: Partial<Record<Variable, string>> = {};
  for (const [api, mine] of Object.entries(map)) out[mine] = api;
  return out;
}

/**
 * Mudelid, mis on Läänemerel mõistlikud. Open-Meteo pakub kümneid, aga
 * globaalsete madala lahutusega mudelite lisamine ainult segaks valikut.
 */
const MODELS = [
  { id: 'best_match', label: 'Automaatne', note: 'Open-Meteo valib asukohale parima mudeli' },
  { id: 'metno_nordic', label: 'MET Nordic', note: 'MET Norway, 1 km, Põhjala — parim lahutus Läänemerel' },
  { id: 'icon_eu', label: 'ICON-EU', note: 'DWD, 7 km, Euroopa' },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS', note: 'ECMWF, 25 km, globaalne — hea suurte süsteemide jaoks' },
  { id: 'gfs_seamless', label: 'GFS', note: 'NOAA, 11–25 km, globaalne' },
] as const;

const DEFAULT_MODELS = ['best_match'];

/** Lainemudelid on eraldi API-s ja eraldi nimedega. */
const WAVE_MODELS = [
  { id: 'best_match', label: 'Automaatne' },
  { id: 'ewam', label: 'DWD EWAM', note: '5 km, Euroopa rannikumered' },
  { id: 'gwam', label: 'DWD GWAM', note: '25 km, globaalne' },
] as const;

interface OmResponse {
  latitude: number;
  longitude: number;
  hourly?: Record<string, (number | null)[] | string[]>;
  hourly_units?: Record<string, string>;
}

/**
 * Kutsub Open-Meteot, hoides päringueelarvet ausana.
 *
 * Kolm asja, mis siin koos peavad olema:
 *
 *  1. Eelarve broneeritakse ENNE päringut — muidu võiks kümme samaaegset
 *     päringut limiidist üle joosta.
 *  2. Ebaõnnestumise korral tagastatakse see. Varem jäi kulu külge ka siis,
 *     kui vastust ei tulnud: eelarve tühjenes ilma ühegi andmereata.
 *  3. Allika enda 429 paneb jahtumise peale. Ilma selleta pommitas iga
 *     kliendipäring allikat edasi ja meie eelarve sulas — täpselt see
 *     juhtuski, kui Open-Meteo tunnilimiit täis sai.
 *  4. Õnnestumine LÕPETAB jahtumise. Muidu istuks rakendus ooteajas ka siis,
 *     kui allikas on juba taastunud (nt IP vahetus).
 */
async function fetchBudgeted<T>(url: string, cost: number): Promise<T> {
  rateLimiter.spend('open-meteo', cost);
  try {
    const result = await fetchJson<T>(url);
    // Õnnestunud vastus tähendab, et allikas on taas saadaval — kui me olime
    // jahtumises, pole selle hoidmine enam põhjendatud.
    rateLimiter.recovered('open-meteo');
    return result;
  } catch (err) {
    rateLimiter.refund('open-meteo', cost);
    if (err instanceof HttpError && err.status === 429) {
      // Open-Meteo lähtestab tunni piiril; ootame järgmise aknani.
      const secondsToNextHour = Math.ceil((3600_000 - (Date.now() % 3600_000)) / 1000);
      rateLimiter.cooldown('open-meteo', secondsToNextHour);
    }
    throw err;
  }
}

const ALL_VARIABLES: Variable[] = [
  ...Object.values(ATMO_VARS),
  ...Object.values(MARINE_VARS),
];

export class OpenMeteoProvider implements WeatherProvider {
  readonly caps: ProviderCapabilities = {
    id: 'open-meteo',
    label: 'Open-Meteo',
    kind: 'forecast',
    variables: ALL_VARIABLES,
    models: [...MODELS],
    supportsGrid: true,
    supportsStations: false,
    forecastHours: 7 * 24,
    attribution: 'Open-Meteo.com (CC BY 4.0)',
    attributionUrl: 'https://open-meteo.com/',
    enabled: true,
  };

  async point(q: PointQuery): Promise<TimeSeries[]> {
    const wanted = q.variables?.length ? q.variables : ALL_VARIABLES;
    const models = q.models?.length ? q.models : DEFAULT_MODELS;

    const atmoVars = wanted.map((v) => ATMO_BY_VARIABLE[v]).filter((x): x is string => !!x);
    const marineVars = wanted.map((v) => MARINE_BY_VARIABLE[v]).filter((x): x is string => !!x);

    const days = Math.min(8, Math.max(1, Math.ceil(q.hours / 24)));

    // Atmosfäär ja meri on eri API-des — pärime paralleelselt ja liidame ajatelje järgi.
    const [atmo, marine] = await Promise.all([
      atmoVars.length ? this.#fetchSeries(FORECAST_URL, q, atmoVars, models, days, ATMO_VARS) : [],
      marineVars.length
        ? this.#fetchSeries(MARINE_URL, q, marineVars, ['best_match'], days, MARINE_VARS)
        : [],
    ]);

    return mergeByModel(atmo, marine, models);
  }

  /** Üks tund. Ehitatud sama ööpäevase ploki pealt mis `gridDay`. */
  async grid(q: GridQuery): Promise<GridFrame> {
    const frames = await this.gridDay(q);
    const wanted = new Date(q.time);
    wanted.setUTCMinutes(0, 0, 0);
    const target = wanted.getTime();

    let best: GridFrame | undefined;
    let bestDiff = Infinity;
    for (const f of frames) {
      const diff = Math.abs(new Date(f.time).getTime() - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = f;
      }
    }

    return (
      best ?? {
        providerId: this.caps.id,
        modelId: q.modelId,
        time: q.time,
        variables: q.variables,
        points: [],
      }
    );
  }

  /**
   * KÕIK ööpäeva tunnid ühe päringuga.
   *
   * Server tõmbas ööpäevase ploki juba varem, aga andis kliendile ühe tunni
   * korraga — iga ajaliuguri samm tähendas uut HTTP-ringi ja kaardikiht
   * uuenes nähtava viivitusega. Terve plokk korraga tähendab, et kerimine
   * käib mälust ja on hetkeline. Andmemaht on väike: 64 punkti x 24 tundi
   * x paar välja.
   */
  async gridDay(q: GridQuery): Promise<GridFrame[]> {
    const [south, west, north, east] = q.bbox;

    // Open-Meteo loeb mitmepunktilise päringu IGA PUNKTI eraldi kutseks.
    // 16x16 võrk oleks 256 kutset ühe kaardikaadri kohta ja tunnilimiit (5000)
    // saaks täis kümnekonna kaadriga — arenduses juhtus täpselt see.
    //
    // Kaks piirajat:
    //   GRID_MAX_STEPS hoiab ühe kaadri kulu <= 64 kutset
    //   MIN_CELL_DEG väldib mudeli lahutusest tihedama võrgu küsimist, mis
    //   tagastaks lihtsalt korduvaid lahtreid
    const GRID_MAX_STEPS = 8;
    const MIN_CELL_DEG = 0.05;
    const spanLat = north - south;
    const spanLon = east - west;
    const maxUseful = Math.ceil(Math.max(spanLat, spanLon) / MIN_CELL_DEG);
    const steps = Math.max(2, Math.min(GRID_MAX_STEPS, Math.min(q.steps, maxUseful)));

    // Ühtlane võrgustik. Läänemere laiuskraadidel on üks pikkuskraad ~2x kitsam
    // kui laiuskraad, seega korrigeerime, et nooled ei tuleks välja venitatud võrgus.
    const latSpan = north - south;
    const lonSpan = east - west;
    const cosLat = Math.cos(((north + south) / 2) * (Math.PI / 180));
    const aspect = (lonSpan * cosLat) / latSpan;

    const cols = aspect >= 1 ? steps : Math.max(2, Math.round(steps * aspect));
    const rows = aspect >= 1 ? Math.max(2, Math.round(steps / aspect)) : steps;

    const lats: number[] = [];
    const lons: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        lats.push(round(south + (latSpan * (r + 0.5)) / rows, 4)!);
        lons.push(round(west + (lonSpan * (c + 0.5)) / cols, 4)!);
      }
    }

    const isMarine = q.variables.every((v) => MARINE_BY_VARIABLE[v]);
    const url = isMarine ? MARINE_URL : FORECAST_URL;
    const varMap = isMarine ? MARINE_VARS : ATMO_VARS;
    const byVariable = isMarine ? MARINE_BY_VARIABLE : ATMO_BY_VARIABLE;

    const apiVars = q.variables.map((v) => byVariable[v]).filter((x): x is string => !!x);
    if (apiVars.length === 0) return [];

    // Ööpäevane plokk, mis sisaldab küsitud tundi. UTC-päeva piirile joondamine
    // hoiab vahemäluvõtme stabiilsena — muidu tekiks iga tunni kohta oma plokk.
    const { blockStart, blockEnd } = dayBlock(q.time);

    const params = new URLSearchParams({
      latitude: lats.join(','),
      longitude: lons.join(','),
      hourly: apiVars.join(','),
      wind_speed_unit: 'ms',
      timeformat: 'iso8601',
      timezone: 'GMT',
      // Küsime terve ÖÖPÄEVA korraga, mitte ühte tundi.
      //
      // Varem oli siin start_hour = end_hour = valitud tund. See tähendas, et
      // iga ajaliuguri samm tekitas uue 64-punktilise päringu ja uue
      // vahemäluvõtme — tunnieelarve sõi end läbi lihtsalt ajas edasi-tagasi
      // kerides. Ööpäevane plokk maksab sama arvu kutseid (kutseid loetakse
      // punktide, mitte tundide järgi), aga katab 24 tundi, nii et kerimine
      // on pärast esimest tõmmet tasuta ja hetkeline.
      start_hour: blockStart,
      end_hour: blockEnd,
      // Merevälju küsime merelahtritest; tuult ja õhku aga tavapärasest
      // lähimast lahtrist — "sea" jätaks rannikupunktid tühjaks ja kaardile
      // tekiksid augud sinna, kus kasutaja tegelikult sõidab.
      cell_selection: isMarine ? 'sea' : 'nearest',
    });
    if (q.modelId && q.modelId !== 'best_match') params.set('models', q.modelId);

    // Sama TTL mis punktiprognoosil: mõlemad tulevad samast mudelijooksust,
    // seega pole põhjust neid erineva värskusega hoida.
    const key = `om:grid:${params.toString()}`;
    const { value } = await cache.get(key, config.ttl.openMeteo, () =>
      // Iga võrgupunkt on Open-Meteo arvestuses eraldi kutse.
      fetchBudgeted<OmResponse | OmResponse[]>(`${url}?${params}`, lats.length),
    );

    // Mitme punkti korral tagastab Open-Meteo massiivi, ühe punkti korral objekti.
    const responses = Array.isArray(value) ? value : [value];

    // Ajaveerg on kõigil punktidel sama, seega piisab esimesest vastusest.
    const times = (Array.isArray(value) ? value[0] : value)?.hourly?.time as string[] | undefined;
    if (!times || times.length === 0) return [];

    const frames: GridFrame[] = times.map((rawTime) => ({
      providerId: this.caps.id,
      modelId: q.modelId,
      time: normalizeTime(rawTime),
      variables: q.variables,
      points: [] as GridPoint[],
    }));

    responses.forEach((res, i) => {
      const hourly = res.hourly;
      if (!hourly) return;

      // Kasutame KÜSITUD koordinaati, mitte vastuses tagastatud oma.
      // Open-Meteo tagastab mudeli lahtri keskme, mille tõttu mitu naaberpunkti
      // saavad identse koordinaadi — nooled kuhjuksid üksteise otsa ja
      // valevärvi-välja ruudustik laguneks.
      const lat = lats[i] ?? res.latitude;
      const lon = lons[i] ?? res.longitude;

      for (let h = 0; h < frames.length; h++) {
        const values: GridPoint['values'] = {};
        let any = false;
        for (const [apiName, mine] of Object.entries(varMap)) {
          const col = hourly[apiName] as (number | null)[] | undefined;
          if (!col || col.length === 0) continue;
          const v = round(col[h], 2);
          values[mine] = v;
          if (v !== null) any = true;
        }
        // Maismaapunktidel pole lainekõrgust — jätame need kaardilt hoopis
        // välja, muidu joonistaks valevärvi-kiht üle Eesti nulli.
        if (!any) continue;
        frames[h]!.points.push({ lat, lon, values });
      }
    });

    return frames;
  }

  async #fetchSeries(
    url: string,
    q: PointQuery,
    apiVars: string[],
    models: string[],
    days: number,
    varMap: Record<string, Variable>,
  ): Promise<TimeSeries[]> {
    const params = new URLSearchParams({
      latitude: String(q.lat),
      longitude: String(q.lon),
      hourly: apiVars.join(','),
      wind_speed_unit: 'ms',
      timeformat: 'iso8601',
      timezone: 'GMT',
      forecast_days: String(days),
      // Näitame ka mõne tunni tagasi, et graafikul oleks kontekst.
      past_days: '1',
      cell_selection: url === MARINE_URL ? 'sea' : 'land',
    });

    const realModels = models.filter((m) => m !== 'best_match');
    if (realModels.length) params.set('models', realModels.join(','));

    const key = `om:point:${url}:${params.toString()}`;
    const { value } = await cache.get(key, config.ttl.openMeteo, () =>
      fetchBudgeted<OmResponse | OmResponse[]>(`${url}?${params}`, 1),
    );

    const res = Array.isArray(value) ? value[0] : value;
    if (!res?.hourly) return [];

    const times = res.hourly.time as string[] | undefined;
    if (!times) return [];

    // Kui küsisime mitut mudelit, on iga muutuja järelliitega "_<mudel>".
    const modelIds = realModels.length ? realModels : ['best_match'];

    return modelIds.map((modelId) => {
      const suffix = realModels.length > 1 ? `_${modelId}` : '';
      const steps: TimeStep[] = times.map((time, i) => {
        const values: TimeStep['values'] = {};
        for (const [apiName, mine] of Object.entries(varMap)) {
          const col = res.hourly![apiName + suffix] as (number | null)[] | undefined;
          if (!col) continue;
          values[mine] = round(col[i], 2);
        }
        return { time: normalizeTime(time), values };
      });

      return {
        providerId: this.caps.id,
        modelId,
        lat: res.latitude,
        lon: res.longitude,
        steps,
      };
    });
  }
}

/**
 * Liidab atmosfääri- ja mereseeriad üheks ajareaks mudeli kaupa.
 * Merevälju on ainult üks komplekt (lainemudelid on atmosfäärimudelitest eraldi),
 * seega kanname sama merearvutuse kõigile mudelireadadele.
 */
function mergeByModel(atmo: TimeSeries[], marine: TimeSeries[], models: string[]): TimeSeries[] {
  if (atmo.length === 0) return marine;
  if (marine.length === 0) return atmo;

  const marineByTime = new Map<string, TimeStep['values']>();
  for (const step of marine[0]!.steps) marineByTime.set(step.time, step.values);

  return atmo.map((series) => ({
    ...series,
    steps: series.steps.map((step) => {
      const sea = marineByTime.get(step.time);
      return sea ? { time: step.time, values: { ...step.values, ...sea } } : step;
    }),
  }));
}

/** Open-Meteo annab "2026-07-27T16:00" ilma tsoonita; meie leping on ISO UTC. */
function normalizeTime(t: string): string {
  return t.endsWith('Z') ? t : `${t}:00Z`.replace(/:00:00Z$/, ':00Z');
}

/** ISO aeg -> "YYYY-MM-DDTHH:00", mida Open-Meteo start_hour/end_hour ootab. */
function hourFloor(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13) + ':00';
}

/**
 * UTC-päeva plokk, mis sisaldab antud hetke.
 *
 * Joondamine päeva piirile on vahemälu jaoks oluline: kui plokk algaks
 * "praegusest tunnist", nihkuks võti iga tunniga ja kogu säästu poleks.
 */
function dayBlock(iso: string): { blockStart: string; blockEnd: string } {
  const d = new Date(iso);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  const end = new Date(start.getTime() + 23 * 3600_000);
  return {
    blockStart: `${start.toISOString().slice(0, 13)}:00`,
    blockEnd: `${end.toISOString().slice(0, 13)}:00`,
  };
}

/** Küsitud tunni indeks vastuse ajaveerus. -1, kui plokk seda ei kata. */
function findHourIndex(times: string[] | undefined, iso: string): number {
  if (!times || times.length === 0) return -1;
  const target = new Date(iso);
  target.setUTCMinutes(0, 0, 0);
  const wanted = target.getTime();

  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const stamp = new Date(t.endsWith('Z') ? t : `${t}:00Z`.replace(/:00:00Z$/, ':00Z')).getTime();
    if (stamp === wanted) return i;
  }
  return -1;
}

export const openMeteo = new OpenMeteoProvider();
export { WAVE_MODELS };
