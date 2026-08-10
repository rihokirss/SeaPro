import type { RoutePlanSegment } from '@seapro/shared';
import type { GridPoint, RouteRisk } from './engineTypes.js';
import type {
  RoutingCellDetails,
  RoutingCostSurface,
  RoutingReasonCode,
} from './costSurface.js';
import { validatePath } from './simplify.js';

const EPSILON = 1e-10;
const NOOP_CHECKPOINT = (): void => undefined;

interface TracedCell {
  point: GridPoint;
  startT: number;
  endT: number;
}

interface SegmentAccumulator {
  key: string;
  risk: RouteRisk;
  reasons: RoutingReasonCode[];
  sourceIds: string[];
  minDepthM: number;
  startT: number;
  endT: number;
}

export interface PositionedGridPoint extends GridPoint {
  /** Optional exact geographic point for multiple harbour marks in one coarse grid cell. */
  readonly position?: [number, number];
}

export interface DescribedRouteGeometry {
  coordinates: [number, number][];
  segments: RoutePlanSegment[];
}

/**
 * Lisab punkti rajale ilma järjestikuseid duplikaate tekitamata. Täpne
 * koordinaat (position) võidab sama võreraku positsioonita punkti; kaks eri
 * täpse koordinaadiga punkti samas rakus jäävad mõlemad alles.
 */
export function appendPositionedPoint(
  points: PositionedGridPoint[],
  point: PositionedGridPoint,
): void {
  const last = points.at(-1);
  if (!last || last.x !== point.x || last.y !== point.y) {
    points.push({ ...point });
  } else if (point.position && last.position && !samePosition(point.position, last.position)) {
    points.push({ ...point });
  } else if (point.position && !last.position) {
    points[points.length - 1] = { ...point };
  }
}

/** Punkti kaugus lõigust [from, to] samas tasapinnalises koordinaadistikus. */
export function pointSegmentDistance(
  px: number,
  py: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((px - fromX) * dx + (py - fromY) * dy) / lengthSquared));
  return Math.hypot(px - (fromX + dx * ratio), py - (fromY + dy * ratio));
}

/**
 * Kirjeldab lihtsustatud joone lahtri täpsusega. Riskipiir lisatakse GeoJSON-i
 * geomeetriasse ning ükski kitsas unknown/caution riba ei värvi tervet pikka
 * sirglõiku ega kao selle sisse ära.
 */
export function describeRouteGeometry(
  surface: RoutingCostSurface,
  path: readonly PositionedGridPoint[],
  checkpoint: () => void = NOOP_CHECKPOINT,
): DescribedRouteGeometry {
  checkpoint();
  if (path.length === 0) throw new RangeError('Marsruudi geomeetria ei tohi olla tühi');
  if (!validatePath(surface, path, checkpoint).valid) {
    throw new Error('Lihtsustatud marsruut ei läbinud kordusvalideerimist');
  }
  if (path.length === 1) {
    const position = pathPosition(surface, path[0]!);
    const details = surface.detailsAt(path[0]!.x, path[0]!.y);
    return {
      coordinates: [position, position],
      segments: [routeSegment(surface, path[0]!, path[0]!, 0, 1, accumulator(details, 0, 1))],
    };
  }

  const coordinates: [number, number][] = [pathPosition(surface, path[0]!)];
  const segments: RoutePlanSegment[] = [];
  for (let edgeIndex = 1; edgeIndex < path.length; edgeIndex++) {
    checkpoint();
    const from = path[edgeIndex - 1]!;
    const to = path[edgeIndex]!;
    const traced = traceCells(from, to);
    let current: SegmentAccumulator | null = null;

    const flush = (): void => {
      if (!current) return;
      const segment = routeSegment(surface, from, to, current.startT, current.endT, current);
      segments.push(segment);
      const end = segment.to;
      if (!samePosition(coordinates.at(-1)!, end)) coordinates.push(end);
      current = null;
    };

    for (const [cellIndex, entry] of traced.entries()) {
      if ((cellIndex & 127) === 0) checkpoint();
      const details = surface.detailsAt(entry.point.x, entry.point.y);
      const next = accumulator(details, entry.startT, entry.endT);
      if (current && current.key === next.key) {
        current.endT = entry.endT;
        current.minDepthM = Math.min(current.minDepthM, next.minDepthM);
      } else {
        flush();
        current = next;
      }
    }
    flush();
  }

  const finalPosition = pathPosition(surface, path.at(-1)!);
  if (!samePosition(coordinates.at(-1)!, finalPosition)) coordinates.push(finalPosition);
  return { coordinates, segments };
}

function traceCells(from: GridPoint, to: GridPoint): TracedCell[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return [{ point: { ...from }, startT: 0, endT: 1 }];

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dx);
  const deltaY = dy === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dy);
  let boundaryX = dx === 0 ? Number.POSITIVE_INFINITY : 0.5 / Math.abs(dx);
  let boundaryY = dy === 0 ? Number.POSITIVE_INFINITY : 0.5 / Math.abs(dy);
  let x = from.x;
  let y = from.y;
  let position = 0;
  const cells: TracedCell[] = [];

  while (position < 1 - EPSILON) {
    const nextPosition = Math.min(1, boundaryX, boundaryY);
    cells.push({ point: { x, y }, startT: position, endT: nextPosition });
    if (nextPosition >= 1 - EPSILON) break;
    if (Math.abs(boundaryX - nextPosition) <= EPSILON) {
      x += stepX;
      boundaryX += deltaX;
    }
    if (Math.abs(boundaryY - nextPosition) <= EPSILON) {
      y += stepY;
      boundaryY += deltaY;
    }
    position = nextPosition;
  }
  return cells;
}

function accumulator(
  details: RoutingCellDetails,
  startT: number,
  endT: number,
): SegmentAccumulator {
  const reasons = [...new Set(details.reasons)].sort();
  const sourceIds = [...new Set(details.sourceIds)].sort();
  return {
    key: `${details.risk}\0${reasons.join('\0')}\0${sourceIds.join('\0')}`,
    risk: details.risk,
    reasons,
    sourceIds,
    minDepthM: details.depthM ?? Number.POSITIVE_INFINITY,
    startT,
    endT,
  };
}

function routeSegment(
  surface: RoutingCostSurface,
  from: PositionedGridPoint,
  to: PositionedGridPoint,
  startT: number,
  endT: number,
  value: SegmentAccumulator,
): RoutePlanSegment {
  return {
    from: positionAt(surface, from, to, startT),
    to: positionAt(surface, from, to, endT),
    assessment: value.risk,
    reasons: value.reasons,
    sourceIds: value.sourceIds,
    minDepthM: Number.isFinite(value.minDepthM) ? value.minDepthM : null,
    requiredDepthM: surface.requiredDepthM,
  };
}

function positionAt(
  surface: RoutingCostSurface,
  from: PositionedGridPoint,
  to: PositionedGridPoint,
  t: number,
): [number, number] {
  // Sadamavärava lahtril võib olla täpne koordinaadi-override. Murdarvulise
  // võrepunkti uuesti projitseerimine hüppaks sel juhul tagasi üldise lahtri
  // keskjoone juurde ja tekitaks kahe õige punkti vahele kunstliku jõnksu.
  const fromPosition = pathPosition(surface, from);
  const toPosition = pathPosition(surface, to);
  return [
    fromPosition[0] + (toPosition[0] - fromPosition[0]) * t,
    fromPosition[1] + (toPosition[1] - fromPosition[1]) * t,
  ];
}

function pathPosition(
  surface: RoutingCostSurface,
  point: PositionedGridPoint,
): [number, number] {
  return point.position ?? surface.toPosition(point);
}

function samePosition(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) <= 1e-12 && Math.abs(a[1] - b[1]) <= 1e-12;
}
