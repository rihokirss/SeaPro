import type { BBox } from '@seapro/shared';
import { cache } from '../../cache.js';
import { fetchJson } from '../../http.js';
import { routingGeometryIntersectsBbox } from '../sourceGeometry.js';
import type {
  Position,
  RoutingBridgeRestriction,
  RoutingCorridor,
  RoutingFeatureSource,
  RoutingGeometry,
  RoutingHarbour,
  RoutingHazard,
  RoutingRestriction,
  RoutingSeparationZone,
  RoutingSourceMeta,
} from '../sourceTypes.js';
import {
  adaptiveBboxTiles,
  dedupeById,
  finiteNumber,
  settleMapLimit,
  sourceMeta,
  sourceStamp,
  text,
  type LoadedTile,
} from './common.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const SOURCE = 'openstreetmap-overpass' as const;
const TTL_SECONDS = 24 * 3600;
// Viimati vastanud endpoint proovitakse esimesena: kui üks peeglitest on
// ummikus (aeglane 504), ei põleta iga paan tema timeouti uuesti läbi.
let preferredEndpoint = 0;

const HAZARD_TYPES = new Set(['rock', 'obstruction', 'wreck']);
const RECOMMENDED_TYPES = new Set([
  'fairway',
  'navigation_line',
  'recommended_route_centreline',
  'recommended_track',
]);
const TRAFFIC_LANE_TYPES = new Set([
  'recommended_traffic_lane',
  'separation_lane',
  'traffic_lane',
  'two-way_route',
]);
const SEPARATION_TYPES = new Set([
  'separation_zone',
  'precautionary_area',
  'inshore_traffic_zone',
]);
const AREA_TYPES = new Set([
  'restricted_area',
  'separation_zone',
  'precautionary_area',
  'inshore_traffic_zone',
  'recommended_traffic_lane',
  'separation_lane',
  'traffic_lane',
  'two-way_route',
]);
const QUERY_TYPES = [...new Set([
  ...HAZARD_TYPES,
  ...RECOMMENDED_TYPES,
  ...TRAFFIC_LANE_TYPES,
  ...SEPARATION_TYPES,
  'bridge',
  'restricted_area',
  'harbour',
])];

interface OverpassPoint {
  lat: number;
  lon: number;
}

interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role?: string;
  geometry?: OverpassPoint[];
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OverpassPoint[];
  members?: OverpassMember[];
}

export interface OverpassRoutingResponse {
  elements?: OverpassElement[];
  /** Overpass tagastab timeout/runtime vea sageli HTTP 200 vastuse sees. */
  remark?: string;
}

export interface OsmRoutingData {
  hazards: RoutingHazard[];
  corridors: RoutingCorridor[];
  restrictions: RoutingRestriction[];
  harbours: RoutingHarbour[];
  source: RoutingSourceMeta;
}

export async function loadOsmRoutingData(bbox: BBox): Promise<OsmRoutingData> {
  const tiles = adaptiveBboxTiles(bbox, 1, 16);
  // Sisemine eelarve on allika 40 s välispiirist väiksem: eelarve täitumisel
  // katkestatakse ka pooleliolevad päringud, nii et juba laaditud paanid
  // jõuavad osalise kattena alati kohale, mitte ei kuku kõik korraga välja.
  // Concurrency 2 on avaliku Overpassi viisakuspiir; rohkem toob 429 kaela.
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), 30_000);
  const settled = await settleMapLimit(
    tiles,
    2,
    (tile) => loadTile(tile, budget.signal),
    30_000,
  ).finally(() => clearTimeout(budgetTimer));
  const loaded = settled.flatMap((result): LoadedTile<OverpassRoutingResponse>[] =>
    result.status === 'fulfilled' ? [result.value] : []);
  const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  const parsed = loaded.map((tile) => parseOsmRoutingData(tile.value, tile.stamp));
  return {
    hazards: withinBbox(dedupeById(parsed.flatMap((item) => item.hazards)), bbox),
    corridors: withinBbox(dedupeById(parsed.flatMap((item) => item.corridors)), bbox),
    restrictions: withinBbox(dedupeById(parsed.flatMap((item) => item.restrictions)), bbox),
    harbours: withinBbox(dedupeById(parsed.flatMap((item) => item.harbours)), bbox),
    source: sourceMeta({
      source: SOURCE,
      attribution: '© OpenStreetMap contributors / OpenSeaMap seamarks',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      requested: tiles.length,
      loaded,
      errors,
    }),
  };
}

function withinBbox<T extends { geometry: Parameters<typeof routingGeometryIntersectsBbox>[0] }>(
  features: T[],
  bbox: BBox,
): T[] {
  return features.filter((feature) => routingGeometryIntersectsBbox(feature.geometry, bbox));
}

async function loadTile(tile: BBox, signal?: AbortSignal): Promise<LoadedTile<OverpassRoutingResponse>> {
  const key = `routing:openstreetmap-overpass:v3:${tile.join(',')}`;
  const result = await cache.get(key, TTL_SECONDS, () => queryOverpass(expandBbox(tile, 0.25), signal));
  // Kontrolli ka stale cache-väärtust: osaline HTTP 200 vastus ei tohi muutuda
  // järgmisel laadimisel vaikimisi "täielikuks" tühjaks ohukihiks.
  validateOverpassRoutingResponse(result.value);
  return {
    value: result.value,
    stamp: sourceStamp(SOURCE, result),
    ageSeconds: result.ageSeconds,
  };
}

async function queryOverpass(
  [south, west, north, east]: BBox,
  signal?: AbortSignal,
): Promise<OverpassRoutingResponse> {
  const types = QUERY_TYPES.join('|');
  const query = `[out:json][timeout:60];
(
  node["seamark:type"~"^(${types})$"](${south},${west},${north},${east});
  way["seamark:type"~"^(${types})$"](${south},${west},${north},${east});
  relation["seamark:type"~"^(${types})$"](${south},${west},${north},${east});
  node["leisure"="marina"](${south},${west},${north},${east});
  way["leisure"="marina"](${south},${west},${north},${east});
  relation["leisure"="marina"](${south},${west},${north},${east});
);
out geom tags;`;
  let lastError: unknown;
  for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
    const index = (preferredEndpoint + attempt) % ENDPOINTS.length;
    try {
      if (signal?.aborted) break;
      const response = await fetchJson<unknown>(ENDPOINTS[index]!, {
        form: { data: query },
        // Peab mahtuma plaani 90 s tähtaja sisse ka mitme paani ja kahe
        // endpointi korral; aeglaselt rippuv peegel ei tohi plaani tappa.
        // Saarestiku 1-kraadine paan on samas päriselt raske päring.
        timeoutMs: 25_000,
        retries: 0,
        signal,
      });
      validateOverpassRoutingResponse(response);
      preferredEndpoint = index;
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Overpassi routingukihid ei vastanud: ${
    lastError instanceof Error ? lastError.message : String(lastError)
  }`);
}

export function parseOsmRoutingData(
  response: OverpassRoutingResponse,
  stamp: RoutingFeatureSource,
): Pick<OsmRoutingData, 'hazards' | 'corridors' | 'restrictions' | 'harbours'> {
  validateOverpassRoutingResponse(response);
  const hazards: RoutingHazard[] = [];
  const corridors: RoutingCorridor[] = [];
  const restrictions: RoutingRestriction[] = [];
  const harbours: RoutingHarbour[] = [];

  for (const element of response.elements) {
    const tags = element.tags ?? {};
    const seamarkType = tags['seamark:type'];
    const harbour = seamarkType === 'harbour' || tags.leisure === 'marina';
    if (!seamarkType && !harbour) continue;
    const geometry = geometryForElement(element, harbour || (seamarkType != null && AREA_TYPES.has(seamarkType)));
    if (!geometry) continue;
    const id = `openstreetmap:${element.type}/${element.id}`;
    const name = tags['seamark:name'] ?? tags.name;

    if (harbour) {
      harbours.push({
        id: `openstreetmap:harbour:${element.type}/${element.id}`,
        kind: 'harbour',
        geometry,
        name: name ?? 'Marina',
        maxDraughtM: firstLength(tags,
          'maxdraught',
          'maxdraft',
          'seamark:harbour:maxdraught',
          'seamark:harbour:maxdraft'),
        maxBeamM: firstLength(tags, 'maxwidth', 'seamark:harbour:maxwidth'),
        maxLengthM: firstLength(tags, 'maxlength', 'seamark:harbour:maxlength'),
        official: false,
        ...stamp,
      });
      continue;
    }
    if (!seamarkType) continue;

    if (HAZARD_TYPES.has(seamarkType)) {
      const dimensions = [
        parseLengthMetres(tags[`seamark:${seamarkType}:length`]),
        parseLengthMetres(tags[`seamark:${seamarkType}:width`]),
      ].filter((value): value is number => value !== undefined);
      hazards.push({
        id,
        kind: seamarkType as RoutingHazard['kind'],
        geometry,
        name: name ?? seamarkType,
        depthM: firstLength(tags,
          `seamark:${seamarkType}:least_depth`,
          `seamark:${seamarkType}:depth`,
          'depth'),
        sizeM: dimensions.length ? Math.max(...dimensions) : undefined,
        heightM: parseLengthMetres(tags[`seamark:${seamarkType}:height`]),
        confidence: 'low',
        category: tags[`seamark:${seamarkType}:category`],
        waterLevelCode: tags[`seamark:${seamarkType}:water_level`],
        ...stamp,
      });
      continue;
    }

    if (RECOMMENDED_TYPES.has(seamarkType) || TRAFFIC_LANE_TYPES.has(seamarkType)) {
      const kind: RoutingCorridor['kind'] = TRAFFIC_LANE_TYPES.has(seamarkType)
        ? 'traffic_lane'
        : 'recommended';
      corridors.push({
        id,
        kind,
        geometry,
        geometryRole: geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'
          ? 'area'
          : 'centreline',
        name,
        depthM: firstLength(tags,
          `seamark:${seamarkType}:depth`,
          'depth'),
        widthM: firstLength(tags,
          `seamark:${seamarkType}:width`,
          'width'),
        directionDegrees: orientation(tags, seamarkType),
        direction: seamarkType === 'two-way_route' ? 'two_way' : orientation(tags, seamarkType) !== undefined
          ? 'one_way'
          : 'unknown',
        official: false,
        category: seamarkType,
        ...stamp,
      });
      continue;
    }

    if (seamarkType === 'bridge') {
      restrictions.push(parseBridge(id, geometry, tags, stamp));
      continue;
    }

    if (seamarkType === 'restricted_area') {
      restrictions.push(parseRestrictedArea(id, geometry, tags, stamp));
      continue;
    }

    if (SEPARATION_TYPES.has(seamarkType)) {
      restrictions.push({
        id,
        kind: 'separation_zone',
        geometry,
        name,
        category: seamarkType,
        directionDegrees: orientation(tags, seamarkType),
        ...stamp,
      } satisfies RoutingSeparationZone);
    }
  }

  return { hazards, corridors, restrictions, harbours };
}

export function validateOverpassRoutingResponse(
  response: unknown,
): asserts response is OverpassRoutingResponse & { elements: OverpassElement[] } {
  if (!response || typeof response !== 'object') {
    throw new Error('Overpassi vastus ei ole JSON-objekt');
  }
  const candidate = response as OverpassRoutingResponse;
  if (typeof candidate.remark === 'string' && candidate.remark.trim()) {
    throw new Error(`Overpass tagastas osalise vastuse: ${candidate.remark.trim().slice(0, 300)}`);
  }
  if (!Array.isArray(candidate.elements)) {
    throw new Error('Overpassi vastusest puudub elements massiiv');
  }
}

function parseBridge(
  id: string,
  geometry: RoutingGeometry,
  tags: Record<string, string>,
  stamp: RoutingFeatureSource,
): RoutingBridgeRestriction {
  const category = tags['seamark:bridge:category'];
  return {
    id,
    kind: 'bridge',
    geometry,
    name: tags['seamark:name'] ?? tags.name ?? 'Sild',
    description: category,
    maxHeightM: firstLength(tags,
      'seamark:bridge:clearance_height_closed',
      'seamark:bridge:clearance_height',
      'maxheight'),
    maxBeamM: firstLength(tags,
      'seamark:bridge:clearance_width',
      'maxwidth'),
    opens: Boolean(category && /opening|lifting|swing|bascule|drawbridge/i.test(category)),
    ...stamp,
  };
}

function parseRestrictedArea(
  id: string,
  geometry: RoutingGeometry,
  tags: Record<string, string>,
  stamp: RoutingFeatureSource,
): RoutingRestriction {
  const rule = tags['seamark:restricted_area:restriction']
    ?? tags['seamark:restricted_area:category'];
  const rules = rule?.split(/[;,]/).map((value) => value.trim()).filter(Boolean);
  return {
    id,
    kind: 'restricted_area',
    geometry,
    name: tags['seamark:name'] ?? tags.name ?? 'Piiranguala',
    description: tags.description,
    rule,
    ruleCodes: rules,
    prohibited: Boolean(rule && /(^|[_\s])(entry|navigation)[_\s-]?prohibited|no[_\s-]?entry/i.test(rule)),
    ...stamp,
  };
}

function geometryForElement(element: OverpassElement, area: boolean): RoutingGeometry | null {
  if (element.type === 'node') {
    return Number.isFinite(element.lon) && Number.isFinite(element.lat)
      ? { type: 'Point', coordinates: [element.lon!, element.lat!] }
      : null;
  }
  if (element.type === 'way') return geometryFromWay(element.geometry, area);
  return geometryFromRelation(element.members, area);
}

function geometryFromWay(points: OverpassPoint[] | undefined, area: boolean): RoutingGeometry | null {
  const line = coordinates(points);
  if (line.length < 2) return null;
  if (area && line.length >= 4 && samePoint(line[0], line.at(-1))) {
    return { type: 'Polygon', coordinates: [line] };
  }
  return { type: 'LineString', coordinates: line };
}

function geometryFromRelation(
  members: OverpassMember[] | undefined,
  area: boolean,
): RoutingGeometry | null {
  const segments = (members ?? [])
    .filter((member) => member.type === 'way' && member.role !== 'inner')
    .map((member) => coordinates(member.geometry))
    .filter((line) => line.length >= 2);
  if (!segments.length) return null;
  const lines = joinSegments(segments);
  if (area) {
    const rings = lines.filter((line) => line.length >= 4 && samePoint(line[0], line.at(-1)));
    if (rings.length) return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
  }
  return { type: 'MultiLineString', coordinates: lines };
}

function joinSegments(input: Position[][]): Position[][] {
  const pending = input.map((line) => [...line]);
  const joined: Position[][] = [];
  while (pending.length) {
    const line = pending.shift()!;
    let changed = true;
    while (changed) {
      changed = false;
      const start = line[0];
      const end = line.at(-1);
      const index = pending.findIndex((candidate) =>
        samePoint(end, candidate[0]) || samePoint(end, candidate.at(-1))
        || samePoint(start, candidate.at(-1)) || samePoint(start, candidate[0]));
      if (index < 0) continue;
      const candidate = pending.splice(index, 1)[0]!;
      if (samePoint(end, candidate[0])) line.push(...candidate.slice(1));
      else if (samePoint(end, candidate.at(-1))) line.push(...candidate.reverse().slice(1));
      else if (samePoint(start, candidate.at(-1))) line.unshift(...candidate.slice(0, -1));
      else line.unshift(...candidate.reverse().slice(0, -1));
      changed = true;
    }
    joined.push(line);
  }
  return joined;
}

function coordinates(points: OverpassPoint[] | undefined): Position[] {
  return (points ?? []).flatMap((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat)
    ? [[point.lon, point.lat] as Position]
    : []);
}

function samePoint(a: Position | undefined, b: Position | undefined): boolean {
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
}

function orientation(tags: Record<string, string>, seamarkType: string): number | undefined {
  const value = finiteNumber(tags[`seamark:${seamarkType}:orientation`]
    ?? tags['seamark:orientation']);
  return value === undefined ? undefined : ((value % 360) + 360) % 360;
}

function firstLength(tags: Record<string, string>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = parseLengthMetres(tags[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * OSM-i mõõt koos ühikuga. Tundmatu või segase sufiksiga väärtust ei tohi
 * meetriteks oletada; ühikuta arv on OSM-i length-väljade reegli järgi meeter.
 */
export function parseLengthMetres(value: unknown): number | undefined {
  const raw = text(value)?.trim().toLowerCase();
  if (!raw) return undefined;
  const decimal = String.raw`(?:\d+(?:[.,]\d+)?|[.,]\d+)`;
  const feetAndInches = raw.match(new RegExp(
    String.raw`^(${decimal})\s*(?:ft|feet|foot|'|′)\s*(?:(${decimal})\s*(?:in|inches|inch|"|″))?$`,
    'i',
  ));
  if (feetAndInches) {
    const feet = Number(feetAndInches[1]!.replace(',', '.'));
    const inches = feetAndInches[2] ? Number(feetAndInches[2].replace(',', '.')) : 0;
    return positiveMetres(feet * 0.3048 + inches * 0.0254);
  }

  const simple = raw.match(new RegExp(
    String.raw`^(${decimal})\s*(mm|cm|km|m|ft|feet|foot|'|′|in|inches|inch|"|″)?$`,
    'i',
  ));
  if (!simple) return undefined;
  const amount = Number(simple[1]!.replace(',', '.'));
  const unit = simple[2]?.toLowerCase() ?? 'm';
  const multiplier = unit === 'km' ? 1_000
    : unit === 'cm' ? 0.01
      : unit === 'mm' ? 0.001
        : unit === 'ft' || unit === 'feet' || unit === 'foot' || unit === "'" || unit === '′'
          ? 0.3048
          : unit === 'in' || unit === 'inch' || unit === 'inches' || unit === '"' || unit === '″'
            ? 0.0254
            : 1;
  return positiveMetres(amount * multiplier);
}

function positiveMetres(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function expandBbox([south, west, north, east]: BBox, margin: number): BBox {
  return [south - margin, west - margin, north + margin, east + margin];
}
