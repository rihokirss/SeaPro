import {
  TRAFFIC_WORLD_CELLS, TRAFFIC_TYPES, trafficX, trafficY, trafficWindow, distanceMetres, trafficType,
  type TrafficCell, type TrafficDensity, type TrafficPeriod, type TrafficType,
} from '@seapro/shared';
import { join } from 'node:path';
import { database } from '../db/pool.js';
import { DAY, dataDirectory, historyConfig } from '../db/config.js';
import { cachedTrafficGrid, pruneTrafficGrids } from './trafficGridCache.js';

type Grid = Map<number, number>;
type Position = [number, number];

// One numeric key per cell and AIS type. A mature archive contains millions
// of these values, so cached grids use alternating keys and distances.
const ROW_STRIDE = TRAFFIC_WORLD_CELLS + 1;
const TYPE_COUNT = TRAFFIC_TYPES.length;
// Change the directory version if the grid geometry, key encoding or distance calculation changes.
const gridDirectory = join(dataDirectory, 'ais-traffic-grids-v1');
function cellKey(x: number, y: number, type: number) {
  return (y * ROW_STRIDE + x) * TYPE_COUNT + type;
}
export function packTrafficGrid(grid: Grid): Float64Array {
  const entries = new Float64Array(grid.size * 2);
  let i = 0;
  for (const key of Float64Array.from(grid.keys()).sort()) {
    entries[i++] = key;
    entries[i++] = grid.get(key)!;
  }
  return entries;
}

// Keys are ordered north to south. Skip rows outside the requested latitude
// range before inspecting individual cells in a cached day or month.
function firstEntry(entries: Float64Array, key: number) {
  let lo = 0, hi = entries.length / 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (entries[2 * mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return 2 * lo;
}

function gridCrossings(start: number, end: number, cuts: number[]) {
  for (let i = Math.floor(Math.min(start, end)) + 1; i < Math.max(start, end); i++) {
    cuts.push((i - start) / (end - start));
  }
}

/** Allocate the measured distance proportionally along the simplified track, splitting at cell edges. */
export function addTrafficLine(grid: Grid, line: Position[], type: TrafficType, metres: number) {
  const typeIndex = TRAFFIC_TYPES.indexOf(type);
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const [lon, lat] = line[i - 1]!;
    const [endLon, endLat] = line[i]!;
    const length = distanceMetres({ lon, lat }, { lon: endLon, lat: endLat });
    lengths.push(length);
    total += length;
  }
  if (!line.length || metres <= 0) return;
  if (!total) {
    const [lon, lat] = line[0]!;
    const key = cellKey(Math.floor(trafficX(lon)), Math.floor(trafficY(lat)), typeIndex);
    grid.set(key, (grid.get(key) ?? 0) + metres);
    return;
  }
  for (let i = 0; i < lengths.length; i++) {
    if (!lengths[i]) continue;
    const [lon, lat] = line[i]!;
    const [endLon, endLat] = line[i + 1]!;
    const x = trafficX(lon), y = trafficY(lat);
    const endX = trafficX(endLon), endY = trafficY(endLat);
    const cuts = [0, 1];
    gridCrossings(x, endX, cuts);
    gridCrossings(y, endY, cuts);
    cuts.sort((a, b) => a - b);
    const segmentMetres = metres * lengths[i]! / total;
    for (let j = 1; j < cuts.length; j++) {
      const a = cuts[j - 1]!, b = cuts[j]!;
      if (a === b) continue;
      const mid = (a + b) / 2;
      const key = cellKey(Math.floor(x + (endX - x) * mid), Math.floor(y + (endY - y) * mid), typeIndex);
      grid.set(key, (grid.get(key) ?? 0) + segmentMetres * (b - a));
    }
  }
}

async function buildDay(day: string): Promise<Float64Array> {
  const { rows } = await database.query<{ ship_type: number; distance_m: number; path: { coordinates: Position[] } }>(
    `SELECT ship_type, distance_m, ST_AsGeoJSON(ST_Force2D(path))::json AS path FROM ais_heatmap
     WHERE day=$1 AND distance_m>0 AND ST_GeometryType(path)='ST_LineString'`, [day]);
  const grid: Grid = new Map();
  for (const row of rows) addTrafficLine(grid, row.path.coordinates, trafficType(row.ship_type), row.distance_m);
  return packTrafficGrid(grid);
}

function loadDay(day: string, revision: string) {
  return cachedTrafficGrid(gridDirectory, day, revision, () => buildDay(day));
}

function mergeGrid(target: Grid, entries: Float64Array) {
  for (let i = 0; i < entries.length; i += 2) {
    const key = entries[i]!;
    target.set(key, (target.get(key) ?? 0) + entries[i + 1]!);
  }
}

type GridCache = Map<string, { revision: string; grid: Promise<Float64Array> }>;
const days: GridCache = new Map();
const months: GridCache = new Map();

function cachedGrid(cache: GridCache, key: string, revision: string, load: () => Promise<Float64Array>) {
  const previous = cache.get(key);
  if (previous?.revision === revision) return previous.grid;
  const grid = load().catch(error => {
    if (cache.get(key)?.grid === grid) cache.delete(key);
    throw error;
  });
  cache.set(key, { revision, grid });
  return grid;
}

type Bbox = [number, number, number, number];
type Snapshot = Pick<TrafficDensity, 'from' | 'to' | 'coveredDays'> & { chunks: Float64Array[] };

async function loadSnapshot(period: TrafficPeriod): Promise<Snapshot> {
  const { rows } = await database.query<{ day: string; revision: string; end_day: string; start_day: string }>(
    `WITH latest AS (SELECT max(day) AS last FROM history_jobs WHERE aggregated_at IS NOT NULL AND day<current_date)
     SELECT day::text, aggregated_at::text AS revision, last::text AS end_day, (last-($1::int-1))::text AS start_day
     FROM history_jobs, latest WHERE aggregated_at IS NOT NULL AND day BETWEEN last-($1::int-1) AND last
       AND ($2::int=0 OR day>=current_date-$2::int)
     ORDER BY day DESC`, [period, historyConfig.heatmapDays]);
  if (!rows.length) return { from: null, to: null, coveredDays: 0, chunks: [] };
  const { end_day: to, start_day: from } = rows[0]!;
  // Keep recent days for the short views. Fold older days into monthly grids so
  // a year never leaves 365 daily grids resident in the server process.
  const recentMonth = new Date(Date.parse(to) - 29 * DAY).toISOString().slice(0, 7);
  const oldestMonth = new Date(Date.parse(to) - 364 * DAY).toISOString().slice(0, 7);
  for (const day of days.keys()) if (day.slice(0, 7) < recentMonth) days.delete(day);
  for (const month of months.keys()) if (month < oldestMonth) months.delete(month);

  const chunks: Float64Array[] = [];
  const archived = new Map<string, typeof rows>();
  for (const row of rows) {
    const month = row.day.slice(0, 7);
    if (month >= recentMonth) {
      chunks.push(await cachedGrid(days, row.day, row.revision, () => loadDay(row.day, row.revision)));
    } else {
      const group = archived.get(month) ?? [];
      group.push(row);
      archived.set(month, group);
    }
  }
  for (const [month, group] of archived) {
    const revision = group.map(row => row.day + '/' + row.revision).join(',');
    const buildMonth = async () => {
      const combined: Grid = new Map();
      for (const row of group) mergeGrid(combined, await loadDay(row.day, row.revision));
      return packTrafficGrid(combined);
    };
    const grid = await cachedGrid(months, month, revision, () => cachedTrafficGrid(gridDirectory, month, revision, buildMonth));
    chunks.push(grid);
  }
  return { from, to, coveredDays: rows.length, chunks };
}

const snapshots = new Map<TrafficPeriod, { until: number; snapshot: Promise<Snapshot> }>();

/** Run after daily history maintenance so the first visitor reads already prepared grids. */
export async function prepareTrafficGrids() {
  const snapshot = await loadSnapshot(365);
  const retention = historyConfig.heatmapDays;
  const today = new Date().toISOString().slice(0, 10);
  const oldest = snapshot.from ?? today;
  const cutoff = retention ? new Date(Date.now() - retention * DAY).toISOString().slice(0, 10) : oldest;
  await pruneTrafficGrids(gridDirectory, oldest > cutoff ? oldest : cutoff);
}

/** Merge complete, aligned cells at overview zooms, optionally including the pan margin. */
export function trafficView(snapshot: Snapshot, bbox: Bbox, buffered = false): TrafficDensity {
  const { left, right, top, bottom, factor } = trafficWindow(bbox, buffered);
  const startX = ((left % TRAFFIC_WORLD_CELLS) + TRAFFIC_WORLD_CELLS) % TRAFFIC_WORLD_CELLS;
  const endX = startX + (right - left);
  const minY = Math.floor(top / factor), maxY = Math.ceil(bottom / factor);
  const grid = new Map<number, TrafficCell>();
  for (const entries of snapshot.chunks) {
    const start = firstEntry(entries, cellKey(0, minY * factor, 0));
    const end = firstEntry(entries, cellKey(0, maxY * factor, 0));
    for (let i = start; i < end; i += 2) {
      const key = entries[i]!;
      const index = Math.floor(key / TYPE_COUNT);
      const y = Math.floor(Math.floor(index / ROW_STRIDE) / factor);
      let x = Math.floor((index % ROW_STRIDE) / factor);
      const right = (x + 1) * factor;
      if (right <= startX) x += TRAFFIC_WORLD_CELLS / factor;
      if (x * factor >= endX || (x + 1) * factor <= startX) continue;
      const viewKey = y * ROW_STRIDE + x;
      let cell = grid.get(viewKey);
      if (!cell) {
        cell = { x, y, metres: {} };
        grid.set(viewKey, cell);
      }
      const type = TRAFFIC_TYPES[key % TYPE_COUNT]!;
      cell.metres[type] = (cell.metres[type] ?? 0) + entries[i + 1]!;
    }
  }
  for (const cell of grid.values()) {
    for (const type of Object.keys(cell.metres) as TrafficType[]) cell.metres[type] = Math.round(cell.metres[type]!);
  }
  return { from: snapshot.from, to: snapshot.to, coveredDays: snapshot.coveredDays, factor, cells: [...grid.values()] };
}

export async function trafficDensity(period: TrafficPeriod, bbox: Bbox, buffered = false): Promise<TrafficDensity> {
  let entry = snapshots.get(period);
  if (!entry || entry.until <= Date.now()) {
    const snapshot = loadSnapshot(period).catch(error => {
      if (snapshots.get(period)?.snapshot === snapshot) snapshots.delete(period);
      throw error;
    });
    entry = { until: Date.now() + 15 * 60_000, snapshot };
    snapshots.set(period, entry);
  }
  return trafficView(await entry.snapshot, bbox, buffered);
}
