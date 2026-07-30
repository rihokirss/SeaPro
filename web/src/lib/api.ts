import type {
  GridFrame,
  Harbour,
  PointResult,
  ProviderCapabilities,
  ProviderError,
  StationReading,
  Variable,
  Vessel,
} from '@seapro/shared';
import type { NavilyPortMap } from './navily';

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
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
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

export const api = {
  config: (signal?: AbortSignal) => get<AppConfig>('/api/config', signal),

  navilyPorts: (signal?: AbortSignal) =>
    get<{ ports: NavilyPortMap }>('/api/navily-ports', signal),

  providers: (signal?: AbortSignal) => get<ProviderCapabilities[]>('/api/providers', signal),

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
  ): Promise<{ frames: GridFrame[] }> {
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
    return get<{ frames: GridFrame[] }>(`/api/grid?${p}`, signal);
  },

  harbours(bbox: [number, number, number, number], signal?: AbortSignal) {
    const p = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(3)).join(',') });
    return get<{ harbours: Harbour[] }>(`/api/harbours?${p}`, signal);
  },

  vessels(bbox: [number, number, number, number], signal?: AbortSignal) {
    const p = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(3)).join(',') });
    return get<{ vessels: Vessel[]; sources: string[] }>(`/api/ais?${p}`, signal);
  },
};
