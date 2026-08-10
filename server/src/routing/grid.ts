import type {
  EndpointSnapOptions,
  GridCoordinate,
  GridPoint,
  RouteRisk,
  RoutingCell,
  RoutingGrid,
  SnappedEndpoint,
} from './engineTypes.js';

export type CellPredicate = (point: GridPoint) => boolean;

const RISKS = new Set<RouteRisk>(['clear', 'caution', 'unknown']);

export function assertRoutingGrid(grid: RoutingGrid): void {
  if (!Number.isInteger(grid.width) || !Number.isInteger(grid.height) || grid.width <= 0 || grid.height <= 0) {
    throw new RangeError('Routing grid dimensions must be positive integers');
  }
  if (grid.width * grid.height > 0x7fff_ffff) {
    throw new RangeError('Routing grid is too large');
  }
  if (grid.minimumCostMultiplier != null
    && (!Number.isFinite(grid.minimumCostMultiplier) || grid.minimumCostMultiplier < 0)) {
    throw new RangeError('minimumCostMultiplier must be a finite non-negative number');
  }
}

export function assertGridPoint(grid: RoutingGrid, point: GridPoint, name = 'point'): void {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
    throw new TypeError(`${name} must use integer grid coordinates`);
  }
  if (!isInsideGrid(grid, point)) throw new RangeError(`${name} is outside the routing grid`);
}

export function isInsideGrid(grid: RoutingGrid, point: GridCoordinate): boolean {
  return point.x >= 0 && point.x < grid.width && point.y >= 0 && point.y < grid.height;
}

export function pointId(grid: RoutingGrid, point: GridPoint): number {
  return point.y * grid.width + point.x;
}

export function pointFromId(grid: RoutingGrid, id: number): GridPoint {
  return { x: id % grid.width, y: Math.floor(id / grid.width) };
}

/** Read and validate a cell at a known in-bounds point. */
export function routingCellAt(grid: RoutingGrid, point: GridPoint): RoutingCell {
  const cell = grid.cellAt(point.x, point.y);
  if (cell == null || typeof cell !== 'object') throw new TypeError(`Missing routing cell at ${point.x},${point.y}`);
  if (typeof cell.blocked !== 'boolean') throw new TypeError(`Invalid blocked flag at ${point.x},${point.y}`);
  if (!RISKS.has(cell.risk)) throw new TypeError(`Invalid risk at ${point.x},${point.y}`);
  if (!cell.blocked && (!Number.isFinite(cell.costMultiplier) || cell.costMultiplier <= 0)) {
    throw new RangeError(`Traversable cell cost must be positive at ${point.x},${point.y}`);
  }
  return cell;
}

export function isTraversable(grid: RoutingGrid, point: GridPoint, allowed?: CellPredicate): boolean {
  return isInsideGrid(grid, point) && (allowed?.(point) ?? true) && !routingCellAt(grid, point).blocked;
}

export interface GridNeighbour {
  readonly point: GridPoint;
  readonly distance: 1 | typeof Math.SQRT2;
}

// A fixed order plus stable heap tie-breaking makes equal-cost paths reproducible.
const DIRECTIONS = [
  [1, 0], [0, -1], [-1, 0], [0, 1],
  [1, -1], [-1, -1], [-1, 1], [1, 1],
] as const;

/**
 * Eight-neighbour traversal. A diagonal is legal only when both orthogonal
 * side cells are legal, so a route can never squeeze through touching blocks.
 */
export function traversableNeighbours(
  grid: RoutingGrid,
  point: GridPoint,
  allowed?: CellPredicate,
): GridNeighbour[] {
  const result: GridNeighbour[] = [];
  for (const [dx, dy] of DIRECTIONS) {
    const next = { x: point.x + dx, y: point.y + dy };
    if (!isTraversable(grid, next, allowed)) continue;
    if (dx !== 0 && dy !== 0) {
      if (!isTraversable(grid, { x: point.x + dx, y: point.y }, allowed)
        || !isTraversable(grid, { x: point.x, y: point.y + dy }, allowed)) continue;
    }
    result.push({ point: next, distance: dx === 0 || dy === 0 ? 1 : Math.SQRT2 });
  }
  return result;
}

/**
 * Find the nearest traversable cell inside a circular radius. Exact distance
 * wins; multiplier, risk, y and x are deterministic tie-breakers.
 */
export function snapEndpoint(
  grid: RoutingGrid,
  requested: GridCoordinate,
  options: EndpointSnapOptions,
): SnappedEndpoint | null {
  assertRoutingGrid(grid);
  if (!Number.isFinite(requested.x) || !Number.isFinite(requested.y)) {
    throw new TypeError('Endpoint coordinates must be finite');
  }
  const radius = options.maxDistanceCells;
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError('maxDistanceCells must be finite and non-negative');

  const minX = Math.max(0, Math.ceil(requested.x - radius));
  const maxX = Math.min(grid.width - 1, Math.floor(requested.x + radius));
  const minY = Math.max(0, Math.ceil(requested.y - radius));
  const maxY = Math.min(grid.height - 1, Math.floor(requested.y + radius));
  let best: { point: GridPoint; distance: number; cost: number; risk: number } | null = null;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const distance = Math.hypot(x - requested.x, y - requested.y);
      if (distance > radius + 1e-12) continue;
      const point = { x, y };
      const cell = routingCellAt(grid, point);
      if (cell.blocked || (options.allowed && !options.allowed(point))) continue;
      const risk = cell.risk === 'clear' ? 0 : cell.risk === 'caution' ? 1 : 2;
      const candidate = { point, distance, cost: cell.costMultiplier, risk };
      if (best == null || compareSnapCandidate(candidate, best) < 0) best = candidate;
    }
  }

  if (best == null) return null;
  return {
    requested: { x: requested.x, y: requested.y },
    point: best.point,
    distanceCells: best.distance,
    shifted: best.distance > 1e-12,
  };
}

function compareSnapCandidate(
  a: { point: GridPoint; distance: number; cost: number; risk: number },
  b: { point: GridPoint; distance: number; cost: number; risk: number },
): number {
  const distance = a.distance - b.distance;
  if (Math.abs(distance) > 1e-12) return distance;
  const cost = a.cost - b.cost;
  if (Math.abs(cost) > 1e-12) return cost;
  return a.risk - b.risk || a.point.y - b.point.y || a.point.x - b.point.x;
}
