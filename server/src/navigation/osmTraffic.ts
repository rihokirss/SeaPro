import type { TrafficScheme, TrafficSchemeKind } from '@seapro/shared';
import { cache } from '../cache.js';
import { fetchJson } from '../http.js';

/**
 * OpenSeaMapi raster sisaldab ühes pildis nii poisid kui liiklusskeemid.
 * Siin küsime samast OSM-i algandmest ainult liikluse korraldamise objektid,
 * et ametlike navimärkide kõrvale ei tekiks dubleerivaid rasterpoide.
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const TTL_SECONDS = 24 * 3600;

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
  const [south, west, north, east] = bbox;
  // Overpass loeb way bbox'i tabatuks selle SÕLMEDE, mitte ekraanil nähtava
  // joone järgi. Pikk liiklusskeem võib seega vaate serva ületada nii, et ükski
  // tema sõlm nähtavasse bbox'i ei jää, ning järgmine vastus kustutaks skeemi
  // kaardilt. Vähemalt pool kraadi puhvrit hoiab serval olevad tervikobjektid
  // päringus ja vähendab ühtlasi kaardi väikeste nihete järel uusi kutseid.
  const step = 0.5;
  const latMargin = Math.max(step, Math.min(1, (north - south) / 2));
  const lonMargin = Math.max(step, Math.min(1, (east - west) / 2));
  const snapped = [
    Math.floor((south - latMargin) / step) * step,
    Math.floor((west - lonMargin) / step) * step,
    Math.ceil((north + latMargin) / step) * step,
    Math.ceil((east + lonMargin) / step) * step,
  ] as const;
  // v5 eemaldab piirkondliku osm.ch peegli tagastatud ekslikult tühjad
  // Läänemere kirjed varasemast vahemälust.
  const key = `overpass:traffic:v5:${snapped.join(',')}`;
  const result = await cache.get(key, TTL_SECONDS, () => queryOverpass(snapped));
  return {
    trafficSchemes: result.value,
    fetchedAt: new Date(Date.now() - Math.max(0, result.ageSeconds) * 1000).toISOString(),
    ageSeconds: result.ageSeconds,
    stale: result.stale,
  };
}

async function queryOverpass(
  [south, west, north, east]: readonly [number, number, number, number],
): Promise<TrafficScheme[]> {
  const types = [...TRAFFIC_KINDS].join('|');
  const query = `[out:json][timeout:60];
(
  way["seamark:type"~"^(${types})$"](${south},${west},${north},${east});
  relation["seamark:type"~"^(${types})$"](${south},${west},${north},${east});
);
out geom tags;`;
  let lastError: unknown;

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchJson<OverpassTrafficResponse>(endpoint, {
        form: { data: query },
        timeoutMs: 90_000,
        retries: 0,
      });
      return parseTrafficSchemes(response);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Overpassi liiklusskeemid ei vastanud: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
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
