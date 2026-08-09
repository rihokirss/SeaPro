import type { FastifyInstance } from 'fastify';
import type {
  BBox,
  PointResult,
  ProviderError,
  StationReading,
  SearchResult,
  TimeSeries,
  Variable,
  RouteAnalysisRequest,
  RoutePlanRequest,
} from '@seapro/shared';
import { VARIABLES, distanceMetres } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { RateLimitError, rateLimiter } from '../rateLimit.js';
import { usageMeter } from '../usage.js';
import { vessels } from '../ais/registry.js';
import { fetchHarbours } from '../harbours/overpass.js';
import { aisstream } from '../ais/aisstream.js';
import { searchPlaces } from '../search/photon.js';
import { fetchRadarTimeline } from '../radar.js';
import {
  fetchDepthContours,
  fetchDenseDepthContours,
  fetchDepthSamples,
  type DepthContourBbox,
} from '../depthContours.js';
import {
  clipDepthContoursOutsideOfficialCoverage,
  filterDepthSamplesOutsideOfficialCoverage,
  OFFICIAL_DEPTH_MIN_ZOOM,
} from '../depthCoverage.js';
import {
  fetchNavigationWarnings,
  fetchOfficialHarbours,
  fetchOfficialNavigation,
  fetchWrecks,
} from '../navigation/arcgis.js';
import { aisAtons } from '../navigation/aisAton.js';
import { mergeHarbours, mergeNavigationAids } from '../navigation/merge.js';
import { fetchFinnishNavigationAids } from '../navigation/vaylavirasto.js';
import { fetchFinnishNavigationWarnings } from '../navigation/traficomWarnings.js';
import { fetchTrafficSchemes } from '../navigation/osmTraffic.js';
import {
  coversPoint,
  enabledProviders,
  getProvider,
  listCapabilities,
} from '../providers/registry.js';
import { analyseRoute } from '../routeAnalysis.js';
import { isWithinRoutingServiceArea } from '../routing/coverage.js';
import {
  planRoute,
  RoutingDataUnavailableError,
  RoutingPlanTimeoutError,
} from '../routing/planner.js';

const VARIABLE_SET = new Set<string>(VARIABLES);

function parseVariables(raw: unknown): Variable[] | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const out = raw.split(',').filter((v) => VARIABLE_SET.has(v)) as Variable[];
  return out.length ? out : undefined;
}

function parseList(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const out = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function parseCoord(raw: unknown, name: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw Object.assign(new Error(`${name} peab olema arv vahemikus ${min}..${max}`), {
      statusCode: 400,
    });
  }
  return n;
}

function pointInBbox(lat: number, lon: number, [south, west, north, east]: BBox): boolean {
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

function hasExplicitTimezone(value: unknown): value is string {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

/** Lõikab kasutaja ala lubatud ristkülikusse; `null`, kui ühisosa puudub. */
export function intersectBbox(
  [south, west, north, east]: BBox,
  [limitSouth, limitWest, limitNorth, limitEast]: BBox,
): BBox | null {
  const clipped: BBox = [
    Math.max(south, limitSouth),
    Math.max(west, limitWest),
    Math.min(north, limitNorth),
    Math.min(east, limitEast),
  ];
  return clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : null;
}

/**
 * Kleebib bbox'i ruudustikule, mille samm sõltub vaate suurusest.
 *
 * Suur vaade -> jäme samm (0.5°), lähivaade -> peen samm (0.05°). Nii ei kaota
 * lähivaade täpsust, aga ülevaatekaardi nihutamine ei tekita uut päringut.
 * Servad laiendatakse alati väljapoole, et kiht kataks kogu nähtava ala.
 */
function snapBbox([south, west, north, east]: [number, number, number, number]): [
  number,
  number,
  number,
  number,
] {
  const span = Math.max(north - south, east - west);
  // Alumine samm on SIHILIKULT jäme (0.25°, ~15-28 km).
  //
  // Varem oli see 0.05°, mis tähendas, et lähivaates tekitas iga väike nihe
  // uue vahemälu võtme ja uue 64-kutselise päringu. Tunnieelarve (3000) sai
  // täis ~47 vaatega — tavaline kaardil ringi vaatamine sõi selle ära ja
  // tuulekiht lakkas uuenemast.
  //
  // Jämedam samm tähendab, et tõmbame nähtavast alast SUUREMA ruudu ja
  // järgmised nihked mahuvad sama ruudu sisse ehk tulevad vahemälust. Väli
  // interpoleeritakse niikuinii kliendis, seega jämedam tõmbeala ei vähenda
  // kaardil nähtavat tihedust.
  const step = span > 8 ? 1 : span > 4 ? 0.5 : 0.25;
  const floor = (v: number): number => Math.floor(v / step) * step;
  const ceil = (v: number): number => Math.ceil(v / step) * step;
  return [
    Number(floor(south).toFixed(4)),
    Number(floor(west).toFixed(4)),
    Number(ceil(north).toFixed(4)),
    Number(ceil(east).toFixed(4)),
  ];
}

/**
 * Punktipäringu koordinaadi samm.
 *
 * Pikkuskraadi samm on kahekordne samal põhjusel mis võrgustikul: Läänemere
 * laiuskraadidel on pikkuskraad ~2x kitsam, seega annab 0.05/0.1 kilomeetrites
 * ligikaudu ruudu (~5.6 km x ~5.7 km 59°N-il).
 */
const POINT_SNAP_LAT = 0.05;
const POINT_SNAP_LON = 0.1;

/**
 * Kleebib klikitud punkti jämedale võrele.
 *
 * Miks: `/api/point` vahemäluvõti sisaldab koordinaati täpselt sellisena, nagu
 * see päringusse läks (klient saadab 4 kohta ehk ~11 m). Ilma kleepimiseta on
 * PRAKTILISELT IGA klikk uus võti ja uus kutse Open-Meteole — ka siis, kui
 * kasutaja klikib sama lahe peale kümme korda järjest.
 *
 * Miks see andmeid ei riku: Open-Meteo ümardab niikuinii mudeli lahtrini
 * (ICON-EU ~7 km, GFS ~25 km) — kaks klikki paarisaja meetri kaugusel annavad
 * juba praegu identsed arvud, ainult kaks eri hinda. Kleepimise suurim nihe on
 * pool sammu ehk ~4 km diagonaalis, mis jääb peenima mudeli lahtri sisse.
 *
 * Kleebitakse AINULT päringu koordinaat. Vastuses `lat`/`lon` jäävad kasutaja
 * omaks, et UI näitaks kohta, kuhu ta tegelikult klikkis.
 */
export function snapPoint(lat: number, lon: number): { lat: number; lon: number } {
  const snap = (v: number, step: number): number =>
    Number((Math.round(v / step) * step).toFixed(4));
  return { lat: snap(lat, POINT_SNAP_LAT), lon: snap(lon, POINT_SNAP_LON) };
}

/** Kleebib aja täistunnile — prognoosid ongi tunnisammuga. */
function snapHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function toProviderError(providerId: string, err: unknown): ProviderError {
  const message = err instanceof Error ? err.message : String(err);
  // Parsimisvead on struktuursed — need tähendavad, et allikas muutis formaati
  // ja meie kood vajab parandust. Neid ei tohi kuvada kui "ajutine tõrge".
  const kind: ProviderError['kind'] = /pars|struktuur|formaat|ootamatu/i.test(message)
    ? 'parse'
    : 'unavailable';
  return { providerId, message, kind };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    version: config.appVersion,
    time: new Date().toISOString(),
    openMeteo: {
      mode: config.openMeteoApiKey ? 'commercial' : 'free',
      usage: usageMeter.snapshot(config.openMeteoMonthlyLimit),
    },
    // Päringueelarve seis — ilma selleta on "miks tuulekiht kadus?" pime koht.
    budgets: rateLimiter.stats(),
    // Vahemälu maht: kirjed kasvavad kaardi kerimisega ja piiri lähedus on
    // ainus märk sellest, et väljatõstmine on tööle hakanud.
    cache: { entries: cache.size, megabytes: Math.round((cache.bytes / 1048576) * 10) / 10 },
  }));

  app.get('/api/config', async () => ({
    defaultLat: config.defaultLat,
    defaultLon: config.defaultLon,
    defaultZoom: config.defaultZoom,
    aisEnabled: true,
    aisstreamEnabled: Boolean(config.aisstreamKey),
  }));

  app.get('/api/providers', async () => listCapabilities());

  /** Saadaval vaatlus- ja nowcast-kaadrite ajad Keskkonnaagentuuri WMS-ist. */
  app.get('/api/radar-times', async (_req, reply) => {
    const timeline = await fetchRadarTimeline();
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    return timeline;
  });

  /** EMODneti samasügavusjooned GeoJSON-vektorina nähtava kaardiala jaoks. */
  app.get('/api/depth-contours', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const raw = query.bbox;
    const bbox = typeof raw === 'string' ? raw.split(',').map(Number) : [];
    const zoom = Number(query.zoom ?? 0);
    if (
      bbox.length !== 4
      || bbox.some((value) => !Number.isFinite(value))
      || bbox[0]! < -180 || bbox[2]! > 180
      || bbox[1]! < -90 || bbox[3]! > 90
      || bbox[0]! >= bbox[2]! || bbox[1]! >= bbox[3]!
      || bbox[2]! - bbox[0]! > 20 || bbox[3]! - bbox[1]! > 20
    ) {
      return reply.code(400).send({
        error: 'bbox peab olema "lääs,lõuna,ida,põhi" ja katma kuni 20° ala',
      });
    }

    const typedBbox = bbox as DepthContourBbox;
    if (zoom >= 11 && bbox[2]! - bbox[0]! <= 1.5 && bbox[3]! - bbox[1]! <= 1.5) {
      const data = await fetchDenseDepthContours(typedBbox);
      reply.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return clipDepthContoursOutsideOfficialCoverage(data);
    }

    const body = await fetchDepthContours(typedBbox);
    reply.type('application/geo+json');
    reply.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    const data = JSON.parse(body) as unknown;
    return zoom >= OFFICIAL_DEPTH_MIN_ZOOM
      ? clipDepthContoursOutsideOfficialCoverage(data)
      : data;
  });

  /** Hõredad, mudelist tuletatud sügavusnumbrid; kuvatakse ainult lähisuumis. */
  app.get('/api/depth-samples', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const bbox = typeof query.bbox === 'string' ? query.bbox.split(',').map(Number) : [];
    const zoom = Number(query.zoom);
    if (
      bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))
      || bbox[0]! < -180 || bbox[2]! > 180 || bbox[1]! < -90 || bbox[3]! > 90
      || bbox[0]! >= bbox[2]! || bbox[1]! >= bbox[3]!
      || bbox[2]! - bbox[0]! > 20 || bbox[3]! - bbox[1]! > 20
      || !Number.isFinite(zoom) || zoom < 0 || zoom > 22
    ) {
      return reply.code(400).send({ error: 'Vigane bbox või zoom' });
    }

    const data = filterDepthSamplesOutsideOfficialCoverage(
      await fetchDepthSamples(bbox as DepthContourBbox, zoom),
    );
    reply.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return data;
  });

  /** Kasutaja algatatud kohanime- ja sadamaotsing OpenStreetMapist. */
  app.get('/api/search', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const query = typeof q.q === 'string' ? q.q.trim() : '';
    if (query.length < 2 || query.length > 120) {
      return reply.code(400).send({ error: 'q pikkus peab olema 2–120 märki' });
    }
    const lang = q.lang === 'en' ? 'en' : 'et';
    let viewbox: [number, number, number, number] | undefined;
    if (typeof q.bbox === 'string' && q.bbox) {
      const parts = q.bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[0]! >= parts[2]! || parts[1]! >= parts[3]!) {
        return reply.code(400).send({ error: 'bbox peab olema "lõuna,lääs,põhi,ida"' });
      }
      viewbox = parts as [number, number, number, number];
    }

    const results: SearchResult[] = await searchPlaces(query, lang, viewbox);
    reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=604800');
    return { results };
  });

  /** Ajarida ühe punkti kohta, mitmelt allikalt korraga. */
  app.get('/api/point', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lat = parseCoord(q.lat, 'lat', -90, 90);
    const lon = parseCoord(q.lon, 'lon', -180, 180);
    if (!pointInBbox(lat, lon, config.weatherPointBbox)) {
      return reply.code(400).send({ error: 'Punkt jääb WEATHER_POINT_BBOX alast välja' });
    }
    // Ülempiir 240 h = 10 päeva. Open-Meteo ulatub 16 päevani ja MET Norway
    // 9-ni, aga üle 2 nädala hakkab Open-Meteo ühte punkti mitmeks kutseks
    // lugema ja prognoosi väärtus on üle ~7 päeva niikuinii nõrk.
    const hours = Math.min(240, Math.max(1, Number(q.hours) || 72));
    const variables = parseVariables(q.vars);
    const models = parseList(q.models);
    // Lainemudel on eraldi parameeter, sest mere-API-l on oma mudelinimed —
    // atmosfäärimudeli ID sinna saates tuleb 200 täis nulle.
    const waveModel = typeof q.waveModel === 'string' && q.waveModel ? q.waveModel : undefined;

    // Kleebime enne katvuse kontrolli, et kontroll käiks sama punkti kohta,
    // mille me tegelikult alt küsime.
    const snapped = snapPoint(lat, lon);

    const requested = parseList(q.providers);
    const providers = (requested
      ? requested.map(getProvider).filter((p): p is NonNullable<typeof p> => !!p)
      : enabledProviders()
    ).filter((p) => coversPoint(p, snapped.lat, snapped.lon));

    const series: TimeSeries[] = [];
    const errors: ProviderError[] = [];

    // Iga provider eraldi — ühe kukkumine ei tohi kogu vastust nurjata.
    const results = await Promise.allSettled(
      providers.map((p) =>
        p.point({ lat: snapped.lat, lon: snapped.lon, hours, variables, models, waveModel }),
      ),
    );

    results.forEach((res, i) => {
      const provider = providers[i]!;
      if (res.status === 'fulfilled') series.push(...res.value);
      else errors.push(toProviderError(provider.caps.id, res.reason));
    });

    // Cache-Control: brauser ja service worker tohivad seda korraks hoida.
    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');

    const result: PointResult = { lat, lon, series, errors };
    return result;
  });

  /** Väli kaardikihi jaoks (tuulenooled, laineväli). */
  app.get('/api/grid', async (req, reply) => {
    const q = req.query as Record<string, unknown>;

    const bboxRaw = String(q.bbox ?? '');
    const parts = bboxRaw.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return reply.code(400).send({ error: 'bbox peab olema "lõuna,lääs,põhi,ida"' });
    }
    const [south, west, north, east] = parts as [number, number, number, number];
    if (
      south < -90 || north > 90 || west < -180 || east > 180
      || south >= north || west >= east
    ) {
      return reply.code(400).send({ error: 'bbox on tagurpidi või tühi' });
    }
    const clipped = intersectBbox([south, west, north, east], config.weatherGridBbox);
    if (!clipped) {
      return reply.code(400).send({ error: 'bbox jääb WEATHER_GRID_BBOX alast välja' });
    }

    const providerId = String(q.provider ?? 'open-meteo');
    const provider = getProvider(providerId);
    if (!provider?.grid) {
      return reply.code(400).send({ error: `Provider "${providerId}" ei paku võrgustikku` });
    }

    const variables = parseVariables(q.vars) ?? (['wind_speed', 'wind_dir'] as Variable[]);
    const steps = Math.min(16, Math.max(2, Number(q.steps) || 10));
    const modelId = typeof q.model === 'string' ? q.model : undefined;
    const waveModelId = typeof q.waveModel === 'string' ? q.waveModel : undefined;

    // Kleebime bbox'i ja aja jämedale ruudustikule.
    //
    // Ilma selleta tekitaks iga väikseim kaardinihe uue vahemälu võtme ja uue
    // päringu Open-Meteole — mis viis arenduses juba 429-ni. Open-Meteo loeb
    // mitmepunktilise päringu iga punkti eraldi kutseks, seega 12x12 võrgustik
    // on 144 kutset. Kleepimine tähendab, et lähestikused vaated jagavad ühte
    // vastust ja tegelik päringute arv kukub suurusjärgu võrra.
    // `snapBbox` laiendab servad võrejooneni; lõikame pärast seda uuesti, et
    // ümardamine ei saaks seadistatud kulupiirist paari kümnendiku võrra väljuda.
    const snapped = intersectBbox(snapBbox(clipped), config.weatherGridBbox)!;
    const time = snapHour(typeof q.time === 'string' && q.time ? q.time : new Date().toISOString());

    // `window=day` annab kogu ööpäeva korraga. Server tõmbas selle niikuinii
    // ühe päringuga; ühe tunni kaupa väljastamine tähendas kliendile uut
    // HTTP-ringi iga ajaliuguri sammu peale ja nähtavat viivitust.
    const wantDay = String(q.window ?? '') === 'day' && Boolean(provider.gridDay);

    try {
      if (wantDay) {
        const result = await provider.gridDay!({ bbox: snapped, steps, variables, time, modelId, waveModelId });
        reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
        return result;
      }
      const frame = await provider.grid({ bbox: snapped, steps, variables, time, modelId, waveModelId });
      reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
      return frame;
    } catch (err) {
      // Eelarve täis ei ole serveri viga, vaid teadaolev seisund. 500 tähendaks
      // kliendile "midagi läks katki" ja klient neelaks selle vaikselt alla —
      // kasutaja jaoks näeks see välja nagu rakendus lihtsalt lakkas töötamast.
      // 503 + retryAfter laseb UI-l öelda, MIS toimub ja millal möödub.
      // Meie oma eelarve JA allika enda 429 on kasutaja jaoks sama seisund:
      // "andmed ei uuene, tuleb oodata". Esimene 429 tuleb allikalt ja jõuaks
      // muidu kliendini toore 429-na, mida UI ei oska seletada.
      const retryAfterSeconds =
        err instanceof RateLimitError
          ? err.retryAfterSeconds
          : err instanceof HttpError && err.status === 429
            ? Math.ceil((3600_000 - (Date.now() % 3600_000)) / 1000)
            : null;

      if (retryAfterSeconds !== null) {
        reply.header('Retry-After', String(retryAfterSeconds));
        return reply.code(503).send({
          error: 'rate_limited',
          source: err instanceof RateLimitError ? err.source : 'open-meteo',
          retryAfterSeconds,
          message:
            err instanceof Error ? err.message : 'Allikas piirab päringute arvu',
        });
      }
      throw err;
    }
  });

  /** Mõõtejaamad ja poid GeoJSON-ina, otse MapLibre'i sööda jaoks. */
  app.get('/api/stations', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const requested = parseList(q.providers);

    const providers = enabledProviders().filter(
      (p) => p.caps.supportsStations && (!requested || requested.includes(p.caps.id)),
    );

    const readings: StationReading[] = [];
    const errors: ProviderError[] = [];

    const results = await Promise.allSettled(providers.map((p) => p.stations!()));
    results.forEach((res, i) => {
      const provider = providers[i]!;
      if (res.status === 'fulfilled') readings.push(...res.value);
      else errors.push(toProviderError(provider.caps.id, res.reason));
    });

    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    return { stations: readings, errors };
  });

  /** Laevad AIS-ist, ühendatud registrist. */
  app.get('/api/ais', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const parts = String(q.bbox ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return reply.code(400).send({ error: 'bbox peab olema "lõuna,lääs,põhi,ida"' });
    }

    const list = vessels.query(parts as [number, number, number, number]);
    // AIS on reaalajas — vananenud laevapositsioon on halvem kui puuduv,
    // seega keelame vahepuhverdamise sõnaselgelt.
    reply.header('Cache-Control', 'no-store');
    return {
      vessels: list,
      sources: ['digitraffic', 'transpordiamet', ...(aisstream.enabled ? ['aisstream'] : [])],
    };
  });

  /** Sadamad OSM-ist, ametliku sadamaregistri väljadega rikastatult. */
  app.get('/api/harbours', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const parts = String(q.bbox ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return reply.code(400).send({ error: 'bbox peab olema "lõuna,lääs,põhi,ida"' });
    }

    const bbox = parts as [number, number, number, number];
    const [osmResult, officialResult] = await Promise.allSettled([
      fetchHarbours(bbox),
      fetchOfficialHarbours(bbox),
    ]);
    if (osmResult.status === 'rejected' && officialResult.status === 'rejected') {
      throw osmResult.reason;
    }
    const harbours = mergeHarbours(
      osmResult.status === 'fulfilled' ? osmResult.value : [],
      officialResult.status === 'fulfilled' ? officialResult.value : [],
    );
    // Sadamad ei liigu — laseme brauseril neid julgelt hoida.
    reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return { harbours };
  });

  /** OSM-i liikluseraldusskeemid eraldi, et aeglane Overpass ei pidurdaks märke. */
  app.get('/api/traffic-schemes', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const parts = String(q.bbox ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return reply.code(400).send({ error: 'bbox peab olema "lõuna,lääs,põhi,ida"' });
    }
    const trafficSchemes = await fetchTrafficSchemes(
      parts as [number, number, number, number],
    );
    reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return { trafficSchemes };
  });

  /** Hoiatused, vrakid, ametlikud laevateed ja navigatsioonimärgid. */
  app.get('/api/navigation', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const parts = String(q.bbox ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return reply.code(400).send({ error: 'bbox peab olema "lõuna,lääs,põhi,ida"' });
    }
    const bbox = parts as [number, number, number, number];
    const requested = new Set(parseList(q.include) ?? [
      'warnings',
      'wrecks',
      'official',
      'aids',
    ]);
    const wantWarnings = requested.has('warnings');
    const wantWrecks = requested.has('wrecks');
    const wantOfficial = requested.has('official');
    const wantAisAids = requested.has('aids');
    const [
      estonianWarningResult,
      finnishWarningResult,
      wreckResult,
      officialResult,
      finnishAidResult,
    ] = await Promise.allSettled([
      wantWarnings ? fetchNavigationWarnings(bbox) : Promise.resolve([]),
      wantWarnings ? fetchFinnishNavigationWarnings(bbox) : Promise.resolve([]),
      wantWrecks ? fetchWrecks(bbox) : Promise.resolve([]),
      // AIS-märk vajab registri vastet ka siis, kui ametlik kiht pole nähtav:
      // sealt tuleb täpne märgitüüp ja tingmärk. ArcGIS vastus on vahemälus.
      wantOfficial || wantAisAids
        ? fetchOfficialNavigation(bbox)
        : Promise.resolve({ aids: [], fairways: [] }),
      wantOfficial || wantAisAids
        ? fetchFinnishNavigationAids(bbox)
        : Promise.resolve([]),
    ]);
    const official = officialResult.status === 'fulfilled'
      ? officialResult.value
      : { aids: [], fairways: [] };

    reply.header('Cache-Control', 'no-store');
    const mergedAids = mergeNavigationAids(
      [
        ...official.aids,
        ...(finnishAidResult.status === 'fulfilled' ? finnishAidResult.value : []),
      ],
      wantAisAids ? aisAtons.query(bbox) : [],
    );

    return {
      warnings: [
        ...(estonianWarningResult.status === 'fulfilled' ? estonianWarningResult.value : []),
        ...(finnishWarningResult.status === 'fulfilled' ? finnishWarningResult.value : []),
      ],
      wrecks: wreckResult.status === 'fulfilled' ? wreckResult.value : [],
      fairways: wantOfficial ? official.fairways : [],
      trafficSchemes: [],
      aids: wantOfficial
        ? mergedAids
        : mergedAids.filter((aid) => aid.sources.includes('ais')),
      errors: [
        estonianWarningResult,
        finnishWarningResult,
        wreckResult,
        officialResult,
        finnishAidResult,
      ]
        .map((result, index) => result.status === 'rejected'
          ? ['estonian-warnings', 'finnish-warnings', 'wrecks', 'official', 'finnish-aids'][index]
          : null)
        .filter(Boolean),
    };
  });

  let activeRoutePlans = 0;

  /** Staatiline automaatmarsruut A ja B vahel, koos allika- ja riskijäljega. */
  app.post('/api/route-plan', async (req, reply) => {
    const body = req.body as Partial<RoutePlanRequest> | null;
    const validPoint = (point: unknown): point is { lat: number; lon: number } => {
      if (!point || typeof point !== 'object') return false;
      const candidate = point as { lat?: unknown; lon?: unknown };
      return Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon)
        && Number(candidate.lat) >= -90 && Number(candidate.lat) <= 90
        && Number(candidate.lon) >= -180 && Number(candidate.lon) <= 180;
    };
    const values = [
      body?.speedKnots,
      body?.draughtM,
      body?.underKeelClearanceM,
      body?.beamM,
      body?.airDraughtM,
    ];
    const departureMs = hasExplicitTimezone(body?.departureTime)
      ? new Date(body.departureTime).getTime()
      : Number.NaN;
    if (!body || !validPoint(body.start) || !validPoint(body.end)
      || !Number.isFinite(departureMs)
      || values.some((value) => !Number.isFinite(value))
      || Number(body.speedKnots) <= 0 || Number(body.speedKnots) > 100
      || Number(body.draughtM) < 0 || Number(body.draughtM) > 30
      || Number(body.underKeelClearanceM) < 0 || Number(body.underKeelClearanceM) > 20
      || Number(body.beamM) <= 0 || Number(body.beamM) > 100
      || Number(body.airDraughtM) <= 0 || Number(body.airDraughtM) > 100) {
      return reply.code(400).send({ error: 'Vigased marsruudi või laeva parameetrid' });
    }
    if (!pointInBbox(body.start.lat, body.start.lon, config.routingBbox)
      || !pointInBbox(body.end.lat, body.end.lon, config.routingBbox)
      || !isWithinRoutingServiceArea(body.start)
      || !isWithinRoutingServiceArea(body.end)) {
      return reply.code(400).send({ error: 'outside_routing_coverage' });
    }
    const distanceNm = distanceMetres(body.start, body.end) / 1852;
    if (distanceNm < 0.01 || distanceNm > config.routingMaxDistanceNm) {
      return reply.code(400).send({
        error: `Algus- ja lõpp-punkti kaugus peab olema 0.01–${config.routingMaxDistanceNm} NM`,
      });
    }

    const concurrencyLimit = Math.max(1, Math.floor(config.routingMaxConcurrentPlans));
    if (activeRoutePlans >= concurrencyLimit) {
      reply.header('Retry-After', '1');
      return reply.code(503).send({ error: 'route_plan_busy', retryAfterSeconds: 1 });
    }

    const requestAbort = new AbortController();
    const abortRequest = (): void => {
      if (!requestAbort.signal.aborted) requestAbort.abort();
    };
    const onRequestClose = (): void => {
      if (req.raw.aborted || !req.raw.complete) abortRequest();
    };
    const onResponseClose = (): void => {
      if (!reply.raw.writableEnded) abortRequest();
    };
    // Fastify 5.11 `req.signal` kuulab IncomingMessage'i `close` sündmust.
    // Node 24 saadab selle POST-i puhul ka siis, kui päringu keha jõudis
    // edukalt lõpuni, mistõttu pikk handler katkestati kohe pärast body
    // parsimist (`request_aborted`). Eristame siin päris katkestust ise:
    // - `aborted` / mittetäielik request enne body lõppu;
    // - sulgunud response-socket pärast täieliku body vastuvõtmist.
    // Nii ei tõlgendata tavalist request-streami lõppu kliendi lahkumiseks.
    req.raw.once('aborted', abortRequest);
    req.raw.once('close', onRequestClose);
    reply.raw.once('close', onResponseClose);
    activeRoutePlans++;

    try {
      reply.header('Cache-Control', 'no-store');
      const routeTimings: Array<Record<string, unknown>> = [];
      const instrumentation = config.routingTimingsLog
        ? { phase: (name: string, ms: number, meta?: Record<string, number>) =>
            routeTimings.push({ name, ms: Math.round(ms * 10) / 10, ...meta }) }
        : undefined;
      try {
        // `no_route` on valiidne planeerimistulemus (mitte transpordiviga), seega
        // tagastame selle 200-ga ja klient saab põhjused samast union-tüübist.
        return await planRoute(body as RoutePlanRequest, { signal: requestAbort.signal, instrumentation });
      } finally {
        if (instrumentation) req.log.info({ routeTimings }, 'route-plan timings');
      }
    } catch (error) {
      if (error instanceof RoutingPlanTimeoutError
        || (typeof error === 'object' && error !== null
          && (error as { name?: unknown }).name === 'RoutingPlanTimeoutError')) {
        return reply.code(504).send({ error: 'route_plan_timeout' });
      }
      if (error instanceof RoutingDataUnavailableError
        || (typeof error === 'object' && error !== null
          && (error as { name?: unknown }).name === 'RoutingDataUnavailableError')) {
        const sourceIds = error instanceof RoutingDataUnavailableError
          ? error.sourceIds
          : (error as Error & { sourceIds?: string[] }).sourceIds ?? [];
        return reply.code(503).send({
          error: 'data_unavailable',
          sourceIds,
        });
      }
      if (requestAbort.signal.aborted
        && typeof error === 'object' && error !== null
        && (error as { name?: unknown }).name === 'AbortError') {
        return reply.raw.destroyed
          ? reply
          : reply.code(499).send({ error: 'request_aborted' });
      }
      throw error;
    } finally {
      activeRoutePlans--;
      req.raw.off('aborted', abortRequest);
      req.raw.off('close', onRequestClose);
      reply.raw.off('close', onResponseClose);
    }
  });

  /** Marsruudi ilma-, aja-, kütuse- ja EMODneti sügavusanalüüs. */
  app.post('/api/route-analysis', async (req, reply) => {
    const body = req.body as Partial<RouteAnalysisRequest> | null;
    const waypoints = body?.waypoints;
    const startMs = new Date(body?.startTime ?? '').getTime();
    const validPoint = (p: unknown): p is { lat: number; lon: number } => {
      if (!p || typeof p !== 'object') return false;
      const point = p as { lat?: unknown; lon?: unknown };
      return Number.isFinite(point.lat) && Number.isFinite(point.lon)
        && Number(point.lat) >= -90 && Number(point.lat) <= 90
        && Number(point.lon) >= -180 && Number(point.lon) <= 180;
    };
    const path = body?.path;
    const validPath = path === undefined || (
      path?.type === 'LineString'
      && Array.isArray(path.coordinates)
      && path.coordinates.length >= 2
      && path.coordinates.length <= 2000
      && path.coordinates.every((coordinate) =>
        Array.isArray(coordinate)
        && coordinate.length === 2
        && Number.isFinite(coordinate[0])
        && Number.isFinite(coordinate[1])
        && coordinate[0] >= -180 && coordinate[0] <= 180
        && coordinate[1] >= -90 && coordinate[1] <= 90)
    );
    const values = [body?.speedKnots, body?.draughtM, body?.underKeelClearanceM, body?.fuelLitresPerHour];
    if (!Array.isArray(waypoints) || waypoints.length < 2 || waypoints.length > 100
      || !validPath
      || !waypoints.every(validPoint) || !Number.isFinite(startMs)
      || values.some((value) => !Number.isFinite(value))
      || Number(body!.speedKnots) <= 0 || Number(body!.speedKnots) > 100
      || Number(body!.draughtM) < 0 || Number(body!.draughtM) > 30
      || Number(body!.underKeelClearanceM) < 0 || Number(body!.underKeelClearanceM) > 20
      || Number(body!.fuelLitresPerHour) < 0 || Number(body!.fuelLitresPerHour) > 10_000) {
      return reply.code(400).send({ error: 'Vigane marsruut või laeva parameetrid' });
    }
    try {
      reply.header('Cache-Control', 'no-store');
      return await analyseRoute(body as RouteAnalysisRequest);
    } catch (err) {
      if (err instanceof RateLimitError) {
        reply.header('Retry-After', String(err.retryAfterSeconds));
        return reply.code(503).send({ error: 'rate_limited', source: err.source, retryAfterSeconds: err.retryAfterSeconds });
      }
      throw err;
    }
  });

  /** Trackid — liides on olemas, allikaid veel pole (Traccar / GPX tulevad hiljem). */
  app.get('/api/tracks', async () => ({ tracks: [], providers: [] }));
}
