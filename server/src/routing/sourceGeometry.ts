import type { BBox } from '@seapro/shared';
import type { Position, RoutingGeometry } from './sourceTypes.js';

/** Tagastab geomeetria konservatiivse lõuna-lääs-põhi-ida piirdekasti. */
export function routingGeometryBbox(geometry: RoutingGeometry): BBox {
  const points = geometryPositions(geometry);
  if (!points.length) return [0, 0, 0, 0];
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lon, lat] of points) {
    south = Math.min(south, lat);
    west = Math.min(west, lon);
    north = Math.max(north, lat);
    east = Math.max(east, lon);
  }
  return [south, west, north, east];
}

/** Kiire konservatiivne test; võib anda keeruka joone puhul false-positive'i. */
export function routingGeometryIntersectsBbox(geometry: RoutingGeometry, bbox: BBox): boolean {
  const [south, west, north, east] = routingGeometryBbox(geometry);
  return south <= bbox[2] && north >= bbox[0] && west <= bbox[3] && east >= bbox[1];
}

/**
 * Punkt-polügoon test koos aukudega. Point-geomeetria puhul võrreldakse
 * koordinaate; jooned ei defineeri sisepinda ja tagastavad false.
 */
export function pointInRoutingGeometry(point: Position, geometry: RoutingGeometry): boolean {
  if (geometry.type === 'Point') return samePoint(point, geometry.coordinates);
  if (geometry.type === 'MultiPoint') {
    return geometry.coordinates.some((candidate) => samePoint(point, candidate));
  }
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

function pointInPolygon(point: Position, rings: Position[][]): boolean {
  const outer = rings[0];
  if (!outer || !pointInRing(point, outer)) return false;
  return !rings.slice(1).some((hole) => pointInRing(point, hole));
}

function pointInRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (pointOnSegment([x, y], a, b)) return true;
    const crosses = (a[1] > y) !== (b[1] > y)
      && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point: Position, a: Position, b: Position): boolean {
  const cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > 1e-10) return false;
  return point[0] >= Math.min(a[0], b[0]) - 1e-10
    && point[0] <= Math.max(a[0], b[0]) + 1e-10
    && point[1] >= Math.min(a[1], b[1]) - 1e-10
    && point[1] <= Math.max(a[1], b[1]) + 1e-10;
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function geometryPositions(geometry: RoutingGeometry): Position[] {
  switch (geometry.type) {
    case 'Point': return [geometry.coordinates];
    case 'MultiPoint':
    case 'LineString': return geometry.coordinates;
    case 'MultiLineString':
    case 'Polygon': return geometry.coordinates.flat();
    case 'MultiPolygon': return geometry.coordinates.flat(2);
  }
}
