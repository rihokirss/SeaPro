import type { BBox, NavigationGeometry, NavigationWarning } from '@seapro/shared';
import { cache } from '../cache.js';
import { fetchJson } from '../http.js';

const WFS = 'https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs';
const LAYERS = [
  'avoin:navigational_warnings_p',
  'avoin:navigational_warnings_l',
  'avoin:navigational_warnings_a',
] as const;
const FINLAND: BBox = [59.4, 19.0, 70.2, 31.7];
const WARNING_TTL = 2 * 60;
const PAGE_SIZE = 1_000;

export interface TraficomWarningFeature {
  id?: string | number;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface TraficomWarningCollection {
  features?: TraficomWarningFeature[];
  numberMatched?: number | string;
  numberReturned?: number | string;
}

export interface FinnishNavigationWarningResult {
  warnings: NavigationWarning[];
  ageSeconds: number;
  stale: boolean;
  error?: string;
}

/** Laadib nähtava ala kehtivad Soome navigatsioonihoiatused Traficomi WFS-ist. */
export async function fetchFinnishNavigationWarnings(bbox: BBox): Promise<NavigationWarning[]> {
  return (await fetchFinnishNavigationWarningsWithMeta(bbox)).warnings;
}

/** Sama hoiatuseloend koos automaatmarsruudi jaoks vajaliku värskusinfoga. */
export async function fetchFinnishNavigationWarningsWithMeta(
  bbox: BBox,
): Promise<FinnishNavigationWarningResult> {
  const clipped = intersectBbox(bbox, FINLAND);
  if (!clipped) return { warnings: [], ageSeconds: 0, stale: false };

  const snapped = snapBbox(clipped);
  const key = `traficom:warnings:v1:${snapped.join(',')}`;
  const result = await cache.get(key, WARNING_TTL, async () => {
    const collections = await Promise.all(LAYERS.map((layer) => queryLayer(layer, snapped)));
    return parseTraficomNavigationWarnings(collections);
  });

  return {
    warnings: result.value,
    ageSeconds: result.ageSeconds,
    stale: result.stale,
    ...(result.fallbackError
      ? { error: result.fallbackError instanceof Error
        ? result.fallbackError.message
        : String(result.fallbackError) }
      : {}),
  };
}

async function queryLayer(
  layer: typeof LAYERS[number],
  bbox: BBox,
): Promise<TraficomWarningCollection> {
  const features: TraficomWarningFeature[] = [];
  let startIndex = 0;

  while (startIndex < 20_000) {
    const [south, west, north, east] = bbox;
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: layer,
      bbox: `${west},${south},${east},${north},EPSG:4326`,
      srsName: 'EPSG:4326',
      outputFormat: 'application/json',
      count: String(PAGE_SIZE),
      startIndex: String(startIndex),
    });
    const page = await fetchJson<TraficomWarningCollection>(`${WFS}?${params}`, {
      timeoutMs: 30_000,
    });
    const returned = page.features?.length ?? 0;
    features.push(...(page.features ?? []));
    startIndex += returned;
    const matched = finiteNumber(page.numberMatched);
    if (returned === 0 || returned < PAGE_SIZE || (matched !== undefined && startIndex >= matched)) {
      break;
    }
  }

  return { features };
}

/**
 * Normaliseerib Traficomi S-124-põhise WFS-vastuse SeaPro ühisesse
 * hoiatusmudelisse. MultiPoint jagatakse punktideks, et kõik riigid kasutaksid
 * täpselt sama MapLibre'i punktikihi filtrit ja tingmärki.
 */
export function parseTraficomNavigationWarnings(
  collections: readonly TraficomWarningCollection[],
): NavigationWarning[] {
  return collections.flatMap((collection) => (collection.features ?? []).flatMap((feature) => {
    const geometries = navigationGeometries(feature.geometry);
    if (geometries.length === 0) return [];

    const p = feature.properties ?? {};
    const warningNumber = finiteNumber(p.MESSAGESERIESIDENTIFIERWARNINGNUMBER);
    const warningYear = finiteNumber(p.MESSAGESERIESIDENTIFIERYEAR);
    const numericIdentity = [warningYear, warningNumber]
      .filter((value) => value !== undefined)
      .join(':');
    const identity = text(p.MESSAGESERIESIDENTIFIERINTEROPERABILITYIDENTIFIER)
      ?? text(feature.id)
      ?? (numericIdentity || undefined)
      ?? text(p.ID)
      ?? 'unknown';
    const baseId = `traficom-warning:${identity}`;

    const common = {
      number: warningNumber,
      source: 'traficom' as const,
      titleFi: firstText(
        p.WARNINGINFORMATIONNAVWARNTYPEDETAILS_FI,
        p.NAVWARNTYPEGENERAL_FI,
        p.MESSAGESERIESIDENTIFIERNAMEOFSERIES_FI,
      ),
      titleEn: firstText(
        p.WARNINGINFORMATIONNAVWARNTYPEDETAILS_EN,
        p.NAVWARNTYPEGENERAL_EN,
        p.MESSAGESERIESIDENTIFIERNAMEOFSERIES_EN,
      ),
      textFi: text(p.WARNINGINFORMATION_FI),
      textEn: text(p.WARNINGINFORMATION_EN),
      areaFi: areaText(p.LOCALITYLOCATIONNAME_FI, p.GENERALAREALOCATIONNAME_FI),
      areaEn: areaText(p.LOCALITYLOCATIONNAME_EN, p.GENERALAREALOCATIONNAME_EN),
      publishedAt: isoDate(p.PUBLICATIONTIME),
    } satisfies Omit<NavigationWarning, 'id' | 'geometry'>;

    return geometries.map((geometry, index) => ({
      id: geometries.length === 1 ? baseId : `${baseId}:point:${index + 1}`,
      geometry,
      ...common,
    } satisfies NavigationWarning));
  }));
}

function navigationGeometries(
  geometry: TraficomWarningFeature['geometry'],
): NavigationGeometry[] {
  if (!geometry || typeof geometry.type !== 'string') return [];
  switch (geometry.type) {
    case 'Point': {
      const point = position(geometry.coordinates);
      return point ? [{ type: 'Point', coordinates: point }] : [];
    }
    case 'MultiPoint':
      return positions(geometry.coordinates).map((coordinates) => ({ type: 'Point', coordinates }));
    case 'LineString': {
      const coordinates = positions(geometry.coordinates);
      return coordinates.length >= 2 ? [{ type: 'LineString', coordinates }] : [];
    }
    case 'MultiLineString': {
      const coordinates = nestedPositions(geometry.coordinates).filter((line) => line.length >= 2);
      return coordinates.length ? [{ type: 'MultiLineString', coordinates }] : [];
    }
    case 'Polygon': {
      const coordinates = nestedPositions(geometry.coordinates).filter((ring) => ring.length >= 4);
      return coordinates.length ? [{ type: 'Polygon', coordinates }] : [];
    }
    case 'MultiPolygon': {
      if (!Array.isArray(geometry.coordinates)) return [];
      const coordinates = geometry.coordinates
        .map((polygon) => nestedPositions(polygon).filter((ring) => ring.length >= 4))
        .filter((polygon) => polygon.length > 0);
      return coordinates.length ? [{ type: 'MultiPolygon', coordinates }] : [];
    }
    default:
      return [];
  }
}

function position(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function positions(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  return value.map(position).filter((item): item is [number, number] => item !== null);
}

function nestedPositions(value: unknown): [number, number][][] {
  if (!Array.isArray(value)) return [];
  return value.map(positions).filter((item) => item.length > 0);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return undefined;
}

function areaText(locality: unknown, general: unknown): string | undefined {
  const values = [text(locality), text(general)].filter((value): value is string => Boolean(value));
  return [...new Set(values)].join(' · ') || undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function intersectBbox(a: BBox, b: BBox): BBox | null {
  const clipped: BBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : null;
}

function snapBbox([south, west, north, east]: BBox): BBox {
  const step = 0.25;
  return [
    Math.floor(south / step) * step,
    Math.floor(west / step) * step,
    Math.ceil(north / step) * step,
    Math.ceil(east / step) * step,
  ];
}
