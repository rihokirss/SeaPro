import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BBox } from '@seapro/shared';
import { config } from '../config.js';
import {
  TRUSTED_ROUTE_CLEARED_REASONS,
  type RoutingCostSurface,
  type RoutingReasonCode,
} from './costSurface.js';
import type { RoutingCell } from './engineTypes.js';
import type { HarbourAccessSupport } from './harbourAccess.js';
import type {
  Position,
  RoutingCorridor,
  RoutingSourceId,
} from './sourceTypes.js';

export const PREPARED_ROUTING_GRAPH_VERSION = 'seapro-routing-graph-v1' as const;
const ENDPOINT_SNAP_M = 5;
const NODE_SNAP_M = 0.5;
// 1° pikkuskraadi on teenusala põhjaservas (66,2° N) ~45 km. Suurem jagaja
// teeks naabriotsingu puhvri seal snap-kaugusest kitsamaks ja ±1 skann võiks
// kaks kokkukuuluvat punkti vahele jätta.
const SNAP_BUCKET_METRES_PER_DEGREE = 44_000;
const INTERSECTION_BUCKET_DEGREES = 0.02;
const DEFAULT_MAX_EDGE_LENGTH_M = 150;
const EPSILON = 1e-10;
// Valitud keskjoon peab võitma ka soovitusliku ala (preferred = 0.7); väiksem
// väärtus hoiab lihtsustuse joone peal ega lase tal üldisele rastrile hüpata.
const TRUSTED_PATH_COST_MULTIPLIER = 0.55;

export interface PreparedRoutingGraphNode {
  id: number;
  position: Position;
}

export interface PreparedRoutingGraphEdge {
  id: string;
  from: number;
  to: number;
  official: boolean;
  sourceIds: RoutingSourceId[];
  sourceFeatureIds: string[];
  depthM?: number;
  maxDraughtM?: number;
  widthM?: number;
}

export interface PreparedRoutingGraph {
  version: typeof PREPARED_ROUTING_GRAPH_VERSION;
  builtAt: string;
  bbox: BBox;
  nodes: PreparedRoutingGraphNode[];
  edges: PreparedRoutingGraphEdge[];
  /** Sadamaotste tuletamiseks vajalik kompaktne staatiline tugi. */
  harbourAccessSupport?: HarbourAccessSupport;
  stats: {
    inputCorridors: number;
    inputLines: number;
    rejectedLines: number;
    duplicateLines: number;
    intersections: number;
    snappedEndpoints: number;
  };
}

export interface PreparedPathLine {
  points: readonly { x: number; y: number; position?: Position }[];
  kind: 'official' | 'recommended';
  sourceIds: readonly RoutingSourceId[];
}

interface SourceLine {
  id: string;
  coordinates: Position[];
  corridor: RoutingCorridor;
}

interface RawSegment {
  id: number;
  line: SourceLine;
  from: Position;
  to: Position;
  splits: number[];
}

interface EndpointRef {
  line: SourceLine;
  index: 0 | -1;
  position: Position;
}

/**
 * Muudab eri allikate keskjooned deterministlikuks topoloogiagraafiks.
 * Runtime ei pea enam paani-, objekti- ega võrerakupiiridel juppe ühendama.
 */
export function buildPreparedRoutingGraph(
  corridors: readonly RoutingCorridor[],
  bbox: BBox,
  builtAt = new Date().toISOString(),
  options: {
    maxEdgeLengthM?: number;
    harbourAccessSupport?: HarbourAccessSupport;
  } = {},
): PreparedRoutingGraph {
  const extracted = extractSourceLines(corridors);
  const endpointResult = snapCoincidentEndpoints(extracted.lines);
  const segments = sourceSegments(
    extracted.lines,
    options.maxEdgeLengthM ?? DEFAULT_MAX_EDGE_LENGTH_M,
  );
  const intersections = splitAtIntersections(segments);
  const assembled = assembleGraph(segments);
  return {
    version: PREPARED_ROUTING_GRAPH_VERSION,
    builtAt,
    bbox: [...bbox],
    nodes: assembled.nodes,
    edges: assembled.edges,
    ...(options.harbourAccessSupport
      ? { harbourAccessSupport: options.harbourAccessSupport }
      : {}),
    stats: {
      inputCorridors: corridors.length,
      inputLines: extracted.inputLines,
      rejectedLines: extracted.rejectedLines,
      duplicateLines: extracted.duplicateLines,
      intersections,
      snappedEndpoints: endpointResult,
    },
  };
}

export async function writePreparedRoutingGraph(
  graph: PreparedRoutingGraph,
  file = config.routingGraphFile,
): Promise<string> {
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(graph)}\n`, 'utf8');
  await rename(temporary, target);
  preparedCache = { path: target, mtimeMs: (await stat(target)).mtimeMs, graph };
  return target;
}

let preparedCache: { path: string; mtimeMs: number; graph: PreparedRoutingGraph } | null = null;

export async function loadPreparedRoutingGraph(
  file = config.routingGraphFile,
): Promise<PreparedRoutingGraph | null> {
  const target = resolve(file);
  let fileStat;
  try {
    fileStat = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (preparedCache?.path === target && preparedCache.mtimeMs === fileStat.mtimeMs) {
    return preparedCache.graph;
  }
  const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
  assertPreparedRoutingGraph(parsed);
  preparedCache = { path: target, mtimeMs: fileStat.mtimeMs, graph: parsed };
  return parsed;
}

interface PreparedGraphGeoJsonCache {
  features: ReturnType<typeof edgeFeature>[];
  /** Serva kohta minLon, minLat, maxLon, maxLat vaateakna filtrile. */
  bounds: Float64Array;
}

// Graaf on mtime-vahemälus muutumatu; sajatuhandelise servahulga Feature'ite
// ja bbox-piiride taasarvutamine igal kaardiliigutusel blokeeriks event-loopi.
const geoJsonCache = new WeakMap<PreparedRoutingGraph, PreparedGraphGeoJsonCache>();

export function preparedGraphGeoJson(graph: PreparedRoutingGraph, bbox?: BBox) {
  let cached = geoJsonCache.get(graph);
  if (!cached) {
    const features = graph.edges.map((edge) => edgeFeature(graph, edge));
    const bounds = new Float64Array(graph.edges.length * 4);
    for (const [index, edge] of graph.edges.entries()) {
      const [fromLon, fromLat] = graph.nodes[edge.from]!.position;
      const [toLon, toLat] = graph.nodes[edge.to]!.position;
      bounds[index * 4] = Math.min(fromLon, toLon);
      bounds[index * 4 + 1] = Math.min(fromLat, toLat);
      bounds[index * 4 + 2] = Math.max(fromLon, toLon);
      bounds[index * 4 + 3] = Math.max(fromLat, toLat);
    }
    cached = { features, bounds };
    geoJsonCache.set(graph, cached);
  }
  if (!bbox) return { type: 'FeatureCollection' as const, features: cached.features };
  const [south, west, north, east] = bbox;
  const { bounds } = cached;
  return {
    type: 'FeatureCollection' as const,
    features: cached.features.filter((_feature, index) =>
      bounds[index * 4]! <= east && bounds[index * 4 + 2]! >= west
        && bounds[index * 4 + 1]! <= north && bounds[index * 4 + 3]! >= south),
  };
}

function edgeFeature(graph: PreparedRoutingGraph, edge: PreparedRoutingGraphEdge) {
  return {
    type: 'Feature' as const,
    id: edge.id,
    geometry: {
      type: 'LineString' as const,
      coordinates: [graph.nodes[edge.from]!.position, graph.nodes[edge.to]!.position],
    },
    properties: {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.official ? 'official' as const : 'recommended' as const,
      official: edge.official,
      sources: edge.sourceIds.join(','),
      features: edge.sourceFeatureIds.join(','),
    },
  };
}

const PREPARED_PATH_BASE_REASONS = new Set<RoutingReasonCode>(TRUSTED_ROUTE_CLEARED_REASONS);
/**
 * Väikelaeva puhul on konkreetselt valitud valmis keskjoon ise läbitav.
 *
 * Seda vaadet kasutatakse ainult juba leitud teekonna kirjeldamisel ja
 * lihtsustamisel. Kogu graafi korraga avamine lubaks tavalisel võreotsingul
 * mööda naaberväylade rasterrakke uusi ühendusi leiutada.
 */
export function trustPreparedPathOnSurface(
  surface: RoutingCostSurface,
  paths: readonly PreparedPathLine[],
): RoutingCostSurface {
  if (!paths.some((path) => path.points.length >= 2)) return surface;
  const trusted = new Map<number, { official: boolean; sourceIds: Set<RoutingSourceId> }>();
  for (const path of paths) {
    for (let index = 1; index < path.points.length; index++) {
      const from = path.points[index - 1]!;
      const to = path.points[index]!;
      const steps = Math.max(1, Math.ceil(Math.max(
        Math.abs(to.x - from.x),
        Math.abs(to.y - from.y),
      ) * 4));
      for (let step = 0; step <= steps; step++) {
        const ratio = step / steps;
        const x = Math.round(from.x + (to.x - from.x) * ratio);
        const y = Math.round(from.y + (to.y - from.y) * ratio);
        // Supercover kontroll puudutab täpselt nurka läbides ka kaht külgrakku.
        // Üherakuline puhver katab sama juhtumi, aga jääb ainult valitud joonele.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const cellX = x + dx;
            const cellY = y + dy;
            if (cellX >= 0 && cellX < surface.width && cellY >= 0 && cellY < surface.height) {
              const cell = cellY * surface.width + cellX;
              const metadata = trusted.get(cell) ?? { official: false, sourceIds: new Set() };
              metadata.official ||= path.kind === 'official';
              for (const sourceId of path.sourceIds) metadata.sourceIds.add(sourceId);
              trusted.set(cell, metadata);
            }
          }
        }
      }
    }
  }
  const metadataAt = (x: number, y: number) => trusted.get(y * surface.width + x);
  const retainedReasons = (reasons: readonly string[] | undefined): string[] =>
    (reasons ?? []).filter((reason) => !PREPARED_PATH_BASE_REASONS.has(reason as RoutingReasonCode));
  // Lihtsustus ja kirjeldus loevad sama usaldatud rakku korduvalt; ilma memota
  // ehitaks iga päring uue rakuobjekti ja mööduks aluspinna enda vahemälust.
  const trustedCells = new Map<number, RoutingCell>();
  return {
    ...surface,
    minimumCostMultiplier: Math.min(
      surface.minimumCostMultiplier ?? TRUSTED_PATH_COST_MULTIPLIER,
      TRUSTED_PATH_COST_MULTIPLIER,
    ),
    cellAt(x, y) {
      const metadata = metadataAt(x, y);
      if (!metadata) return surface.cellAt(x, y);
      const id = y * surface.width + x;
      const memo = trustedCells.get(id);
      if (memo) return memo;
      const cell = surface.cellAt(x, y);
      const reasons = retainedReasons(cell.reasons);
      appendUnique(reasons, metadata.official ? 'official_corridor' : 'recommended_route');
      const trustedCell: RoutingCell = {
        blocked: false,
        costMultiplier: Math.min(cell.costMultiplier, TRUSTED_PATH_COST_MULTIPLIER),
        risk: reasons.every((reason) => reason === 'official_corridor' || reason === 'recommended_route')
          ? 'clear'
          : cell.risk,
        reasons,
      };
      trustedCells.set(id, trustedCell);
      return trustedCell;
    },
    detailsAt(x, y) {
      const details = surface.detailsAt(x, y);
      const metadata = metadataAt(x, y);
      if (!metadata) return details;
      const reasons = retainedReasons(details.reasons) as RoutingReasonCode[];
      appendUnique(reasons, metadata.official ? 'official_corridor' : 'recommended_route');
      return {
        ...details,
        blocked: false,
        costMultiplier: Math.min(details.costMultiplier, TRUSTED_PATH_COST_MULTIPLIER),
        risk: reasons.every((reason) => reason === 'official_corridor' || reason === 'recommended_route')
          ? 'clear'
          : details.risk,
        reasons,
        sourceIds: [...new Set([...details.sourceIds, ...metadata.sourceIds])].sort(),
      };
    },
  };
}

function extractSourceLines(corridors: readonly RoutingCorridor[]): {
  lines: SourceLine[];
  inputLines: number;
  rejectedLines: number;
  duplicateLines: number;
} {
  const lines: SourceLine[] = [];
  const seen = new Set<string>();
  let inputLines = 0;
  let rejectedLines = 0;
  let duplicateLines = 0;
  for (const corridor of [...corridors].sort((a, b) =>
    Number(b.official) - Number(a.official) || a.id.localeCompare(b.id))) {
    if (!eligibleCorridor(corridor)) continue;
    const sourceLines = corridor.geometry.type === 'LineString'
      ? [corridor.geometry.coordinates]
      : corridor.geometry.type === 'MultiLineString' ? corridor.geometry.coordinates : [];
    for (const [lineIndex, raw] of sourceLines.entries()) {
      inputLines++;
      const coordinates = cleanLine(raw);
      if (coordinates.length < 2 || samePosition(coordinates[0]!, coordinates.at(-1)!)) {
        rejectedLines++;
        continue;
      }
      const key = canonicalLineKey(coordinates);
      if (seen.has(key)) {
        duplicateLines++;
        continue;
      }
      seen.add(key);
      lines.push({ id: `${corridor.id}:${lineIndex}`, coordinates, corridor });
    }
  }
  return { lines, inputLines, rejectedLines, duplicateLines };
}

/** Kas keskjoon kuulub valmis graafi (ja on runtime-vektorites seega liigne). */
export function eligibleCorridor(corridor: RoutingCorridor): boolean {
  if (corridor.harbourAccess || corridor.kind === 'traffic_lane') return false;
  if (corridor.geometryRole !== 'centreline') return false;
  if (corridor.category === 'navigation_line') return false;
  return corridor.geometry.type === 'LineString' || corridor.geometry.type === 'MultiLineString';
}

function cleanLine(raw: readonly Position[]): Position[] {
  const result: Position[] = [];
  const seen = new Set<string>();
  for (const point of raw) {
    if (!validPosition(point)) continue;
    const copy: Position = [point[0], point[1]];
    if (result.length && samePosition(result.at(-1)!, copy)) continue;
    const key = positionKey(copy);
    // Korduv sisemine koordinaat tekitab silmuse. Terve vigane objekt jääb
    // graafist välja; selle esimese haru säilitamine looks allikas puuduva
    // tehisliku terminali.
    if (seen.has(key)) return [];
    seen.add(key);
    result.push(copy);
  }
  return result;
}

function snapCoincidentEndpoints(lines: SourceLine[]): number {
  const endpoints: EndpointRef[] = lines.flatMap((line): EndpointRef[] => [
    { line, index: 0, position: line.coordinates[0]! },
    { line, index: -1, position: line.coordinates.at(-1)! },
  ]);
  const parent = endpoints.map((_entry, index) => index);
  const buckets = new Map<string, number[]>();
  const step = ENDPOINT_SNAP_M / SNAP_BUCKET_METRES_PER_DEGREE;
  for (const [index, endpoint] of endpoints.entries()) {
    const bx = Math.floor(endpoint.position[0] / step);
    const by = Math.floor(endpoint.position[1] / step);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const other of buckets.get(`${bx + dx}:${by + dy}`) ?? []) {
          if (distanceM(endpoint.position, endpoints[other]!.position) <= ENDPOINT_SNAP_M) {
            union(parent, index, other);
          }
        }
      }
    }
    const key = `${bx}:${by}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < endpoints.length; index++) {
    const root = find(parent, index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }
  let snapped = 0;
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const preferred = [...indexes].sort((a, b) => compareEndpoint(endpoints[a]!, endpoints[b]!))[0]!;
    const canonical: Position = [...endpoints[preferred]!.position];
    for (const index of indexes) {
      const endpoint = endpoints[index]!;
      if (!samePosition(endpoint.position, canonical)) snapped++;
      if (endpoint.index === 0) endpoint.line.coordinates[0] = [...canonical];
      else endpoint.line.coordinates[endpoint.line.coordinates.length - 1] = [...canonical];
    }
  }
  return snapped;
}

function compareEndpoint(a: EndpointRef, b: EndpointRef): number {
  return Number(b.line.corridor.official) - Number(a.line.corridor.official)
    || a.line.corridor.source.localeCompare(b.line.corridor.source)
    || a.line.id.localeCompare(b.line.id)
    || a.position[0] - b.position[0]
    || a.position[1] - b.position[1];
}

function sourceSegments(lines: readonly SourceLine[], maxEdgeLengthM: number): RawSegment[] {
  const segments: RawSegment[] = [];
  for (const line of lines) {
    for (let index = 1; index < line.coordinates.length; index++) {
      const from = line.coordinates[index - 1]!;
      const to = line.coordinates[index]!;
      if (samePosition(from, to)) continue;
      const steps = Number.isFinite(maxEdgeLengthM)
        ? Math.max(1, Math.ceil(distanceM(from, to) / maxEdgeLengthM))
        : 1;
      segments.push({
        id: segments.length,
        line,
        from,
        to,
        splits: Array.from({ length: steps + 1 }, (_value, step) => step / steps),
      });
    }
  }
  return segments;
}

function splitAtIntersections(segments: RawSegment[]): number {
  const buckets = new Map<string, number[]>();
  for (const segment of segments) {
    const minLon = Math.min(segment.from[0], segment.to[0]);
    const maxLon = Math.max(segment.from[0], segment.to[0]);
    const minLat = Math.min(segment.from[1], segment.to[1]);
    const maxLat = Math.max(segment.from[1], segment.to[1]);
    const minX = Math.floor(minLon / INTERSECTION_BUCKET_DEGREES);
    const maxX = Math.floor(maxLon / INTERSECTION_BUCKET_DEGREES);
    const minY = Math.floor(minLat / INTERSECTION_BUCKET_DEGREES);
    const maxY = Math.floor(maxLat / INTERSECTION_BUCKET_DEGREES);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = `${x}:${y}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(segment.id);
        buckets.set(key, bucket);
      }
    }
  }
  const compared = new Set<string>();
  let intersections = 0;
  for (const ids of buckets.values()) {
    for (let left = 0; left < ids.length; left++) {
      for (let right = left + 1; right < ids.length; right++) {
        const a = segments[ids[left]!]!;
        const b = segments[ids[right]!]!;
        const pair = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (compared.has(pair)) continue;
        compared.add(pair);
        if (a.line === b.line && segmentsAreAdjacent(a, b)) continue;
        const hit = segmentIntersection(a.from, a.to, b.from, b.to);
        if (!hit) continue;
        if (hit.t > EPSILON && hit.t < 1 - EPSILON) addSplit(a.splits, hit.t);
        if (hit.u > EPSILON && hit.u < 1 - EPSILON) addSplit(b.splits, hit.u);
        if (hit.t > EPSILON && hit.t < 1 - EPSILON
          || hit.u > EPSILON && hit.u < 1 - EPSILON) intersections++;
      }
    }
  }
  return intersections;
}

function assembleGraph(segments: readonly RawSegment[]): {
  nodes: PreparedRoutingGraphNode[];
  edges: PreparedRoutingGraphEdge[];
} {
  const nodeBuckets = new Map<string, number[]>();
  const nodes: PreparedRoutingGraphNode[] = [];
  const edges = new Map<string, PreparedRoutingGraphEdge>();
  const nodeFor = (position: Position): number => {
    const step = NODE_SNAP_M / SNAP_BUCKET_METRES_PER_DEGREE;
    const bx = Math.floor(position[0] / step);
    const by = Math.floor(position[1] / step);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const id of nodeBuckets.get(`${bx + dx}:${by + dy}`) ?? []) {
          if (distanceM(position, nodes[id]!.position) <= NODE_SNAP_M) return id;
        }
      }
    }
    const id = nodes.length;
    nodes.push({ id, position: [...position] });
    const key = `${bx}:${by}`;
    const bucket = nodeBuckets.get(key) ?? [];
    bucket.push(id);
    nodeBuckets.set(key, bucket);
    return id;
  };

  for (const segment of segments) {
    const splits = [...segment.splits].sort((a, b) => a - b);
    for (let index = 1; index < splits.length; index++) {
      const fromPosition = interpolate(segment.from, segment.to, splits[index - 1]!);
      const toPosition = interpolate(segment.from, segment.to, splits[index]!);
      const from = nodeFor(fromPosition);
      const to = nodeFor(toPosition);
      if (from === to) continue;
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const corridor = segment.line.corridor;
      const existing = edges.get(key);
      if (existing) {
        existing.official ||= corridor.official;
        appendUnique(existing.sourceIds, corridor.source);
        appendUnique(existing.sourceFeatureIds, corridor.id);
        existing.depthM = maximumDefined(existing.depthM, corridor.sweptDepthM ?? corridor.depthM);
        existing.maxDraughtM = maximumDefined(existing.maxDraughtM, corridor.maxDraughtM);
        existing.widthM = maximumDefined(existing.widthM, corridor.widthM);
        continue;
      }
      edges.set(key, {
        id: `edge-${key}`,
        from,
        to,
        official: corridor.official,
        sourceIds: [corridor.source],
        sourceFeatureIds: [corridor.id],
        ...optionalNumber('depthM', corridor.sweptDepthM ?? corridor.depthM),
        ...optionalNumber('maxDraughtM', corridor.maxDraughtM),
        ...optionalNumber('widthM', corridor.widthM),
      });
    }
  }
  return { nodes, edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

function segmentIntersection(a: Position, b: Position, c: Position, d: Position): {
  t: number;
  u: number;
} | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= EPSILON) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
  return { t: clamp01(t), u: clamp01(u) };
}

function segmentsAreAdjacent(a: RawSegment, b: RawSegment): boolean {
  return samePosition(a.from, b.from) || samePosition(a.from, b.to)
    || samePosition(a.to, b.from) || samePosition(a.to, b.to);
}

function addSplit(splits: number[], value: number): void {
  if (!splits.some((candidate) => Math.abs(candidate - value) <= EPSILON)) splits.push(value);
}

function interpolate(from: Position, to: Position, ratio: number): Position {
  return [
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
  ];
}

function canonicalLineKey(line: readonly Position[]): string {
  const forward = line.map(positionKey).join(';');
  const reverse = [...line].reverse().map(positionKey).join(';');
  return forward < reverse ? forward : reverse;
}

function positionKey(position: Position): string {
  return `${position[0].toFixed(8)},${position[1].toFixed(8)}`;
}

function samePosition(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

function validPosition(position: Position): boolean {
  return Number.isFinite(position[0]) && Number.isFinite(position[1])
    && position[0] >= -180 && position[0] <= 180
    && position[1] >= -90 && position[1] <= 90;
}

export function distanceM(a: Position, b: Position): number {
  const lat = (a[1] + b[1]) * Math.PI / 360;
  const x = (a[0] - b[0]) * 111_320 * Math.cos(lat);
  const y = (a[1] - b[1]) * 110_574;
  return Math.hypot(x, y);
}

function union(parent: number[], a: number, b: number): void {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
}

function find(parent: number[], index: number): number {
  let root = index;
  while (parent[root] !== root) root = parent[root]!;
  while (parent[index] !== index) {
    const next = parent[index]!;
    parent[index] = root;
    index = next;
  }
  return root;
}

function appendUnique<T>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
}

function maximumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function optionalNumber<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, number>>;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function assertPreparedRoutingGraph(value: unknown): asserts value is PreparedRoutingGraph {
  if (!value || typeof value !== 'object') throw new Error('Routingugraafi fail ei ole JSON-objekt');
  const graph = value as Partial<PreparedRoutingGraph>;
  if (graph.version !== PREPARED_ROUTING_GRAPH_VERSION) {
    throw new Error(`Routingugraafi versioon ei sobi: ${String(graph.version)}`);
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.bbox)) {
    throw new Error('Routingugraafi fail on poolik');
  }
  if (graph.harbourAccessSupport !== undefined
    && (!graph.harbourAccessSupport || typeof graph.harbourAccessSupport !== 'object'
      || !Array.isArray(graph.harbourAccessSupport.harbours)
      || !Array.isArray(graph.harbourAccessSupport.hazards)
      || !Array.isArray(graph.harbourAccessSupport.corridors))) {
    throw new Error('Routingugraafi sadamatoe plokk on vigane');
  }
  for (const [index, node] of graph.nodes.entries()) {
    if (node?.id !== index || !Array.isArray(node.position) || !validPosition(node.position)) {
      throw new Error(`Routingugraafi sõlm ${index} on vigane`);
    }
  }
  for (const edge of graph.edges) {
    if (!Number.isInteger(edge?.from) || !Number.isInteger(edge?.to)
      || !graph.nodes[edge.from] || !graph.nodes[edge.to]
      || edge.from === edge.to || typeof edge.official !== 'boolean') {
      throw new Error(`Routingugraafi serv ${edge?.id ?? '?'} on vigane`);
    }
  }
}
