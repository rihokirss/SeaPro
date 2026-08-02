import type {
  GridFrame,
  GridDayResult,
  GridPoint,
  ProviderCapabilities,
  TimeSeries,
  TimeStep,
  Variable,
} from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { HttpError, fetchJson } from '../http.js';
import { RateLimitError, rateLimiter } from '../rateLimit.js';
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

/**
 * Mere-API muutujad, mida LAINEmudelid oskavad.
 *
 * Eraldi loend, sest EWAM ja GWAM on puhtad lainemudelid: mõõdetuna annavad
 * nad `sea_surface_temperature`, `sea_level_height_msl` ja hoovused nullina.
 * Kui lainemudel läheks kaasa ka nendele väljadele, kaoks meretemperatuuri- või
 * hoovusekiht ekraanilt kohe, kui kasutaja lainemudeli valib.
 */
const WAVE_VARS: Record<string, Variable> = {
  wave_height: 'wave_height',
  wave_direction: 'wave_dir',
  wave_period: 'wave_period',
  swell_wave_height: 'swell_height',
  swell_wave_direction: 'swell_dir',
  swell_wave_period: 'swell_period',
};

/** Mere-API ülejäänud väljad — need tulevad alati `best_match`-ist. */
const OCEAN_VARS: Record<string, Variable> = {
  sea_surface_temperature: 'sea_temp',
  sea_level_height_msl: 'sea_level',
  ocean_current_velocity: 'current_speed',
  ocean_current_direction: 'current_dir',
};

const MARINE_VARS: Record<string, Variable> = { ...WAVE_VARS, ...OCEAN_VARS };

const WAVE_VARIABLE_SET = new Set<Variable>(Object.values(WAVE_VARS));

const ATMO_BY_VARIABLE = invert(ATMO_VARS);
const MARINE_BY_VARIABLE = invert(MARINE_VARS);
const OCEAN_BY_VARIABLE = invert(OCEAN_VARS);

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
  { id: 'ewam', label: 'DWD EWAM', note: '5 km, Euroopa rannikumered — parim Läänemerel' },
  { id: 'best_match', label: 'Automaatne', note: 'Open-Meteo valik (Läänemerel MFWAM, ~8 km)' },
  { id: 'gwam', label: 'DWD GWAM', note: '25 km, globaalne' },
] as const;

/**
 * Vaikimisi lainemudel.
 *
 * EWAM, mitte `best_match`: mõõdetuna valib Open-Meteo Läänemerel MFWAM-i
 * (~8 km globaalne mudel), kuigi EWAM on samas kohas 5 km ja tehtud just
 * Euroopa rannikumerede jaoks. Lühikese ja liigendatud rannikuga Läänemerel
 * on see vahe sisuline.
 */
const DEFAULT_WAVE_MODEL = 'ewam';

interface OmResponse {
  latitude: number;
  longitude: number;
  hourly?: Record<string, (number | null)[] | string[]>;
  hourly_units?: Record<string, string>;
}

/**
 * Open-Meteo kutsekaal — nende ENDA valem, mitte meie oletus.
 *
 * Allikas: open-meteo/open-meteo, `ForecastApiResult.calculateQueryWeight()`:
 *
 *   kaal = summa üle asukohtade: max(1, (muutujad × mudelid / 10) × max(1, päevad / 14))
 *
 * Kolm järeldust, millest kogu selle faili eelarveloogika sõltub:
 *
 *  1. IGA asukoht maksab vähemalt 1 — mitmepunktiline päring ei ole soodsam
 *     kui sama arv üksikpäringuid.
 *  2. Kuni 10 muutujat JA kuni 14 päeva maksavad TÄPSELT sama palju kui üks
 *     muutuja ja üks tund. Vähem küsida ei anna säästu — see ainult tähendab,
 *     et sama raha eest saab vähem andmeid vahemällu.
 *  3. Mudelid korrutavad muutujate arvu. Viis mudelit × 9 muutujat = 45/10
 *     ehk 4,5 kutset asukoha kohta.
 *
 * Punkt 2 on põhjus, miks me pärime tervet plokki päevi ja kogu muutujate
 * komplekti korraga: sama kutse eest saab kordades rohkem vahemälu.
 */
export function queryWeight(opts: {
  locations: number;
  variables: number;
  models?: number;
  days: number;
}): number {
  const variablesFraction = (opts.variables * (opts.models ?? 1)) / 10;
  const timeFraction = opts.days / 14;
  const perLocation = Math.max(1, variablesFraction * Math.max(1, timeFraction));
  return Math.ceil(opts.locations * perLocation);
}

function secondsToNextHour(): number {
  return Math.ceil((3600_000 - (Date.now() % 3600_000)) / 1000);
}

function secondsToUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return Math.ceil((midnight - now.getTime()) / 1000);
}

/**
 * Kutsub Open-Meteot, hoides päringueelarvet ausana.
 *
 * Neli asja, mis siin koos peavad olema:
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
/**
 * Kumb eelarve. Prognoosi- ja mere-API on eri hostid ja neil on ERALDI kvoot —
 * mõõdetult: forecast vastas 429-ga ("Daily API request limit exceeded") samal
 * ajal, kui marine andis 200. Ühine eelarve tähendaks, et tuulekihi limiit
 * lülitaks välja ka lainekihi, ilma et selleks põhjust oleks.
 */
function budgetFor(url: string): string {
  return url.startsWith(MARINE_URL) ? 'open-meteo-marine' : 'open-meteo';
}

async function fetchBudgeted<T>(url: string, cost: number): Promise<T> {
  const source = budgetFor(url);
  rateLimiter.spend(source, cost);
  try {
    const result = await fetchJson<T>(url);
    // Õnnestunud vastus tähendab, et allikas on taas saadaval — kui me olime
    // jahtumises, pole selle hoidmine enam põhjendatud.
    rateLimiter.recovered(source);
    return result;
  } catch (err) {
    rateLimiter.refund(source, cost);
    if (err instanceof HttpError && err.status === 429) {
      // Open-Meteol on KAKS limiiti ja need lähtestuvad eri ajal. Vastuse keha
      // ütleb, kumma vastu jooksti:
      //   "Hourly API request limit exceeded"  -> järgmine täistund
      //   "Daily API request limit exceeded"   -> järgmine UTC-kesköö
      //
      // Enne eeldas kood alati tunnilimiiti. Päevalimiidi puhul tähendas see,
      // et proovipäring läks iga minut uuesti välja ja sai iga kord 429 —
      // terve päeva jooksul sadu asjatuid päringuid allikale, mis oli meid
      // just üle koormamise eest hoiatanud.
      const daily = /daily/i.test(err.body ?? '');
      const retryAfterSeconds = daily ? secondsToUtcMidnight() : secondsToNextHour();
      rateLimiter.cooldown(source, retryAfterSeconds);
      // Esimene 429 peab kliendile andma sama täpse akna nagu kõik cooldown'i
      // ajal järgnevad päringud. Toore HttpErrori puhul eeldas marsruut alati
      // tunnilimiiti ja näitas päevase limiidi korral eksitavalt liiga lühikest
      // ooteaega.
      throw new RateLimitError(source, retryAfterSeconds, daily ? 'day' : 'hour');
    }
    throw err;
  }
}

/** Kas vastuses on kas või üks päris arv? */
function hasAnyValue(value: OmResponse | OmResponse[], apiVars: string[]): boolean {
  for (const res of Array.isArray(value) ? value : [value]) {
    const hourly = res.hourly;
    if (!hourly) continue;
    for (const name of apiVars) {
      const col = hourly[name] as (number | null)[] | undefined;
      if (col?.some((v) => v !== null && v !== undefined)) return true;
    }
  }
  return false;
}

/**
 * Merepäring koos varuvariandiga, kui lainemudel seda kohta ei kata.
 *
 * Miks seda vaja on: EWAM-i domeen on ebakorrapärane. Mõõdetuna katab see
 * Läänemere, Põhjamere, Vahemere ja Musta mere, aga MITTE avaookeani.
 *
 * Domeenist väljas käitub API KAHTMOODI ja mõlemad tuleb katta:
 *
 *   üksikpunkt      -> 200 OK, iga väärtus null (`hourly_units` on "undefined")
 *   mitu punkti     -> 400 {"reason":"No data is available for this location"}
 *
 * Esimene on salakavalam: vastus näeb terve välja ja meie nullipunktide filter
 * (õigustatult olemas, muidu joonistaks valevärvi-kiht üle maismaa nulllaine)
 * teeks kihi vaikselt tühjaks. Teine katkestaks paani ja jätaks samuti augu.
 *
 * Domeeni kasti me sisse ei kirjuta: see on ebakorrapärane ja proovipunktidest
 * tuletatud piir oleks arvamus, mis vananeb esimese mudelivahetusega. Selle
 * asemel küsime järele — kui valitud mudel ei anna ÜHTKI arvu või ütleb "pole
 * andmeid", kordame `best_match`-iga, mis on globaalne.
 *
 * Hind: katmata alal kaks kutset ühe asemel. Kutsuja paneb tulemuse vahemällu
 * VALITUD mudeli võtme alla, seega teine kutse tehakse tunnis üks kord paani
 * kohta, mitte iga päringu peale.
 */
async function fetchMarineWithFallback(
  url: string,
  params: URLSearchParams,
  apiVars: string[],
  cost: number,
): Promise<OmResponse | OmResponse[]> {
  const retryWithBestMatch = (): Promise<OmResponse | OmResponse[]> => {
    const fallback = new URLSearchParams(params);
    fallback.delete('models');
    return fetchBudgeted<OmResponse | OmResponse[]>(`${url}?${fallback}`, cost);
  };

  if (!params.has('models')) {
    return fetchBudgeted<OmResponse | OmResponse[]>(`${url}?${params}`, cost);
  }

  let first: OmResponse | OmResponse[];
  try {
    first = await fetchBudgeted<OmResponse | OmResponse[]>(`${url}?${params}`, cost);
  } catch (err) {
    // AINULT 400. 429 tähendab "liiga palju päringuid" — kordamine oleks siis
    // täpselt vale ravim ja sööks eelarvet, mis on juba otsas. Kõik muu
    // (võrk, 5xx) on ajutine ja peab kutsujani jõudma, mitte vaikselt teise
    // mudeli vastu vahetuma.
    if (!(err instanceof HttpError) || err.status !== 400) throw err;
    return retryWithBestMatch();
  }

  return hasAnyValue(first, apiVars) ? first : retryWithBestMatch();
}

/**
 * Miks fikseeritud võre, mitte vaatest arvutatud võrgustik.
 *
 * Open-Meteo loeb mitmepunktilise päringu IGA PUNKTI eraldi kutseks. Meie
 * saadame terve välja ühe HTTP-päringuga, aga kutseid kulub ikka punktide arvu
 * jagu — 64 punkti = 64 kutset. Tunnilimiit sai seetõttu kiiresti täis.
 *
 * Tegelik raiskamine ei olnud aga päringu suurus, vaid see, et punktid
 * arvutati NÄHTAVAST alast: iga nihe andis 64 uut koordinaati, mis olid
 * eelmistest paarsada meetrit eemal, aga vahemälu jaoks täiesti uued. Sisuliselt
 * sama ala maksti kinni ikka ja jälle.
 *
 * Nüüd on punktid absoluutsel võrel (kordsed `spacing`-ust, alguspunkt 0°) ja
 * kimpudes ehk paanides. Sama paan tähendab sama vahemäluvõtit sõltumata
 * sellest, kust kasutaja vaatab. Nihutamine maksab ainult uue serva paanid,
 * tagasi nihutamine ei maksa midagi.
 *
 * Pikkuskraadi samm on kahekordne, sest Läänemere laiuskraadidel on
 * pikkuskraad ~2x kitsam — nii tulevad lahtrid kilomeetrites ligikaudu ruudud.
 */
export const TILE_N = 4;
const MAX_TILES = 4;

/**
 * Mitu ööpäeva korraga ühte paani tõmmatakse.
 *
 * Kaal ei sõltu ajavahemikust kuni 14 päevani (vt `queryWeight`), seega maksab
 * nädal TÄPSELT sama palju kui üks päev. Varem tõmbasime ühe ööpäeva korraga
 * ja klient laadis eelhaardega kolm päeva — see oli kolmekordne hind sama
 * kutsekaalu eest, mille oleks saanud ühe päringuga.
 *
 * Miks mitte 14: kaal on sama, aga vastuse maht kasvab lineaarselt. Seitse
 * päeva mahub kettavahemälu kirjepiiri (512 kB) sisse ja katab prognoosi
 * kasuliku osa; üle selle on väärtus niikuinii nõrk.
 */
const BLOCK_DAYS = 7;

/**
 * Punktiprognoosi aken päevades (+ 1 päev minevikku).
 *
 * Fikseeritud teadlikult: kaal on kuni 14 päevani ühesugune, seega lühem aken
 * ei säästa midagi, aga muutuv aken lõhub vahemäluvõtme. Kutsujale lõikame
 * vastuse tema küsitud tundide pikkuseks.
 */
const POINT_FORECAST_DAYS = 10;
const GRID_TARGET_POINTS = 8;
const LAT_SPACINGS = [0.05, 0.1, 0.25, 0.5, 1, 2];
const LON_FACTOR = 2;

interface TileIndex {
  ti: number;
  tj: number;
}

/** Kõik paanid, mis vaadet katavad. Indeksid on absoluutsed, mitte vaatepõhised. */
export function coveringTiles(
  [south, west, north, east]: [number, number, number, number],
  spacing: number,
): TileIndex[] {
  const tileLat = TILE_N * spacing;
  const tileLon = TILE_N * spacing * LON_FACTOR;
  const out: TileIndex[] = [];
  for (let ti = Math.floor(south / tileLat); ti <= Math.floor(north / tileLat); ti++) {
    for (let tj = Math.floor(west / tileLon); tj <= Math.floor(east / tileLon); tj++) {
      out.push({ ti, tj });
    }
  }
  return out;
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
    waveModels: [...WAVE_MODELS],
    supportsGrid: true,
    supportsStations: false,
    forecastHours: 10 * 24,
    attribution: 'Open-Meteo.com (CC BY 4.0)',
    attributionUrl: 'https://open-meteo.com/',
    enabled: true,
  };

  async point(q: PointQuery): Promise<TimeSeries[]> {
    const wanted = q.variables?.length ? q.variables : ALL_VARIABLES;
    const models = q.models?.length ? q.models : DEFAULT_MODELS;
    const realModels = models.filter((m) => m !== 'best_match');

    const wantsAtmo = wanted.some((v) => ATMO_BY_VARIABLE[v]);
    // Meri jaguneb kaheks, sest lainemudel kehtib ainult lainetele: EWAM ja
    // GWAM annavad meretemperatuuri, veetaseme ja hoovused nullina. Üks päring
    // kogu merekomplekti peale tähendaks, et lainemudeli valik kustutaks
    // graafikult meretemperatuuri.
    const wantsWaves = wanted.some((v) => WAVE_VARIABLE_SET.has(v));
    const wantsOcean = wanted.some((v) => OCEAN_BY_VARIABLE[v]);
    const waveModel = q.waveModel ?? DEFAULT_WAVE_MODEL;

    // Küsime KÕIK selle API muutujad, mitte ainult praegu vajalikud.
    //
    // Põhjus on kaal, mitte laiskus: 9 (atmosfäär) või 10 (meri) muutujat
    // maksavad täpselt sama palju kui üks. Varem läks vahemäluvõtmesse küsitud
    // muutujate loend, mistõttu iga uus graafikuvalik tegi uue päringu sama
    // punkti kohta — sama hinnaga, mille eest oleks saanud kogu komplekti.
    //
    // Erand on sama mis võrgustikul: konkreetse mudeli puhul jääme küsitud
    // muutujate juurde. Siin on lisapõhjus, et mudelid KORRUTAVAD muutujate
    // arvu — 9 muutujat × 5 mudelit oleks 4,5 kutset ühe asemel.
    const useAllVars = realModels.length === 0;
    const atmoVars = useAllVars
      ? Object.keys(ATMO_VARS)
      : wanted.map((v) => ATMO_BY_VARIABLE[v]).filter((x): x is string => !!x);
    // Mere pooled saavad KUMBKI oma täiskomplekti. Kaal on kummalgi 1
    // (6 ja 4 muutujat, mõlemad alla kümne), seega kaks kutset ühe asemel
    // maksavad kokku 2 — merepäringute kogukulu on niikuinii ühekohaline arv,
    // ja vastu saame lainemudeli valiku, mis ei kustuta meretemperatuuri.
    const waveVars = Object.keys(WAVE_VARS);
    const oceanVars = Object.keys(OCEAN_VARS);

    // Atmosfäär ja meri on eri API-des — pärime paralleelselt ja liidame ajatelje järgi.
    const [atmo, waves, ocean] = await Promise.all([
      wantsAtmo ? this.#fetchSeries(FORECAST_URL, q, atmoVars, models, ATMO_VARS) : [],
      wantsWaves ? this.#fetchSeries(MARINE_URL, q, waveVars, [waveModel], WAVE_VARS) : [],
      wantsOcean ? this.#fetchSeries(MARINE_URL, q, oceanVars, ['best_match'], OCEAN_VARS) : [],
    ]);

    return mergeByModel(atmo, mergeSteps(waves, ocean), models);
  }

  /** Üks tund. Ehitatud sama ööpäevase ploki pealt mis `gridDay`. */
  async grid(q: GridQuery): Promise<GridFrame> {
    const { frames } = await this.gridDay(q);
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
  async gridDay(q: GridQuery): Promise<GridDayResult> {
    const [south, west, north, east] = q.bbox;

    const isMarine = q.variables.every((v) => MARINE_BY_VARIABLE[v]);
    const url = isMarine ? MARINE_URL : FORECAST_URL;
    const varMap = isMarine ? MARINE_VARS : ATMO_VARS;
    const byVariable = isMarine ? MARINE_BY_VARIABLE : ATMO_BY_VARIABLE;

    // Meri saab lainemudeli, atmosfäär atmosfäärimudeli. Neid ei tohi segada:
    // `models=icon_eu` mere-API-le annab 200 täis nulle ehk tühja kihi.
    //
    // Ja lainemudel kehtib ainult LAINEväljadele — meretemperatuur, veetase ja
    // hoovused tulevad EWAM/GWAM-iga samuti nullina, seega neile jääb
    // `best_match`.
    const wavesOnly = isMarine && q.variables.every((v) => WAVE_VARIABLE_SET.has(v));
    const modelId = isMarine
      ? wavesOnly
        ? q.waveModelId ?? DEFAULT_WAVE_MODEL
        : undefined
      : q.modelId;

    const wantedApiVars = q.variables.map((v) => byVariable[v]).filter((x): x is string => !!x);
    if (wantedApiVars.length === 0) return { frames: [] };

    // KÕIK selle API muutujad, mitte ainult küsitud — atmosfääris 9, meres 10,
    // mõlemad mahuvad kaaluvabasse kümnesse. Kihi vahetamine (tuul -> temperatuur
    // -> rõhk) tuleb nüüd vahemälust, mitte uue 64-kutselise päringuna.
    //
    // Erand: kui kasutaja on valinud KONKREETSE mudeli, jääme küsitud muutujate
    // juurde. Kõik mudelid ei paku kõiki välju (nt nähtavust) ja puuduv muutuja
    // annab 400 — terve kaardikiht kaoks selle asemel, et üks väli puududa.
    //
    // Merel on "kõik" tingimuslik: lainemudeliga küsime ainult lainevälju,
    // sest ülejäänud neli tuleksid nullina ja ainult raiskaksid vastuse mahtu.
    const useAllVars = !modelId || modelId === 'best_match';
    const apiVars = useAllVars
      ? Object.keys(varMap)
      : isMarine
        ? Object.keys(WAVE_VARS)
        : wantedApiVars;

    // Mitmepäevane plokk, mis sisaldab küsitud tundi. Joondus on UTC-päeva
    // piiril ja ploki algus on TÄNANE kesköö — nii langevad "täna", "homme" ja
    // "ülehomme" ühe ja sama vahemäluvõtme sisse.
    const { blockStart, blockEnd } = timeBlock(q.time);

    // Vali võresamm nii, et vaatesse jääks ~GRID_TARGET_POINTS punkti servas,
    // ja kui paane tuleb siiski liiga palju, jämeneda kuni mahub.
    const cosLat = Math.cos(((north + south) / 2) * (Math.PI / 180)) || 1;
    const maxSpanDeg = Math.max(north - south, (east - west) * cosLat);
    let spacing =
      LAT_SPACINGS.find((s) => maxSpanDeg / s <= GRID_TARGET_POINTS) ??
      LAT_SPACINGS[LAT_SPACINGS.length - 1]!;
    let tiles = coveringTiles(q.bbox, spacing);
    while (tiles.length > MAX_TILES) {
      const next = LAT_SPACINGS[LAT_SPACINGS.indexOf(spacing) + 1];
      if (next === undefined) break;
      spacing = next;
      tiles = coveringTiles(q.bbox, spacing);
    }

    // Paanid tõmmatakse eraldi, sest just see teebki nihutamise odavaks:
    // ühine osa tuleb vahemälust ja maksma läheb ainult uus serv.
    const failures: unknown[] = [];
    const fetched = await Promise.all(
      tiles.map((tile) =>
        this.#fetchGridTile({
          url,
          apiVars,
          isMarine,
          modelId,
          spacing,
          tile,
          blockStart,
          blockEnd,
        }).catch((err) => {
          // Üks ebaõnnestunud paan ei tohi tervet välja tühjaks teha —
          // parem osaline kaart kui tühi.
          // RateLimitError tekib enne HTTP-kutset, kui Open-Meteo on cooldown'is.
          // See peab käituma siin samamoodi nagu allika enda HTTP-viga: alles
          // olevad stale-paanid kuvatakse ja ainult puuduv paan jäetakse vahele.
          if (!(err instanceof HttpError) && !(err instanceof RateLimitError)) throw err;
          failures.push(err);
          return null;
        }),
      ),
    );

    const lats: number[] = [];
    const lons: number[] = [];
    const responses: OmResponse[] = [];
    for (const part of fetched) {
      if (!part) continue;
      if (part.fallbackError) failures.push(part.fallbackError);
      lats.push(...part.lats);
      lons.push(...part.lons);
      responses.push(...(Array.isArray(part.value) ? part.value : [part.value]));
    }
    // Kui mitte ühtegi paani pole alles, peab viga jõudma marsruudini: UI näitab
    // siis limiiditeadet ega tõlgenda tühja 200-vastust edukaks laadimiseks.
    if (responses.length === 0) {
      if (failures.length > 0) throw failures[0];
      return { frames: [] };
    }

    // Ajaveerg on kõigil punktidel sama, seega piisab esimesest vastusest.
    const times = responses[0]?.hourly?.time as string[] | undefined;
    if (!times || times.length === 0) return { frames: [] };

    // Plokk katab mitu ööpäeva, klient küsib ühe. Väljastame ainult küsitud
    // päeva: ülejäänu ootab vahemälus ja on järgmise päeva jaoks tasuta.
    const dayPrefix = new Date(q.time).toISOString().slice(0, 10);
    const hourIndexes: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (normalizeTime(times[i]!).slice(0, 10) === dayPrefix) hourIndexes.push(i);
    }
    if (hourIndexes.length === 0) return { frames: [] };

    // Väljastame ainult KÜSITUD muutujad, kuigi vahemällu tõmbasime kõik.
    // Muidu kasvaks kliendi vastus 9 muutuja jagu, ilma et keegi neid vajaks.
    const outVars = Object.entries(varMap).filter(([, mine]) => q.variables.includes(mine));

    const frames: GridFrame[] = hourIndexes.map((i) => ({
      providerId: this.caps.id,
      // TEGELIK mudel, mitte küsitud: merel on see lainemudel, mitte `q.modelId`.
      // Kaadri silt peab ütlema, mida kasutaja päriselt vaatab.
      modelId,
      time: normalizeTime(times[i]!),
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
        const t = hourIndexes[h]!;
        const values: GridPoint['values'] = {};
        let any = false;
        for (const [apiName, mine] of outVars) {
          const col = hourly[apiName] as (number | null)[] | undefined;
          if (!col || col.length === 0) continue;
          const v = round(col[t], 2);
          values[mine] = v;
          if (v !== null) any = true;
        }
        // Maismaapunktidel pole lainekõrgust — jätame need kaardilt hoopis
        // välja, muidu joonistaks valevärvi-kiht üle Eesti nulli.
        if (!any) continue;
        frames[h]!.points.push({ lat, lon, values });
      }
    });

    let warning: GridDayResult['warning'];
    if (failures.length > 0) {
      const limited = failures.find(
        (err) => err instanceof RateLimitError || (err instanceof HttpError && err.status === 429),
      );
      if (limited instanceof RateLimitError) {
        warning = { kind: 'rate_limited', retryAfterSeconds: limited.retryAfterSeconds };
      } else if (limited instanceof HttpError) {
        warning = {
          kind: 'rate_limited',
          retryAfterSeconds: /daily/i.test(limited.body ?? '')
            ? secondsToUtcMidnight()
            : secondsToNextHour(),
        };
      } else {
        warning = { kind: 'error' };
      }
    }

    return { frames, ...(warning ? { warning } : {}) };
  }

  /**
   * Üks paan: TILE_N x TILE_N võrepunkti, üks HTTP-päring, üks vahemäluvõti.
   *
   * Võti sõltub AINULT paani indeksist, sammust, muutujatest, mudelist ja
   * ööpäevaplokist — mitte kaadri asendist. Just see teeb nihutamise odavaks.
   */
  async #fetchGridTile(opts: {
    url: string;
    apiVars: string[];
    isMarine: boolean;
    modelId?: string;
    spacing: number;
    tile: TileIndex;
    blockStart: string;
    blockEnd: string;
  }): Promise<{
    lats: number[];
    lons: number[];
    value: OmResponse | OmResponse[];
    fallbackError?: unknown;
  }> {
    const { url, apiVars, isMarine, modelId, spacing, tile, blockStart, blockEnd } = opts;
    const lats: number[] = [];
    const lons: number[] = [];
    for (let r = 0; r < TILE_N; r++) {
      for (let c = 0; c < TILE_N; c++) {
        lats.push(round((tile.ti * TILE_N + r) * spacing, 4)!);
        lons.push(round((tile.tj * TILE_N + c) * spacing * LON_FACTOR, 4)!);
      }
    }

    const params = new URLSearchParams({
      latitude: lats.join(','),
      longitude: lons.join(','),
      hourly: apiVars.join(','),
      wind_speed_unit: 'ms',
      timeformat: 'iso8601',
      timezone: 'GMT',
      // Terve NÄDAL korraga. Kaal ei sõltu ajavahemikust kuni 14 päevani, seega
      // maksab 168 tundi sama palju kui üks — ja nii ajaliuguri kerimine kui ka
      // järgmiste päevade eelhaare on pärast esimest tõmmet tasuta.
      start_hour: blockStart,
      end_hour: blockEnd,
      // Merevälju küsime merelahtritest; tuult ja õhku aga lähimast lahtrist —
      // "sea" jätaks rannikupunktid tühjaks ja kaardile tekiksid augud sinna,
      // kus kasutaja tegelikult sõidab.
      cell_selection: isMarine ? 'sea' : 'nearest',
    });
    if (modelId && modelId !== 'best_match') params.set('models', modelId);

    const key = `om:tile:${params.toString()}`;
    const cost = queryWeight({
      locations: lats.length,
      variables: apiVars.length,
      days: BLOCK_DAYS,
    });
    const cached = await cache.get(key, config.ttl.openMeteo, () =>
      isMarine
        ? fetchMarineWithFallback(url, params, apiVars, cost)
        : fetchBudgeted<OmResponse | OmResponse[]>(`${url}?${params}`, cost),
    );
    return {
      lats,
      lons,
      value: cached.value,
      ...(cached.fallbackError ? { fallbackError: cached.fallbackError } : {}),
    };
  }

  async #fetchSeries(
    url: string,
    q: PointQuery,
    apiVars: string[],
    models: string[],
    varMap: Record<string, Variable>,
  ): Promise<TimeSeries[]> {
    const params = new URLSearchParams({
      latitude: String(q.lat),
      longitude: String(q.lon),
      hourly: apiVars.join(','),
      wind_speed_unit: 'ms',
      timeformat: 'iso8601',
      timezone: 'GMT',
      // Alati sama pikk aken, sõltumata sellest, mitu tundi kutsuja parasjagu
      // küsis. Lühem aken ei ole odavam (kaal on kuni 14 päevani sama), aga
      // erinev `forecast_days` tegi igast graafikuvaatest oma vahemäluvõtme.
      // 10 + 1 päeva = 11, mis mahub kaaluvabasse kaheteistkümnesse.
      forecast_days: String(POINT_FORECAST_DAYS),
      // Näitame ka eelmise ööpäeva, et graafikul oleks kontekst.
      past_days: '1',
      cell_selection: url === MARINE_URL ? 'sea' : 'land',
    });

    const realModels = models.filter((m) => m !== 'best_match');
    if (realModels.length) params.set('models', realModels.join(','));

    const key = `om:point:${url}:${params.toString()}`;
    const cost = queryWeight({
      locations: 1,
      variables: apiVars.length,
      models: Math.max(1, realModels.length),
      days: POINT_FORECAST_DAYS + 1,
    });
    const { value } = await cache.get(key, config.ttl.openMeteo, () =>
      url === MARINE_URL
        ? fetchMarineWithFallback(url, params, apiVars, cost)
        : fetchBudgeted<OmResponse | OmResponse[]>(`${url}?${params}`, cost),
    );

    const res = Array.isArray(value) ? value[0] : value;
    if (!res?.hourly) return [];

    const times = res.hourly.time as string[] | undefined;
    if (!times) return [];

    // Kui küsisime mitut mudelit, on iga muutuja järelliitega "_<mudel>".
    const modelIds = realModels.length ? realModels : ['best_match'];

    // Vahemälus on alati 11 päeva, kutsuja tahab `q.hours`. Lõikame siin, et
    // kliendile ei läheks andmeid, mida ta ei küsinud — päring ise oli
    // niikuinii sama hinnaga.
    const cutoff = Date.now() + q.hours * 3600_000;

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
      }).filter((step) => new Date(step.time).getTime() <= cutoff);

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
/**
 * Liidab kaks ajarida ühte, ajatempli järgi.
 *
 * Vaja on seda, sest meri tuleb nüüd KAHE päringuna: laineväljad valitud
 * lainemudelist, meretemperatuur/veetase/hoovused `best_match`-ist. Graafiku
 * jaoks peavad need olema üks seeria, muidu näeks kasutaja sama punkti kohta
 * kahte rida.
 */
function mergeSteps(primary: TimeSeries[], secondary: TimeSeries[]): TimeSeries[] {
  if (primary.length === 0) return secondary;
  if (secondary.length === 0) return primary;

  const byTime = new Map<string, TimeStep['values']>();
  for (const step of secondary[0]!.steps) byTime.set(step.time, step.values);

  return primary.map((series) => ({
    ...series,
    steps: series.steps.map((step) => {
      const extra = byTime.get(step.time);
      return extra ? { time: step.time, values: { ...step.values, ...extra } } : step;
    }),
  }));
}

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
 * `BLOCK_DAYS` päeva pikkune plokk, mis sisaldab antud hetke.
 *
 * Ankur on TÄNANE UTC-kesköö, mitte küsitud päeva oma. Vahe on kogu säästu
 * mõte: kui iga küsitud päev alustaks oma plokki, oleks kolme päeva eelhaardel
 * kolm eri vahemäluvõtit ja kolm eri päringut. Ühine ankur tähendab, et kõik
 * ploki sisse jäävad päevad tulevad ÜHEST päringust.
 *
 * Ploki taha või ette jäävad ajad (minevik, kaugem tulevik) saavad varuvariandina
 * oma päevaga algava ploki — haruldane, aga ei tohi tühja anda.
 */
function timeBlock(iso: string): { blockStart: string; blockEnd: string } {
  const now = new Date();
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const blockMs = BLOCK_DAYS * 24 * 3600_000;

  const wanted = new Date(iso);
  const wantedDay = Date.UTC(wanted.getUTCFullYear(), wanted.getUTCMonth(), wanted.getUTCDate());

  const start = new Date(
    wantedDay >= anchor && wantedDay < anchor + blockMs ? anchor : wantedDay,
  );
  const end = new Date(start.getTime() + blockMs - 3600_000);
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
