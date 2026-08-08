import type { BBox } from '@seapro/shared';
import type { CachedResult } from '../../cache.js';
import type {
  Position,
  RoutingFeatureSource,
  RoutingGeometry,
  RoutingSourceId,
  RoutingSourceMeta,
} from '../sourceTypes.js';

export interface GeoJsonFeature {
  id?: string | number;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface GeoJsonCollection {
  features?: GeoJsonFeature[];
  numberMatched?: number | string;
  numberReturned?: number | string;
  exceededTransferLimit?: boolean;
  error?: { message?: string };
}

export interface LoadedTile<T> {
  value: T;
  stamp: RoutingFeatureSource;
  ageSeconds: number;
}

export interface SourceLoad {
  source: RoutingSourceMeta;
}

export function sourceStamp<T>(
  source: RoutingSourceId,
  result: CachedResult<T>,
  now = Date.now(),
): RoutingFeatureSource {
  return {
    source,
    fetchedAt: new Date(now - Math.max(0, result.ageSeconds) * 1000).toISOString(),
    stale: result.stale,
  };
}

export function sourceMeta(opts: {
  source: RoutingSourceId;
  attribution: string;
  attributionUrl: string;
  requested: number;
  loaded: LoadedTile<unknown>[];
  errors: unknown[];
  outside?: boolean;
}): RoutingSourceMeta {
  const errors = opts.errors.map(errorMessage);
  const oldest = opts.loaded.reduce<LoadedTile<unknown> | undefined>(
    (result, item) => !result || item.ageSeconds > result.ageSeconds ? item : result,
    undefined,
  );
  const stale = opts.loaded.some((item) => item.stamp.stale);
  const status = opts.outside
    ? 'outside_coverage'
    : errors.length > 0
      ? opts.loaded.length > 0 ? 'partial' : 'unavailable'
      : stale ? 'stale' : 'ok';
  const ageSeconds = oldest?.ageSeconds ?? 0;
  const fetchedAt = oldest?.stamp.fetchedAt ?? new Date().toISOString();
  const coverage = status === 'unavailable'
    ? 'missing'
    : status === 'partial' ? 'partial' : 'complete';

  return {
    id: opts.source,
    source: opts.source,
    status,
    stale,
    fetchedAt,
    ageSeconds,
    coverage,
    ...(errors[0] ? { error: errors[0] } : {}),
    tilesRequested: opts.requested,
    tilesLoaded: opts.loaded.length,
    attribution: opts.attribution,
    attributionUrl: opts.attributionUrl,
    ...(errors.length ? { errors: [...new Set(errors)].slice(0, 20) } : {}),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Jagab lõuna-lääs-põhi-ida bbox'i stabiilseteks absoluutseteks paanideks. */
export function bboxTiles(bbox: BBox, step = 1): BBox[] {
  if (!bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || step <= 0) {
    return [];
  }
  const southIndex = Math.floor(bbox[0] / step);
  const westIndex = Math.floor(bbox[1] / step);
  // Täpselt paaniserval olev põhja-/idaserv ei vaja järgmist paani.
  const northIndex = Math.ceil(bbox[2] / step) - 1;
  const eastIndex = Math.ceil(bbox[3] / step) - 1;
  const result: BBox[] = [];
  for (let lat = southIndex; lat <= northIndex; lat++) {
    for (let lon = westIndex; lon <= eastIndex; lon++) {
      result.push([
        round(lat * step),
        round(lon * step),
        round((lat + 1) * step),
        round((lon + 1) * step),
      ]);
    }
  }
  return result;
}

/**
 * Hoiab pika A–B bbox'i HTTP-päringute arvu kontrolli all. Samm kasvab ainult
 * kahe kordsetena, seega jäävad ka suuremad paanid absoluutse võre külge ja
 * on järgmise päringuga taaskasutatavad.
 */
export function adaptiveBboxTiles(bbox: BBox, baseStep = 1, maxTiles = 16): BBox[] {
  if (!Number.isInteger(maxTiles) || maxTiles < 1) throw new RangeError('maxTiles peab olema positiivne täisarv');
  let step = baseStep;
  let tiles = bboxTiles(bbox, step);
  while (tiles.length > maxTiles) {
    step *= 2;
    tiles = bboxTiles(bbox, step);
  }
  return tiles;
}

export function intersectBbox(a: BBox, b: BBox): BBox | null {
  const result: BBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return result[0] < result[2] && result[1] < result[3] ? result : null;
}

export async function settleMapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}

export function asRoutingGeometry(value: GeoJsonFeature['geometry']): RoutingGeometry | null {
  if (!value || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'Point': {
      const point = position(value.coordinates);
      return point ? { type: 'Point', coordinates: point } : null;
    }
    case 'MultiPoint': {
      const points = positions(value.coordinates);
      return points.length ? { type: 'MultiPoint', coordinates: points } : null;
    }
    case 'LineString': {
      const line = positions(value.coordinates);
      return line.length >= 2 ? { type: 'LineString', coordinates: line } : null;
    }
    case 'MultiLineString': {
      const lines = nestedPositions(value.coordinates).filter((line) => line.length >= 2);
      return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
    }
    case 'Polygon': {
      const rings = nestedPositions(value.coordinates).filter((ring) => ring.length >= 4);
      return rings.length ? { type: 'Polygon', coordinates: rings } : null;
    }
    case 'MultiPolygon': {
      if (!Array.isArray(value.coordinates)) return null;
      const polygons = value.coordinates
        .map((polygon) => nestedPositions(polygon).filter((ring) => ring.length >= 4))
        .filter((polygon) => polygon.length > 0);
      return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
    }
    default:
      return null;
  }
}

export function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).trim();
  return result || undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const result = typeof value === 'string'
    ? Number(value.trim().replace(',', '.').match(/-?\d+(?:\.\d+)?/)?.[0])
    : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  const result = finiteNumber(value);
  return result !== undefined && result > 0 ? result : undefined;
}

export function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}Z$/.test(raw) ? `${raw.slice(0, -1)}T00:00:00Z` : raw;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function position(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function positions(value: unknown): Position[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const point = position(item);
    return point ? [point] : [];
  }) : [];
}

function nestedPositions(value: unknown): Position[][] {
  return Array.isArray(value) ? value.map(positions).filter((line) => line.length > 0) : [];
}

function round(value: number): number {
  return Number(value.toFixed(8));
}
