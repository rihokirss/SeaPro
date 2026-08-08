import type {
  GridPoint,
  GridRiskSegment,
  PathValidation,
  RouteRisk,
  RoutingGrid,
  SimplifyPathOptions,
} from './engineTypes.js';
import { assertGridPoint, assertRoutingGrid, routingCellAt } from './grid.js';

const EPSILON = 1e-10;
const NOOP_CHECKPOINT = (): void => undefined;

interface TracedCell {
  readonly point: GridPoint;
  readonly length: number;
}

interface SegmentTrace {
  readonly valid: boolean;
  readonly cost: number;
  readonly cells: readonly TracedCell[];
  readonly blockedAt?: GridPoint;
}

/** True only if the complete supercover is traversable and no blocked corner is cut. */
export function hasLineOfSight(grid: RoutingGrid, from: GridPoint, to: GridPoint): boolean {
  assertRoutingGrid(grid);
  assertGridPoint(grid, from, 'from');
  assertGridPoint(grid, to, 'to');
  return traceSegment(grid, from, to).valid;
}

/** Re-rasterise every segment and verify it against the current grid snapshot. */
export function validatePath(
  grid: RoutingGrid,
  path: readonly GridPoint[],
  checkpoint: () => void = NOOP_CHECKPOINT,
): PathValidation {
  checkpoint();
  assertRoutingGrid(grid);
  if (path.length === 0) throw new RangeError('Path must contain at least one point');
  for (const [index, point] of path.entries()) assertGridPoint(grid, point, `path[${index}]`);

  const cells: GridPoint[] = [];
  let totalCost = 0;
  if (path.length === 1) {
    const cell = routingCellAt(grid, path[0]!);
    return cell.blocked
      ? { valid: false, totalCost: Number.POSITIVE_INFINITY, cells, blockedAt: path[0] }
      : { valid: true, totalCost: 0, cells: [{ ...path[0]! }] };
  }

  for (let index = 1; index < path.length; index++) {
    if ((index & 127) === 0) checkpoint();
    const trace = traceSegment(grid, path[index - 1]!, path[index]!);
    appendUnique(cells, trace.cells.map((entry) => entry.point));
    if (!trace.valid) {
      return {
        valid: false,
        totalCost: Number.POSITIVE_INFINITY,
        cells,
        blockedAt: trace.blockedAt,
      };
    }
    totalCost += trace.cost;
  }
  return { valid: true, totalCost, cells };
}

/**
 * Greedy line-of-sight string pulling. A shortcut is accepted only after full
 * grid revalidation and only if it does not exceed the original sub-path cost
 * (or risk class) under the supplied snapshot.
 */
export function simplifyPath(
  grid: RoutingGrid,
  path: readonly GridPoint[],
  options: SimplifyPathOptions = {},
): GridPoint[] {
  const checkpoint = options.checkpoint ?? NOOP_CHECKPOINT;
  const original = validatePath(grid, path, checkpoint);
  if (!original.valid) throw new RangeError('Cannot simplify a blocked path');
  if (path.length <= 2) return path.map((point) => ({ ...point }));
  const maxCostRatio = options.maxCostRatio ?? 1;
  if (!Number.isFinite(maxCostRatio) || maxCostRatio < 1) {
    throw new RangeError('maxCostRatio must be a finite number of at least 1');
  }
  const preserveRisk = options.preserveRisk ?? true;
  const requiredIndexes = locateRequiredPointIndexes(path, options.requiredPoints ?? []);

  const edgeTraces: SegmentTrace[] = [];
  const cumulativeCost = new Float64Array(path.length);
  for (let index = 1; index < path.length; index++) {
    if ((index & 127) === 0) checkpoint();
    const trace = traceSegment(grid, path[index - 1]!, path[index]!);
    edgeTraces.push(trace);
    cumulativeCost[index] = cumulativeCost[index - 1]! + trace.cost;
  }

  const simplified: GridPoint[] = [{ ...path[0]! }];
  let anchor = 0;
  while (anchor < path.length - 1) {
    checkpoint();
    let accepted = anchor + 1;
    const nextRequiredIndex = requiredIndexes.find((index) => index > anchor);
    const furthestCandidate = nextRequiredIndex ?? path.length - 1;
    for (let candidate = furthestCandidate; candidate > anchor + 1; candidate--) {
      if ((candidate & 127) === 0) checkpoint();
      const shortcut = traceSegment(grid, path[anchor]!, path[candidate]!);
      if (!shortcut.valid) continue;
      const originalCost = cumulativeCost[candidate]! - cumulativeCost[anchor]!;
      if (shortcut.cost > originalCost * maxCostRatio + EPSILON) continue;
      if (preserveRisk && maxTraceRisk(grid, shortcut) > maxOriginalRisk(grid, edgeTraces, anchor, candidate)) continue;
      if (preserveRisk && introducesNewReason(grid, shortcut, edgeTraces, anchor, candidate)) continue;
      accepted = candidate;
      break;
    }
    simplified.push({ ...path[accepted]! });
    anchor = accepted;
  }

  // Defend against future tracing/string-pulling changes: never emit an
  // unvalidated result even if an individual shortcut check regresses.
  if (!validatePath(grid, simplified, checkpoint).valid) return path.map((point) => ({ ...point }));
  return simplified;
}

function locateRequiredPointIndexes(
  path: readonly GridPoint[],
  requiredPoints: readonly GridPoint[],
): number[] {
  const indexes: number[] = [];
  let minimumIndex = 0;
  for (const required of requiredPoints) {
    let found = -1;
    for (let index = minimumIndex; index < path.length; index++) {
      if (path[index]!.x === required.x && path[index]!.y === required.y) {
        found = index;
        break;
      }
    }
    if (found < 0) throw new RangeError('Required point is missing from the path');
    if (indexes.at(-1) !== found) indexes.push(found);
    minimumIndex = found;
  }
  return indexes;
}

/** Compress contiguous path cells that have the same risk and reason set. */
export function compressRiskSegments(grid: RoutingGrid, path: readonly GridPoint[]): GridRiskSegment[] {
  const validation = validatePath(grid, path);
  if (!validation.valid) throw new RangeError('Cannot describe risk for a blocked path');
  if (validation.cells.length === 0) return [];

  const segments: GridRiskSegment[] = [];
  let start = 0;
  let signature = cellRiskSignature(grid, validation.cells[0]!);
  for (let index = 1; index <= validation.cells.length; index++) {
    const next = index < validation.cells.length ? cellRiskSignature(grid, validation.cells[index]!) : null;
    if (next != null && next.key === signature.key) continue;
    const end = index - 1;
    segments.push({
      risk: signature.risk,
      reasons: signature.reasons,
      from: { ...validation.cells[start]! },
      to: { ...validation.cells[end]! },
      startCellIndex: start,
      endCellIndex: end,
      cellCount: end - start + 1,
    });
    if (next != null) {
      start = index;
      signature = next;
    }
  }
  return segments;
}

function traceSegment(grid: RoutingGrid, from: GridPoint, to: GridPoint): SegmentTrace {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const totalLength = Math.hypot(dx, dy);
  if (totalLength === 0) {
    const cell = routingCellAt(grid, from);
    return cell.blocked
      ? { valid: false, cost: Number.POSITIVE_INFINITY, cells: [], blockedAt: from }
      : { valid: true, cost: 0, cells: [{ point: { ...from }, length: 0 }] };
  }

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dx);
  const deltaY = dy === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dy);
  let boundaryX = dx === 0 ? Number.POSITIVE_INFINITY : 0.5 / Math.abs(dx);
  let boundaryY = dy === 0 ? Number.POSITIVE_INFINITY : 0.5 / Math.abs(dy);
  let x = from.x;
  let y = from.y;
  let position = 0;
  let cost = 0;
  const cells: TracedCell[] = [];

  while (position < 1 - EPSILON) {
    const point = { x, y };
    const cell = routingCellAt(grid, point);
    if (cell.blocked) return { valid: false, cost: Number.POSITIVE_INFINITY, cells, blockedAt: point };
    const nextPosition = Math.min(1, boundaryX, boundaryY);
    const length = Math.max(0, nextPosition - position) * totalLength;
    cells.push({ point, length });
    cost += length * cell.costMultiplier;
    if (nextPosition >= 1 - EPSILON) break;

    const crossesX = Math.abs(boundaryX - nextPosition) <= EPSILON;
    const crossesY = Math.abs(boundaryY - nextPosition) <= EPSILON;
    if (crossesX && crossesY) {
      // A zero-area corner contact still needs clearance on both sides.
      const horizontal = { x: x + stepX, y };
      const vertical = { x, y: y + stepY };
      for (const side of [horizontal, vertical]) {
        const sideCell = routingCellAt(grid, side);
        if (sideCell.blocked) return { valid: false, cost: Number.POSITIVE_INFINITY, cells, blockedAt: side };
      }
    }
    if (crossesX) { x += stepX; boundaryX += deltaX; }
    if (crossesY) { y += stepY; boundaryY += deltaY; }
    position = nextPosition;
  }
  return { valid: true, cost, cells };
}

function appendUnique(target: GridPoint[], source: readonly GridPoint[]): void {
  for (const point of source) {
    const previous = target.at(-1);
    if (previous?.x === point.x && previous.y === point.y) continue;
    target.push({ ...point });
  }
}

function riskRank(risk: RouteRisk): number {
  return risk === 'clear' ? 0 : risk === 'caution' ? 1 : 2;
}

function maxTraceRisk(grid: RoutingGrid, trace: SegmentTrace): number {
  let maximum = 0;
  for (const entry of trace.cells) maximum = Math.max(maximum, riskRank(routingCellAt(grid, entry.point).risk));
  return maximum;
}

function maxOriginalRisk(
  grid: RoutingGrid,
  edgeTraces: readonly SegmentTrace[],
  fromIndex: number,
  toIndex: number,
): number {
  let maximum = 0;
  for (let index = fromIndex; index < toIndex; index++) {
    maximum = Math.max(maximum, maxTraceRisk(grid, edgeTraces[index]!));
  }
  return maximum;
}

/** Sama riskiklass ei tohi peita uut, sisuliselt erinevat ohupõhjust. */
function introducesNewReason(
  grid: RoutingGrid,
  shortcut: SegmentTrace,
  edgeTraces: readonly SegmentTrace[],
  fromIndex: number,
  toIndex: number,
): boolean {
  const original = new Set<string>();
  for (let index = fromIndex; index < toIndex; index++) {
    for (const entry of edgeTraces[index]!.cells) {
      for (const reason of routingCellAt(grid, entry.point).reasons ?? []) original.add(reason);
    }
  }
  for (const entry of shortcut.cells) {
    for (const reason of routingCellAt(grid, entry.point).reasons ?? []) {
      if (!original.has(reason)) return true;
    }
  }
  return false;
}

function cellRiskSignature(grid: RoutingGrid, point: GridPoint): {
  risk: RouteRisk;
  reasons: string[];
  key: string;
} {
  const cell = routingCellAt(grid, point);
  const reasons = [...new Set((cell.reasons ?? []).filter((reason) => reason.length > 0))].sort();
  return { risk: cell.risk, reasons, key: `${cell.risk}\u0000${reasons.join('\u0000')}` };
}
