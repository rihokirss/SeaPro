import type { BBox, RoutePlanSource } from '@seapro/shared';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { cache } from '../cache.js';
import { fetchJson, request } from '../http.js';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const TTL_SECONDS = 24 * 3600;
const MAX_TILES = 256;

interface TileJson {
  tiles?: string[];
}

type Position = [number, number];
type Polygon = Position[][];

interface WaterTile {
  polygons: Polygon[];
}

export interface RoutingWaterMask {
  zoom: number;
  tiles: Map<string, WaterTile | null>;
  source: RoutePlanSource;
}

function tileX(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  return Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n)));
}

function tileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const limited = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radians = limited * Math.PI / 180;
  return Math.max(0, Math.min(n - 1,
    Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * n)));
}

function tileRange([south, west, north, east]: BBox, zoom: number): Array<[number, number]> {
  const minX = tileX(west, zoom); const maxX = tileX(east, zoom);
  const minY = tileY(north, zoom); const maxY = tileY(south, zoom);
  const tiles: Array<[number, number]> = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) tiles.push([x, y]);
  }
  return tiles;
}

function chooseZoom(bbox: BBox): number {
  let zoom = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) > 2 ? 10 : 12;
  while (zoom > 7 && tileRange(bbox, zoom).length > MAX_TILES) zoom--;
  return zoom;
}

function polygonsFromGeometry(geometry: unknown): Polygon[] {
  if (!geometry || typeof geometry !== 'object') return [];
  const value = geometry as { type?: string; coordinates?: unknown };
  if (value.type === 'Polygon' && Array.isArray(value.coordinates)) {
    return [value.coordinates as Polygon];
  }
  if (value.type === 'MultiPolygon' && Array.isArray(value.coordinates)) {
    return value.coordinates as Polygon[];
  }
  return [];
}

async function tileTemplate(): Promise<string> {
  const { value } = await cache.get('openfreemap:tilejson:v1', TTL_SECONDS, () =>
    fetchJson<TileJson>(TILEJSON_URL, { timeoutMs: 15_000, retries: 1 }));
  const template = value.tiles?.[0];
  if (!template) throw new Error('OpenFreeMap TileJSON ei sisalda paani URL-i');
  return template;
}

async function fetchWaterTile(
  template: string,
  zoom: number,
  x: number,
  y: number,
): Promise<{ tile: WaterTile; ageSeconds: number; stale: boolean; error?: string }> {
  const version = template.split('/').at(-4) ?? 'planet';
  const result = await cache.get(`openfreemap:water:v1:${version}:${zoom}:${x}:${y}`, TTL_SECONDS, async () => {
    const url = template
      .replace('{z}', String(zoom))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const response = await request(url, {
      headers: { Accept: 'application/x-protobuf, application/vnd.mapbox-vector-tile' },
      timeoutMs: 20_000,
      retries: 1,
    });
    const vector = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer())));
    const layer = vector.layers.water;
    const polygons: Polygon[] = [];
    if (layer) {
      for (let index = 0; index < layer.length; index++) {
        const feature = layer.feature(index).toGeoJSON(x, y, zoom);
        polygons.push(...polygonsFromGeometry(feature.geometry));
      }
    }
    return { polygons };
  });
  return {
    tile: result.value,
    ageSeconds: result.ageSeconds,
    stale: result.stale,
    error: result.fallbackError instanceof Error ? result.fallbackError.message : undefined,
  };
}

export async function loadRoutingWaterMask(bbox: BBox): Promise<RoutingWaterMask> {
  const zoom = chooseZoom(bbox);
  const wanted = tileRange(bbox, zoom);
  const tiles = new Map<string, WaterTile | null>();
  const errors: string[] = [];
  let stale = false;
  let maxAge = 0;
  const template = await tileTemplate();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, wanted.length) }, async () => {
    while (cursor < wanted.length) {
      const [x, y] = wanted[cursor++]!;
      const key = `${x}:${y}`;
      try {
        const result = await fetchWaterTile(template, zoom, x, y);
        tiles.set(key, result.tile);
        stale ||= result.stale;
        maxAge = Math.max(maxAge, result.ageSeconds);
        if (result.error) errors.push(result.error);
      } catch (error) {
        tiles.set(key, null);
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }));

  return {
    zoom,
    tiles,
    source: {
      id: 'openfreemap-water',
      fetchedAt: new Date(Date.now() - maxAge * 1000).toISOString(),
      ageSeconds: maxAge,
      stale,
      coverage: errors.length === 0 ? 'complete' : errors.length === wanted.length ? 'missing' : 'partial',
      error: errors[0],
    },
  };
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!; const b = ring[j]!;
    const crosses = (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Position, polygon: Polygon): boolean {
  if (!polygon[0] || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

/** `null` tähendab, et vastava paani laadimine ebaõnnestus. */
export function routingWaterAt(mask: RoutingWaterMask, lon: number, lat: number): boolean | null {
  const key = `${tileX(lon, mask.zoom)}:${tileY(lat, mask.zoom)}`;
  const tile = mask.tiles.get(key);
  if (!tile) return null;
  return tile.polygons.some((polygon) => pointInPolygon([lon, lat], polygon));
}

interface PreparedRing {
  xs: Float64Array;
  ys: Float64Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PreparedPolygon {
  outer: PreparedRing;
  holes: PreparedRing[];
}

/**
 * Kulupinna baasklassifikatsioon küsib veemaski miljoneid kordi. Sampler
 * valmistab paani polügoonid ette (lamedad koordinaadid + ringi bbox) ja
 * hoiab rea sees viimase paani käepärast, et iga proov ei maksaks
 * stringivõtit, Map-otsingut ega vahemassiive. Tulemus on sama mis
 * `routingWaterAt`-il: sama ray-cast avaldis samadel ujukomaväärtustel;
 * bbox-i eelkontroll on täpne, sest bbox'ist väljas annab ray-cast alati
 * paarisarvu lõikeid ehk "väljas".
 */
export interface RoutingWaterSampler {
  rowAt(lat: number): (lon: number) => boolean | null;
}

export function createRoutingWaterSampler(mask: RoutingWaterMask): RoutingWaterSampler {
  const prepared = new Map<string, PreparedPolygon[] | null>();

  const preparedTile = (key: string): PreparedPolygon[] | null => {
    const cached = prepared.get(key);
    if (cached !== undefined) return cached;
    const tile = mask.tiles.get(key);
    const polygons = tile
      ? tile.polygons.map((polygon) => ({
        outer: prepareRing(polygon[0] ?? []),
        holes: polygon.slice(1).map(prepareRing),
      }))
      : null;
    prepared.set(key, polygons);
    return polygons;
  };

  return {
    rowAt(lat) {
      const tileRow = tileY(lat, mask.zoom);
      // Skanjoon: ringi lõikepunktid selle laiuskraadiga arvutatakse paani
      // kohta üks kord ja iga proov maksab vaid mõne võrdluse. Sama half-open
      // ray-cast avaldis samadel ujukomaväärtustel kui `pointInRing`.
      const rowTiles = new Map<number, RowPolygon[] | null>();
      let lastTileColumn = Number.NaN;
      let current: RowPolygon[] | null = null;
      return (lon) => {
        const tileColumn = tileX(lon, mask.zoom);
        if (tileColumn !== lastTileColumn) {
          lastTileColumn = tileColumn;
          let entry = rowTiles.get(tileColumn);
          if (entry === undefined) {
            const polygons = preparedTile(`${tileColumn}:${tileRow}`);
            entry = polygons ? rowPolygons(polygons, lat) : null;
            rowTiles.set(tileColumn, entry);
          }
          current = entry;
        }
        if (!current) return null;
        for (const polygon of current) {
          if (!oddCrossingsRight(polygon.outer, lon)) continue;
          let inHole = false;
          for (const hole of polygon.holes) {
            if (oddCrossingsRight(hole, lon)) {
              inHole = true;
              break;
            }
          }
          if (!inHole) return true;
        }
        return false;
      };
    },
  };
}

interface RowPolygon {
  outer: number[];
  holes: number[][];
}

function rowPolygons(polygons: PreparedPolygon[], lat: number): RowPolygon[] {
  const result: RowPolygon[] = [];
  for (const polygon of polygons) {
    const outer = ringCrossingsAt(polygon.outer, lat);
    // Ilma välisringi lõiketa ei saa punkt sellel laiuskraadil sees olla.
    if (outer.length === 0) continue;
    result.push({
      outer,
      holes: polygon.holes
        .map((hole) => ringCrossingsAt(hole, lat))
        .filter((crossings) => crossings.length > 0),
    });
  }
  return result;
}

function ringCrossingsAt(ring: PreparedRing, lat: number): number[] {
  if (lat < ring.minY || lat > ring.maxY) return [];
  const { xs, ys } = ring;
  const crossings: number[] = [];
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    if ((ys[i]! > lat) !== (ys[j]! > lat)) {
      crossings.push((xs[j]! - xs[i]!) * (lat - ys[i]!) / (ys[j]! - ys[i]!) + xs[i]!);
    }
  }
  return crossings;
}

function oddCrossingsRight(crossings: number[], lon: number): boolean {
  let count = 0;
  for (const crossing of crossings) {
    if (lon < crossing) count++;
  }
  return (count & 1) === 1;
}

function prepareRing(ring: Position[]): PreparedRing {
  const xs = new Float64Array(ring.length);
  const ys = new Float64Array(ring.length);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < ring.length; index++) {
    const [x, y] = ring[index]!;
    xs[index] = x;
    ys[index] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { xs, ys, minX, minY, maxX, maxY };
}

