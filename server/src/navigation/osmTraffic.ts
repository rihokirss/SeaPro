import type { TrafficScheme, TrafficSchemeKind } from '@seapro/shared';
import { loadOsmRoutingTileSnapshot } from '../routing/sources/osm.js';

/**
 * OpenSeaMapi raster sisaldab ühes pildis nii poisid kui liiklusskeemid.
 * Siin küsime samast OSM-i algandmest ainult liikluse korraldamise objektid,
 * et ametlike navimärkide kõrvale ei tekiks dubleerivaid rasterpoide.
 */

const TRAFFIC_KINDS = new Set<TrafficSchemeKind>([
  'separation_lane',
  'separation_zone',
  'separation_boundary',
  'separation_line',
  'separation_crossing',
  'separation_roundabout',
  'inshore_traffic_zone',
  'precautionary_area',
  'navigation_line',
  'recommended_route_centreline',
  'recommended_track',
  'recommended_traffic_lane',
  'two-way_route',
  'traffic_lane',
]);

const AREA_KINDS = new Set<TrafficSchemeKind>([
  'separation_lane',
  'separation_zone',
  'separation_crossing',
  'separation_roundabout',
  'inshore_traffic_zone',
  'precautionary_area',
  'recommended_traffic_lane',
  'two-way_route',
  'traffic_lane',
]);

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
  tags?: Record<string, string>;
  geometry?: OverpassPoint[];
  members?: OverpassMember[];
}

export interface OverpassTrafficResponse {
  elements?: OverpassElement[];
}

export async function fetchTrafficSchemes(
  bbox: [number, number, number, number],
): Promise<TrafficScheme[]> {
  return (await fetchTrafficSchemesSnapshot(bbox)).trafficSchemes;
}

export interface TrafficSchemeSnapshot {
  trafficSchemes: TrafficScheme[];
  fetchedAt: string;
  ageSeconds: number;
  stale: boolean;
}

/** Sama cache-kirje koos ehitatava staatilise routingugraafi lähteinfoga. */
export async function fetchTrafficSchemesSnapshot(
  bbox: [number, number, number, number],
): Promise<TrafficSchemeSnapshot> {
  // Routing ja kaardikiht kasutavad samu kanoonilisi 1° raw-paanikirjeid.
  // ROUTING_PREWARM saab need taustal ette laadida ning kaardi liigutamine ei
  // tekita enam iga veidi erineva bbox'i jaoks uut suurt Overpassi päringut.
  const snapshot = await loadOsmRoutingTileSnapshot(bbox);
  if (snapshot.loaded.length === 0) {
    throw snapshot.errors[0] ?? new Error('OSM-i liiklusskeemide paane ei laaditud');
  }

  const merged = new Map<string, TrafficScheme>();
  for (const tile of snapshot.loaded) {
    for (const scheme of parseTrafficSchemes(tile.value)) merged.set(scheme.id, scheme);
  }
  const oldest = snapshot.loaded.reduce((result, tile) =>
    tile.ageSeconds > result.ageSeconds ? tile : result);
  return {
    trafficSchemes: [...merged.values()],
    fetchedAt: oldest.stamp.fetchedAt,
    ageSeconds: oldest.ageSeconds,
    stale: snapshot.loaded.some((tile) => tile.stamp.stale),
  };
}

export function parseTrafficSchemes(response: OverpassTrafficResponse): TrafficScheme[] {
  return (response.elements ?? []).flatMap((element): TrafficScheme[] => {
    const kind = element.tags?.['seamark:type'] as TrafficSchemeKind | undefined;
    if (!kind || !TRAFFIC_KINDS.has(kind)) return [];

    const geometry = element.type === 'way'
      ? geometryFromWay(element.geometry, AREA_KINDS.has(kind))
      : geometryFromRelation(element.members, AREA_KINDS.has(kind));
    if (!geometry) return [];

    const orientationRaw = element.tags?.[`seamark:${kind}:orientation`]
      ?? element.tags?.['seamark:orientation'];
    const orientation = orientationRaw === undefined ? undefined : Number(orientationRaw);

    return [{
      id: `${element.type}/${element.id}`,
      kind,
      geometry,
      name: element.tags?.['seamark:name'] ?? element.tags?.name,
      orientation: Number.isFinite(orientation) ? orientation : undefined,
    }];
  });
}

type TrafficGeometry = TrafficScheme['geometry'];
type Coordinate = [number, number];

function coordinates(points: OverpassPoint[] | undefined): Coordinate[] {
  return (points ?? [])
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
    .map((point) => [point.lon, point.lat]);
}

function samePoint(a: Coordinate | undefined, b: Coordinate | undefined): boolean {
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
}

function geometryFromWay(points: OverpassPoint[] | undefined, area: boolean): TrafficGeometry | null {
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
): TrafficGeometry | null {
  const segments = (members ?? [])
    .filter((member) => member.type === 'way' && member.role !== 'inner')
    .map((member) => coordinates(member.geometry))
    .filter((line) => line.length >= 2);
  if (segments.length === 0) return null;

  const lines = joinSegments(segments);
  if (area) {
    const rings = lines.filter((line) => line.length >= 4 && samePoint(line[0], line.at(-1)));
    if (rings.length > 0) {
      return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
    }
  }
  return { type: 'MultiLineString', coordinates: lines };
}

/** Ühendab relationi järjestamata way-liikmed võimalusel terviklikeks joonteks. */
function joinSegments(input: Coordinate[][]): Coordinate[][] {
  const pending = input.map((line) => [...line]);
  const joined: Coordinate[][] = [];

  while (pending.length > 0) {
    const line = pending.shift()!;
    let changed = true;
    while (changed) {
      changed = false;
      const start = line[0];
      const end = line.at(-1);
      const index = pending.findIndex((candidate) =>
        samePoint(end, candidate[0])
        || samePoint(end, candidate.at(-1))
        || samePoint(start, candidate.at(-1))
        || samePoint(start, candidate[0]));
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
