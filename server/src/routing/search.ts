import type {
  GridPoint,
  HierarchicalSearchOptions,
  PathSearchFailure,
  PathSearchOptions,
  PathSearchResult,
  RoutingCell,
  RoutingGrid,
  SearchFailureReason,
} from './engineTypes.js';
import {
  assertGridPoint,
  assertRoutingGrid,
  isTraversable,
  pointId,
  routingCellAt,
  traversableNeighbours,
  type CellPredicate,
} from './grid.js';
import { MinHeap } from './minHeap.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_EXPANDED_NODES = 1_000_000;
const DEFAULT_YIELD_EVERY = 4_096;
const EPSILON = 1e-12;

interface OpenNode {
  readonly id: number;
  readonly point: GridPoint;
  readonly g: number;
  readonly h: number;
  readonly f: number;
  readonly sequence: number;
}

function compareOpenNodes(a: OpenNode, b: OpenNode): number {
  return a.f - b.f
    || a.h - b.h
    || a.point.y - b.point.y
    || a.point.x - b.point.x
    || a.sequence - b.sequence;
}

interface SearchContext {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxExpandedNodes: number;
  readonly yieldEvery: number;
  readonly yieldControl: () => Promise<void>;
  readonly clock: () => number;
  readonly startedAt: number;
  expandedNodes: number;
  heapPushes: number;
  lastYieldAt: number;
}

interface InternalSearchOptions {
  readonly allowed?: CellPredicate;
  readonly minimumCostMultiplier: number;
}

/** Optimal deterministic A* over an eight-neighbour routing grid. */
export async function findPath(
  grid: RoutingGrid,
  start: GridPoint,
  goal: GridPoint,
  options: PathSearchOptions = {},
): Promise<PathSearchResult> {
  assertSearchInput(grid, start, goal);
  const context = createContext(options);
  const minimumCost = resolveMinimumCost(grid, options.minimumCostMultiplier);
  return runSearch(grid, start, goal, context, { minimumCostMultiplier: minimumCost });
}

/**
 * Coarse-to-fine A*: an optimistic coarse route limits the first fine search
 * to a corridor. The corridor is widened deterministically and, by default,
 * followed by a full-grid fallback so hierarchy cannot turn a valid route into
 * `no_route`. All stages share one abort/time/node budget.
 */
export async function findHierarchicalPath(
  grid: RoutingGrid,
  start: GridPoint,
  goal: GridPoint,
  options: HierarchicalSearchOptions = {},
): Promise<PathSearchResult> {
  assertSearchInput(grid, start, goal);
  const factor = integerOption(options.coarseFactor, 4, 1, 'coarseFactor');
  const padding = integerOption(options.corridorPadding, 1, 0, 'corridorPadding');
  const expansionSteps = integerOption(options.corridorExpansionSteps, 2, 0, 'corridorExpansionSteps');
  const context = createContext(options);
  const fineMinimumCost = resolveMinimumCost(grid, options.minimumCostMultiplier);

  const stopped = stopReason(context);
  if (stopped) return failure(stopped, context);
  if (!isTraversable(grid, start) || !isTraversable(grid, goal)) return failure('no_route', context);
  if (factor === 1 || (grid.width <= factor && grid.height <= factor)) {
    return runSearch(grid, start, goal, context, { minimumCostMultiplier: fineMinimumCost });
  }

  const coarse = buildCoarseGrid(grid, factor, fineMinimumCost);
  const coarseStart = { x: Math.floor(start.x / factor), y: Math.floor(start.y / factor) };
  const coarseGoal = { x: Math.floor(goal.x / factor), y: Math.floor(goal.y / factor) };
  const coarseResult = await runSearch(coarse, coarseStart, coarseGoal, context, {
    minimumCostMultiplier: resolveMinimumCost(coarse),
  });
  if (coarseResult.status === 'not_found') {
    if (coarseResult.reason !== 'no_route' || options.fallbackToFullGrid === false) return coarseResult;
    return runSearch(grid, start, goal, context, { minimumCostMultiplier: fineMinimumCost });
  }

  for (let expansion = 0; expansion <= expansionSteps; expansion++) {
    const allowed = coarseCorridor(coarseResult.path, coarse.width, coarse.height, padding + expansion);
    const result = await runSearch(grid, start, goal, context, {
      minimumCostMultiplier: fineMinimumCost,
      allowed: (point) => allowed.has(Math.floor(point.y / factor) * coarse.width + Math.floor(point.x / factor)),
    });
    if (result.status === 'found' || result.reason !== 'no_route') return result;
  }

  if (options.fallbackToFullGrid === false) return failure('no_route', context);
  return runSearch(grid, start, goal, context, { minimumCostMultiplier: fineMinimumCost });
}

async function runSearch(
  grid: RoutingGrid,
  start: GridPoint,
  goal: GridPoint,
  context: SearchContext,
  options: InternalSearchOptions,
): Promise<PathSearchResult> {
  const stopped = stopReason(context);
  if (stopped) return failure(stopped, context);
  if (!isTraversable(grid, start, options.allowed) || !isTraversable(grid, goal, options.allowed)) {
    return failure('no_route', context);
  }
  if (samePoint(start, goal)) {
    return {
      status: 'found',
      path: [{ ...start }],
      totalCost: 0,
      expandedNodes: context.expandedNodes,
      heapPushes: context.heapPushes,
    };
  }

  const size = grid.width * grid.height;
  const scores = new Float64Array(size);
  scores.fill(Number.POSITIVE_INFINITY);
  const parents = new Int32Array(size);
  parents.fill(-1);
  const closed = new Uint8Array(size);
  const open = new MinHeap<OpenNode>(compareOpenNodes);
  const startId = pointId(grid, start);
  const goalId = pointId(grid, goal);
  let sequence = 0;
  const startH = octileDistance(start, goal) * options.minimumCostMultiplier;
  scores[startId] = 0;
  open.push({ id: startId, point: start, g: 0, h: startH, f: startH, sequence: sequence++ });
  context.heapPushes++;

  while (open.size > 0) {
    const stop = stopReason(context);
    if (stop) return failure(stop, context);
    const current = open.pop()!;
    if (closed[current.id] || Math.abs(current.g - scores[current.id]!) > EPSILON) continue;
    if (current.id === goalId) {
      return {
        status: 'found',
        path: reconstructPath(grid, parents, current.id),
        totalCost: current.g,
        expandedNodes: context.expandedNodes,
        heapPushes: context.heapPushes,
      };
    }
    if (context.expandedNodes >= context.maxExpandedNodes) return failure('node_limit', context);

    closed[current.id] = 1;
    context.expandedNodes++;
    const currentCell = routingCellAt(grid, current.point);
    for (const neighbour of traversableNeighbours(grid, current.point, options.allowed)) {
      const nextId = pointId(grid, neighbour.point);
      const nextCell = routingCellAt(grid, neighbour.point);
      const edgeCost = neighbour.distance * (currentCell.costMultiplier + nextCell.costMultiplier) / 2;
      const tentative = current.g + edgeCost;
      if (tentative + EPSILON >= scores[nextId]!) continue;
      scores[nextId] = tentative;
      parents[nextId] = current.id;
      closed[nextId] = 0;
      const h = octileDistance(neighbour.point, goal) * options.minimumCostMultiplier;
      open.push({ id: nextId, point: neighbour.point, g: tentative, h, f: tentative + h, sequence: sequence++ });
      context.heapPushes++;
    }

    if (context.yieldEvery > 0
      && context.expandedNodes - context.lastYieldAt >= context.yieldEvery) {
      context.lastYieldAt = context.expandedNodes;
      await context.yieldControl();
    }
  }
  return failure('no_route', context);
}

function createContext(options: PathSearchOptions): SearchContext {
  const timeoutMs = finiteOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 0, 'timeoutMs');
  const maxExpandedNodes = integerOption(
    options.maxExpandedNodes,
    DEFAULT_MAX_EXPANDED_NODES,
    0,
    'maxExpandedNodes',
  );
  const yieldEvery = integerOption(options.yieldEvery, DEFAULT_YIELD_EVERY, 0, 'yieldEvery');
  const clock = options.clock ?? performance.now.bind(performance);
  const startedAt = clock();
  return {
    signal: options.signal,
    timeoutMs,
    maxExpandedNodes,
    yieldEvery,
    yieldControl: options.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve))),
    clock,
    startedAt,
    expandedNodes: 0,
    heapPushes: 0,
    lastYieldAt: 0,
  };
}

function stopReason(context: SearchContext): SearchFailureReason | null {
  if (context.signal?.aborted) return 'aborted';
  if (context.clock() - context.startedAt >= context.timeoutMs) return 'timeout';
  return null;
}

function failure(reason: SearchFailureReason, context: SearchContext): PathSearchFailure {
  return { status: 'not_found', reason, expandedNodes: context.expandedNodes, heapPushes: context.heapPushes };
}

function resolveMinimumCost(grid: RoutingGrid, override?: number): number {
  const value = override ?? grid.minimumCostMultiplier ?? 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('minimumCostMultiplier must be a finite non-negative lower bound');
  }
  return value;
}

function assertSearchInput(grid: RoutingGrid, start: GridPoint, goal: GridPoint): void {
  assertRoutingGrid(grid);
  assertGridPoint(grid, start, 'start');
  assertGridPoint(grid, goal, 'goal');
}

function finiteOption(value: number | undefined, fallback: number, minimum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum) throw new RangeError(`${name} must be at least ${minimum}`);
  return resolved;
}

export function integerOption(value: number | undefined, fallback: number, minimum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum) throw new RangeError(`${name} must be an integer of at least ${minimum}`);
  return resolved;
}

function octileDistance(a: GridPoint, b: GridPoint): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.min(dx, dy) * Math.SQRT2 + Math.abs(dx - dy);
}

function reconstructPath(grid: RoutingGrid, parents: Int32Array, goalId: number): GridPoint[] {
  const reversed: GridPoint[] = [];
  let id = goalId;
  while (id >= 0) {
    reversed.push({ x: id % grid.width, y: Math.floor(id / grid.width) });
    id = parents[id]!;
  }
  reversed.reverse();
  return reversed;
}

function samePoint(a: GridPoint, b: GridPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

function buildCoarseGrid(grid: RoutingGrid, factor: number, minimumCostMultiplier: number): RoutingGrid {
  const width = Math.ceil(grid.width / factor);
  const height = Math.ceil(grid.height / factor);
  // Compute blocks on demand. Eagerly scanning every fine cell would add an
  // uninterruptible O(width*height) pass before A* gets to enforce its budget.
  const cells: Array<RoutingCell | undefined> = new Array(width * height);

  return {
    width,
    height,
    minimumCostMultiplier,
    cellAt(coarseX, coarseY) {
      const index = coarseY * width + coarseX;
      const cached = cells[index];
      if (cached != null) return cached;
      let best: RoutingCell | null = null;
      const maxY = Math.min(grid.height, (coarseY + 1) * factor);
      const maxX = Math.min(grid.width, (coarseX + 1) * factor);
      for (let y = coarseY * factor; y < maxY; y++) {
        for (let x = coarseX * factor; x < maxX; x++) {
          const cell = routingCellAt(grid, { x, y });
          if (cell.blocked || (best != null && cell.costMultiplier >= best.costMultiplier)) continue;
          best = cell;
        }
      }
      const resolved: RoutingCell = best == null
        ? { blocked: true, costMultiplier: 1, risk: 'clear' }
        : { blocked: false, costMultiplier: best.costMultiplier, risk: best.risk, reasons: best.reasons };
      cells[index] = resolved;
      return resolved;
    },
  };
}

function coarseCorridor(path: readonly GridPoint[], width: number, height: number, padding: number): Set<number> {
  const allowed = new Set<number>();
  for (const point of path) {
    for (let y = Math.max(0, point.y - padding); y <= Math.min(height - 1, point.y + padding); y++) {
      for (let x = Math.max(0, point.x - padding); x <= Math.min(width - 1, point.x + padding); x++) {
        allowed.add(y * width + x);
      }
    }
  }
  return allowed;
}
