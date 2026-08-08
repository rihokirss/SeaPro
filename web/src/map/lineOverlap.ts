import type { Fairway, TrafficScheme } from '@seapro/shared';

type Coordinate = [number, number];
type LineGeometry = Fairway['geometry'];
type Interval = [number, number];
type Segment = [Coordinate, Coordinate];

const EARTH_METRES_PER_DEGREE = 111_320;
const PARALLEL_COSINE = Math.cos(20 * Math.PI / 180);
const MIN_VISIBLE_METRES = 2;

/**
 * Eemaldab ametlikust laevateest ainult need lõigud, mille kohal on juba
 * OpenSeaMapi nähtav liiklusskeemi joon. Algset geomeetriat see ei muuda:
 * seda kasutatakse eraldi klikikihis.
 */
export function fairwayVisibleGeometry(
  geometry: LineGeometry,
  trafficSchemes: TrafficScheme[],
  toleranceM = 25,
): LineGeometry | null {
  return subtractTrafficSegments(geometry, visibleTrafficSegments(trafficSchemes), toleranceM);
}

/** Arvutab terve kaadrikomplekti ühe liiklussegmentide läbimisega. */
export function fairwayVisibleGeometries(
  fairways: Fairway[],
  trafficSchemes: TrafficScheme[],
  toleranceM = 25,
): Map<string, LineGeometry | null> {
  const trafficSegments = visibleTrafficSegments(trafficSchemes);
  return new Map(fairways.map((fairway) => [
    fairway.id,
    subtractTrafficSegments(fairway.geometry, trafficSegments, toleranceM),
  ]));
}

function visibleTrafficSegments(trafficSchemes: TrafficScheme[]): Segment[] {
  return trafficSchemes
    .filter((scheme) => trafficSchemeHasVisibleLine(scheme.kind))
    .flatMap((scheme) => geometryLines(scheme.geometry))
    .flatMap(lineSegments);
}

function subtractTrafficSegments(
  geometry: LineGeometry,
  trafficSegments: Segment[],
  toleranceM: number,
): LineGeometry | null {

  if (trafficSegments.length === 0) return geometry;

  const visibleLines = geometryLines(geometry)
    .flatMap((line) => subtractOverlaps(line, trafficSegments, toleranceM))
    .filter((line) => line.length >= 2);

  if (visibleLines.length === 0) return null;
  return visibleLines.length === 1
    ? { type: 'LineString', coordinates: visibleLines[0]! }
    : { type: 'MultiLineString', coordinates: visibleLines };
}

/** Liiklusrajad ise kuvatakse noolega; nende telgjoont pole vaja maha lahutada. */
function trafficSchemeHasVisibleLine(kind: TrafficScheme['kind']): boolean {
  return ![
    'separation_lane',
    'recommended_traffic_lane',
    'traffic_lane',
  ].includes(kind);
}

function geometryLines(geometry: TrafficScheme['geometry'] | LineGeometry): Coordinate[][] {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates;
  return geometry.coordinates.flatMap((polygon) => polygon);
}

function lineSegments(line: Coordinate[]): Array<[Coordinate, Coordinate]> {
  const segments: Segment[] = [];
  for (let index = 1; index < line.length; index++) {
    segments.push([line[index - 1]!, line[index]!]);
  }
  return segments;
}

function subtractOverlaps(
  line: Coordinate[],
  trafficSegments: Segment[],
  toleranceM: number,
): Coordinate[][] {
  const output: Coordinate[][] = [];
  let current: Coordinate[] | null = null;

  for (let index = 1; index < line.length; index++) {
    const start = line[index - 1]!;
    const end = line[index]!;
    const removed = mergeIntervals(trafficSegments
      .map(([a, b]) => overlapInterval(start, end, a, b, toleranceM))
      .filter((interval): interval is Interval => interval !== null));
    const visible = complementIntervals(removed);

    for (const [from, to] of visible) {
      const partStart = interpolate(start, end, from);
      const partEnd = interpolate(start, end, to);
      if (distanceMetres(partStart, partEnd) < MIN_VISIBLE_METRES) continue;

      if (current && from === 0 && sameCoordinate(current.at(-1), partStart)) {
        current.push(partEnd);
      } else {
        if (current) output.push(current);
        current = [partStart, partEnd];
      }

      if (to < 1) {
        output.push(current);
        current = null;
      }
    }

    if (visible.length === 0 && current) {
      output.push(current);
      current = null;
    }
  }

  if (current) output.push(current);
  return output;
}

/**
 * Tagastab ametliku segmendi parameetrivahemiku, mis on teise segmendiga
 * paralleelne ja kuni toleranceM kaugusel. Ristuvad jooned ei ole dubletid.
 */
function overlapInterval(
  start: Coordinate,
  end: Coordinate,
  otherStart: Coordinate,
  otherEnd: Coordinate,
  toleranceM: number,
): Interval | null {
  const referenceLat = (start[1] + end[1] + otherStart[1] + otherEnd[1]) / 4;
  const lonScale = EARTH_METRES_PER_DEGREE * Math.cos(referenceLat * Math.PI / 180);
  const latTolerance = toleranceM / EARTH_METRES_PER_DEGREE;
  const lonTolerance = toleranceM / lonScale;
  if (
    Math.max(start[0], end[0]) + lonTolerance < Math.min(otherStart[0], otherEnd[0])
    || Math.max(otherStart[0], otherEnd[0]) + lonTolerance < Math.min(start[0], end[0])
    || Math.max(start[1], end[1]) + latTolerance < Math.min(otherStart[1], otherEnd[1])
    || Math.max(otherStart[1], otherEnd[1]) + latTolerance < Math.min(start[1], end[1])
  ) return null;
  const toXY = ([lon, lat]: Coordinate): [number, number] =>
    [lon * lonScale, lat * EARTH_METRES_PER_DEGREE];
  const a = toXY(start);
  const b = toXY(end);
  const c = toXY(otherStart);
  const d = toXY(otherEnd);
  const ab = [b[0] - a[0], b[1] - a[1]] as const;
  const cd = [d[0] - c[0], d[1] - c[1]] as const;
  const abLength = Math.hypot(...ab);
  const cdLength = Math.hypot(...cd);
  if (abLength === 0 || cdLength === 0) return null;

  const alignment = Math.abs((ab[0] * cd[0] + ab[1] * cd[1]) / (abLength * cdLength));
  if (alignment < PARALLEL_COSINE) return null;

  const project = (point: readonly [number, number]): number =>
    ((point[0] - a[0]) * ab[0] + (point[1] - a[1]) * ab[1]) / (abLength * abLength);
  const projectedStart = project(c);
  const projectedEnd = project(d);
  const padding = toleranceM / abLength;
  const from = Math.max(0, Math.min(projectedStart, projectedEnd) - padding);
  const to = Math.min(1, Math.max(projectedStart, projectedEnd) + padding);
  if (to <= from) return null;

  const distanceAt = (t: number): number => pointSegmentDistance(
    [a[0] + ab[0] * t, a[1] + ab[1] * t],
    c,
    d,
  );

  // Kergelt lahknevad jooned võivad olla lähestikku ainult osa ulatuses.
  // Kaugus sirglõigust on selle intervalli peal kumer funktsioon: leiame
  // lähima koha ning binaarotsinguga täpsed 25 m koridori sisenemis-/väljumisotsad.
  let searchFrom = from;
  let searchTo = to;
  for (let iteration = 0; iteration < 36; iteration++) {
    const third = (searchTo - searchFrom) / 3;
    const left = searchFrom + third;
    const right = searchTo - third;
    if (distanceAt(left) <= distanceAt(right)) searchTo = right;
    else searchFrom = left;
  }
  const closest = (searchFrom + searchTo) / 2;
  if (distanceAt(closest) > toleranceM) return null;

  let visibleFrom = from;
  if (distanceAt(from) > toleranceM) {
    let outside = from;
    let inside = closest;
    for (let iteration = 0; iteration < 36; iteration++) {
      const middle = (outside + inside) / 2;
      if (distanceAt(middle) <= toleranceM) inside = middle;
      else outside = middle;
    }
    visibleFrom = inside;
  }

  let visibleTo = to;
  if (distanceAt(to) > toleranceM) {
    let inside = closest;
    let outside = to;
    for (let iteration = 0; iteration < 36; iteration++) {
      const middle = (inside + outside) / 2;
      if (distanceAt(middle) <= toleranceM) inside = middle;
      else outside = middle;
    }
    visibleTo = inside;
  }

  return visibleTo > visibleFrom ? [visibleFrom, visibleTo] : null;
}

function pointSegmentDistance(
  point: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dy * t));
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [[...sorted[0]!] as Interval];
  for (const [from, to] of sorted.slice(1)) {
    const previous = merged.at(-1)!;
    if (from <= previous[1]) previous[1] = Math.max(previous[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function complementIntervals(removed: Interval[]): Interval[] {
  const visible: Interval[] = [];
  let cursor = 0;
  for (const [from, to] of removed) {
    if (from > cursor) visible.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < 1) visible.push([cursor, 1]);
  return visible;
}

function interpolate(start: Coordinate, end: Coordinate, t: number): Coordinate {
  if (t === 0) return start;
  if (t === 1) return end;
  return [
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
  ];
}

function distanceMetres(a: Coordinate, b: Coordinate): number {
  const lat = (a[1] + b[1]) / 2 * Math.PI / 180;
  const dx = (b[0] - a[0]) * EARTH_METRES_PER_DEGREE * Math.cos(lat);
  const dy = (b[1] - a[1]) * EARTH_METRES_PER_DEGREE;
  return Math.hypot(dx, dy);
}

function sameCoordinate(a: Coordinate | undefined, b: Coordinate): boolean {
  return Boolean(a && Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10);
}
