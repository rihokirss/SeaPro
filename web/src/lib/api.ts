import type {
  GridFrame,
  GridDayResult,
  Harbour,
  NavigationData,
  TrafficScheme,
  PointResult,
  ProviderCapabilities,
  ProviderError,
  RadarTimeline,
  StationReading,
  SearchResult,
  Variable,
  Vessel,
  RouteAnalysis,
  RouteAnalysisRequest,
} from '@seapro/shared';
import { getSessionId } from './session';

export interface AppConfig {
  defaultLat: number;
  defaultLon: number;
  defaultZoom: number;
  aisEnabled: boolean;
  aisstreamEnabled: boolean;
}

/**
 * Teadaolev seisund, mitte viga: väljaminevate päringute eelarve on tunniks
 * täis. Eraldi klass, sest UI peab seda kasutajale SELGITAMA, mitte
 * kuvama üldist "midagi läks valesti".
 */
export class RateLimitedError extends Error {
  constructor(
    readonly source: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`rate_limited:${source}`);
    this.name = 'RateLimitedError';
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    signal,
    headers: { Accept: 'application/json', 'X-SeaPro-Session': getSessionId() },
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        source?: string;
        retryAfterSeconds?: number;
      };
      if (res.status === 503 && body.error === 'rate_limited') {
        throw new RateLimitedError(body.source ?? 'allikas', body.retryAfterSeconds ?? 0);
      }
      if (body.error) detail = body.error;
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      // Vastus polnud JSON — jääme staatusekoodi juurde.
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST', signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-SeaPro-Session': getSessionId() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({})) as { error?: string; source?: string; retryAfterSeconds?: number };
    if (res.status === 503 && payload.error === 'rate_limited') throw new RateLimitedError(payload.source ?? 'allikas', payload.retryAfterSeconds ?? 0);
    throw new Error(payload.error ?? String(res.status));
  }
  return await res.json() as T;
}

export const api = {
  config: (signal?: AbortSignal) => get<AppConfig>('/api/config', signal),

  providers: (signal?: AbortSignal) => get<ProviderCapabilities[]>('/api/providers', signal),

  radarTimes: (signal?: AbortSignal) => get<RadarTimeline>('/api/radar-times', signal),

  search(
    opts: { q: string; lang: 'et' | 'en'; bbox?: [number, number, number, number] },
    signal?: AbortSignal,
  ) {
    const p = new URLSearchParams({ q: opts.q, lang: opts.lang });
    if (opts.bbox) p.set('bbox', opts.bbox.map((n) => n.toFixed(4)).join(','));
    return get<{ results: SearchResult[] }>(`/api/search?${p}`, signal);
  },

  point(
    opts: {
      lat: number;
      lon: number;
      hours?: number;
      providers?: string[];
      models?: string[];
      waveModel?: string;
    },
    signal?: AbortSignal,
  ): Promise<PointResult> {
    const p = new URLSearchParams({
      lat: opts.lat.toFixed(4),
      lon: opts.lon.toFixed(4),
      hours: String(opts.hours ?? 72),
    });
    if (opts.providers?.length) p.set('providers', opts.providers.join(','));
    if (opts.models?.length) p.set('models', opts.models.join(','));
    if (opts.waveModel) p.set('waveModel', opts.waveModel);
    return get<PointResult>(`/api/point?${p}`, signal);
  },

  grid(
    opts: {
      bbox: [number, number, number, number];
      steps: number;
      vars: Variable[];
      time: string;
      provider?: string;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<GridFrame> {
    const p = new URLSearchParams({
      bbox: opts.bbox.map((n) => n.toFixed(3)).join(','),
      steps: String(opts.steps),
      vars: opts.vars.join(','),
      time: opts.time,
    });
    if (opts.provider) p.set('provider', opts.provider);
    if (opts.model) p.set('model', opts.model);
    return get<GridFrame>(`/api/grid?${p}`, signal);
  },

  stations(providers?: string[], signal?: AbortSignal) {
    const p = new URLSearchParams();
    if (providers?.length) p.set('providers', providers.join(','));
    const qs = p.toString();
    return get<{ stations: StationReading[]; errors: ProviderError[] }>(
      `/api/stations${qs ? `?${qs}` : ''}`,
      signal,
    );
  },

  /** Kogu ööpäev korraga — ajaliuguri kerimine käib siis mälust. */
  gridDay(
    opts: {
      bbox: [number, number, number, number];
      steps: number;
      vars: Variable[];
      time: string;
      provider?: string;
      model?: string;
      waveModel?: string;
    },
    signal?: AbortSignal,
  ): Promise<GridDayResult> {
    const p = new URLSearchParams({
      bbox: opts.bbox.map((n) => n.toFixed(3)).join(','),
      steps: String(opts.steps),
      vars: opts.vars.join(','),
      time: opts.time,
      window: 'day',
    });
    if (opts.provider) p.set('provider', opts.provider);
    if (opts.model) p.set('model', opts.model);
    if (opts.waveModel) p.set('waveModel', opts.waveModel);
    return get<GridDayResult>(`/api/grid?${p}`, signal);
  },

  harbours(bbox: [number, number, number, number], signal?: AbortSignal) {
    const p = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(3)).join(',') });
    return get<{ harbours: Harbour[] }>(`/api/harbours?${p}`, signal);
  },

  vessels(bbox: [number, number, number, number], signal?: AbortSignal) {
    const p = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(3)).join(',') });
    return get<{ vessels: Vessel[]; sources: string[] }>(`/api/ais?${p}`, signal);
  },

  navigation(
    bbox: [number, number, number, number],
    include: Array<'warnings' | 'aids' | 'wrecks' | 'official'>,
    signal?: AbortSignal,
  ) {
    const p = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(3)).join(',') });
    p.set('include', include.join(','));
    return get<NavigationData & { errors?: string[] }>(`/api/navigation?${p}`, signal);
  },

  trafficSchemes(bbox: [number, number, number, number], signal?: AbortSignal) {
    const p = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(3)).join(',') });
    return get<{ trafficSchemes: TrafficScheme[] }>(`/api/traffic-schemes?${p}`, signal);
  },

  routeAnalysis(request: RouteAnalysisRequest, signal?: AbortSignal) {
    return post<RouteAnalysis>('/api/route-analysis', request, signal);
  },
};
