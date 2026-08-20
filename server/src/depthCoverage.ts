import officialDepthCoverageData from './data/official-depth-coverage.json';

type Position = [number, number];
type Ring = Position[];
type Polygon = Ring[];
type MultiPolygonCoordinates = Polygon[];

interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: MultiPolygonCoordinates;
}

interface BoundaryEdge {
  a: Position;
  b: Position;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface LineGeometry {
  type: 'LineString' | 'MultiLineString';
  coordinates: number[][] | number[][][];
}

interface GeoJsonFeature {
  type: 'Feature';
  geometry: LineGeometry | { type: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  [key: string]: unknown;
}

const LATITUDE_BUCKET_SIZE = 0.02;
const EPSILON = 1e-10;
export const OFFICIAL_DEPTH_MIN_ZOOM = 7;

/**
 * Ettevalmistatud hulknurk, mis oskab kontuurjooni mõõtealade seest välja
 * lõigata. Laiuskraadiindeks jätab iga punktitesti juurde ainult samal
 * laiusel olevad piirisegmendid; muidu käiks lähivaates iga EMODneti punkti
 * kohta läbi kogu 8500-punktiline katvuspiir.
 */
export class DepthCoverage {
  readonly #latitudeBuckets = new Map<number, BoundaryEdge[]>();
  readonly #bounds: [number, number, number, number];

  constructor(coordinates: MultiPolygonCoordinates) {
    const edges: BoundaryEdge[] = [];
    let west = Number.POSITIVE_INFINITY;
    let south = Number.POSITIVE_INFINITY;
    let east = Number.NEGATIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;

    for (const polygon of coordinates) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length - 1; index++) {
          const a = ring[index]!;
          const b = ring[index + 1]!;
          if (!isPosition(a) || !isPosition(b) || samePosition(a, b)) continue;
          const edge = {
            a,
            b,
            minX: Math.min(a[0], b[0]),
            maxX: Math.max(a[0], b[0]),
            minY: Math.min(a[1], b[1]),
            maxY: Math.max(a[1], b[1]),
          };
          edges.push(edge);
          west = Math.min(west, edge.minX);
          south = Math.min(south, edge.minY);
          east = Math.max(east, edge.maxX);
          north = Math.max(north, edge.maxY);
        }
      }
    }

    this.#bounds = [west, south, east, north];
    for (const edge of edges) {
      const first = latitudeBucket(edge.minY);
      const last = latitudeBucket(edge.maxY);
      for (let bucket = first; bucket <= last; bucket++) {
        const current = this.#latitudeBuckets.get(bucket);
        if (current) current.push(edge);
        else this.#latitudeBuckets.set(bucket, [edge]);
      }
    }
  }

  contains([x, y]: Position): boolean {
    const [west, south, east, north] = this.#bounds;
    if (x < west || x > east || y < south || y > north) return false;

    let inside = false;
    for (const edge of this.#latitudeBuckets.get(latitudeBucket(y)) ?? []) {
      // Paaris-paaritu reegel töötab korraga nii MultiPolygoni osade kui ka
      // aukudega. Horisontaalservad ei saa siin nulliga jagamist tekitada.
      if ((edge.a[1] > y) === (edge.b[1] > y)) continue;
      const crossingX = edge.a[0]
        + ((y - edge.a[1]) * (edge.b[0] - edge.a[0])) / (edge.b[1] - edge.a[1]);
      if (x < crossingX) inside = !inside;
    }
    return inside;
  }

  clipLineOutside(line: number[][]): number[][][] {
    if (line.length < 2) return [];
    const output: number[][][] = [];
    let current: number[][] = [];

    const finishCurrent = (): void => {
      if (current.length >= 2) output.push(current);
      current = [];
    };

    for (let index = 0; index < line.length - 1; index++) {
      const rawA = line[index]!;
      const rawB = line[index + 1]!;
      if (!isPosition(rawA) || !isPosition(rawB) || samePosition(rawA, rawB)) continue;

      const cuts = this.#segmentCuts(rawA, rawB);
      for (let cutIndex = 0; cutIndex < cuts.length - 1; cutIndex++) {
        const from = cuts[cutIndex]!;
        const to = cuts[cutIndex + 1]!;
        if (to - from <= EPSILON) continue;
        const middle = interpolate(rawA, rawB, (from + to) / 2);
        if (this.contains(middle)) {
          finishCurrent();
          continue;
        }

        const start = interpolate(rawA, rawB, from);
        const end = interpolate(rawA, rawB, to);
        if (current.length === 0) current.push(start);
        else if (!samePosition(current.at(-1)!, start)) {
          finishCurrent();
          current.push(start);
        }
        current.push(end);
      }
    }
    finishCurrent();
    return output;
  }

  #segmentCuts(a: Position, b: Position): number[] {
    const [west, south, east, north] = this.#bounds;
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]);
    const maxY = Math.max(a[1], b[1]);
    if (maxX < west || minX > east || maxY < south || minY > north) return [0, 1];

    const candidates = new Set<BoundaryEdge>();
    const first = latitudeBucket(minY);
    const last = latitudeBucket(maxY);
    for (let bucket = first; bucket <= last; bucket++) {
      for (const edge of this.#latitudeBuckets.get(bucket) ?? []) {
        if (edge.maxX < minX || edge.minX > maxX || edge.maxY < minY || edge.minY > maxY) continue;
        candidates.add(edge);
      }
    }

    const cuts = [0, 1];
    for (const edge of candidates) {
      const t = segmentIntersectionParameter(a, b, edge.a, edge.b);
      if (t !== undefined && t > EPSILON && t < 1 - EPSILON) cuts.push(t);
    }
    cuts.sort((left, right) => left - right);
    return cuts.filter((value, index) => index === 0 || value - cuts[index - 1]! > EPSILON);
  }
}

const coverageGeometry = officialDepthCoverageData.features[0]?.geometry as MultiPolygonGeometry;
if (!coverageGeometry || coverageGeometry.type !== 'MultiPolygon') {
  throw new Error('Ametlike sügavusandmete katvusmask peab olema MultiPolygon');
}

export const officialDepthCoverage = new DepthCoverage(
  coverageGeometry.coordinates as MultiPolygonCoordinates,
);

/** Eemaldab EMODneti jooned Eesti ja Soome ametliku ühendkatvuse seest. */
export function clipDepthContoursOutsideOfficialCoverage(data: unknown): unknown {
  if (!isFeatureCollection(data)) return data;

  const features = data.features.flatMap((feature): GeoJsonFeature[] => {
    const geometry = feature.geometry;
    if (!geometry || geometry.type === 'LineString') {
      if (!geometry || !Array.isArray(geometry.coordinates)) return [feature];
      const lines = officialDepthCoverage.clipLineOutside(geometry.coordinates as number[][]);
      if (lines.length === 0) return [];
      return [{ ...feature, geometry: { type: 'MultiLineString', coordinates: lines } }];
    }
    if (geometry.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates)) return [feature];
    const lines = (geometry.coordinates as number[][][])
      .flatMap((line) => officialDepthCoverage.clipLineOutside(line));
    if (lines.length === 0) return [];
    return [{ ...feature, geometry: { type: 'MultiLineString', coordinates: lines } }];
  });

  return { ...data, features };
}

/** EMODneti mudelisildid ei dubleeri ametliku PMTilesi sügavuspunkte. */
export function filterDepthSamplesOutsideOfficialCoverage<T extends {
  features: Array<{ geometry: { type: 'Point'; coordinates: [number, number] } }>;
}>(data: T): T {
  return {
    ...data,
    features: data.features.filter((feature) =>
      !officialDepthCoverage.contains(feature.geometry.coordinates)),
  };
}

function isFeatureCollection(value: unknown): value is GeoJsonFeatureCollection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GeoJsonFeatureCollection>;
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features);
}

function isPosition(value: number[]): value is Position {
  return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function samePosition(a: number[], b: number[]): boolean {
  return Math.abs(a[0]! - b[0]!) <= EPSILON && Math.abs(a[1]! - b[1]!) <= EPSILON;
}

function latitudeBucket(latitude: number): number {
  return Math.floor(latitude / LATITUDE_BUCKET_SIZE);
}

function interpolate(a: Position, b: Position, t: number): Position {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function segmentIntersectionParameter(
  a: Position,
  b: Position,
  c: Position,
  d: Position,
): number | undefined {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) <= EPSILON) return undefined;

  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = cross(qx, qy, sx, sy) / denominator;
  const u = cross(qx, qy, rx, ry) / denominator;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return undefined;
  return Math.min(1, Math.max(0, t));
}
