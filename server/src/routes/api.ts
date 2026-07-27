import type { FastifyInstance } from 'fastify';
import type {
  PointResult,
  ProviderError,
  StationReading,
  TimeSeries,
  Variable,
} from '@seapro/shared';
import { VARIABLES } from '@seapro/shared';
import { config } from '../config.js';
import {
  coversPoint,
  enabledProviders,
  getProvider,
  listCapabilities,
} from '../providers/registry.js';

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
  const step = span > 8 ? 1 : span > 4 ? 0.5 : span > 1.5 ? 0.25 : span > 0.5 ? 0.1 : 0.05;
  const floor = (v: number): number => Math.floor(v / step) * step;
  const ceil = (v: number): number => Math.ceil(v / step) * step;
  return [
    Number(floor(south).toFixed(4)),
    Number(floor(west).toFixed(4)),
    Number(ceil(north).toFixed(4)),
    Number(ceil(east).toFixed(4)),
  ];
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
  }));

  app.get('/api/config', async () => ({
    defaultLat: config.defaultLat,
    defaultLon: config.defaultLon,
    defaultZoom: config.defaultZoom,
    aisEnabled: true,
    aisstreamEnabled: Boolean(config.aisstreamKey),
  }));

  app.get('/api/providers', async () => listCapabilities());

  /** Ajarida ühe punkti kohta, mitmelt allikalt korraga. */
  app.get('/api/point', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lat = parseCoord(q.lat, 'lat', -90, 90);
    const lon = parseCoord(q.lon, 'lon', -180, 180);
    const hours = Math.min(192, Math.max(1, Number(q.hours) || 72));
    const variables = parseVariables(q.vars);
    const models = parseList(q.models);

    const requested = parseList(q.providers);
    const providers = (requested
      ? requested.map(getProvider).filter((p): p is NonNullable<typeof p> => !!p)
      : enabledProviders()
    ).filter((p) => coversPoint(p, lat, lon));

    const series: TimeSeries[] = [];
    const errors: ProviderError[] = [];

    // Iga provider eraldi — ühe kukkumine ei tohi kogu vastust nurjata.
    const results = await Promise.allSettled(
      providers.map((p) => p.point({ lat, lon, hours, variables, models })),
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
    if (south >= north || west >= east) {
      return reply.code(400).send({ error: 'bbox on tagurpidi või tühi' });
    }

    const providerId = String(q.provider ?? 'open-meteo');
    const provider = getProvider(providerId);
    if (!provider?.grid) {
      return reply.code(400).send({ error: `Provider "${providerId}" ei paku võrgustikku` });
    }

    const variables = parseVariables(q.vars) ?? (['wind_speed', 'wind_dir'] as Variable[]);
    const steps = Math.min(16, Math.max(2, Number(q.steps) || 10));
    const modelId = typeof q.model === 'string' ? q.model : undefined;

    // Kleebime bbox'i ja aja jämedale ruudustikule.
    //
    // Ilma selleta tekitaks iga väikseim kaardinihe uue vahemälu võtme ja uue
    // päringu Open-Meteole — mis viis arenduses juba 429-ni. Open-Meteo loeb
    // mitmepunktilise päringu iga punkti eraldi kutseks, seega 12x12 võrgustik
    // on 144 kutset. Kleepimine tähendab, et lähestikused vaated jagavad ühte
    // vastust ja tegelik päringute arv kukub suurusjärgu võrra.
    const snapped = snapBbox([south, west, north, east]);
    const time = snapHour(typeof q.time === 'string' && q.time ? q.time : new Date().toISOString());

    const frame = await provider.grid({ bbox: snapped, steps, variables, time, modelId });
    reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
    return frame;
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

  /** Trackid — liides on olemas, allikaid veel pole (Traccar / GPX tulevad hiljem). */
  app.get('/api/tracks', async () => ({ tracks: [], providers: [] }));
}
