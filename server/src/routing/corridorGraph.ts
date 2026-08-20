import type { GridPoint } from './engineTypes.js';
import { isInsideGrid, isTraversable, pointFromId, pointId, traversableNeighbours } from './grid.js';
import {
  isSmallCraftRoutingProfile,
  type RoutingCostSurface,
  type RoutingVesselProfile,
} from './costSurface.js';
import { MinHeap } from './minHeap.js';
import {
  distanceM,
  type PreparedPathLine,
  type PreparedRoutingGraph,
  type PreparedRoutingGraphEdge,
} from './preparedGraph.js';
import {
  appendPositionedPoint,
  type PositionedGridPoint,
} from './segments.js';
import type { Position, RoutingSourceId } from './sourceTypes.js';

// Sama soodustus, mida täpse valmisvektori kordusvalideerimine kasutab:
// avaldatud tee võib olla vabast veest pikem, kuid 100 m sisenemiskulu hoiab
// lühikesed kõrvalharud marsruudist väljas.
const EDGE_MULTIPLIER = 0.55;
const GRAPH_ENTRY_PENALTY_M = 100;
const DEFAULT_MAX_EXPANDED_NODES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const YIELD_EVERY = 8_192;
const EPSILON = 1e-12;
const HARD_VECTOR_REASONS = new Set([
  'hazard',
  'restricted_area',
  'separation_zone',
  'structure_clearance',
]);

interface QueueItem {
  id: number;
  g: number;
  h: number;
  f: number;
  sequence: number;
}

interface GraphEdge {
  to: number;
  distance: number;
  traversalMultiplier: number;
  fromPosition: Position;
  toPosition: Position;
  kind: 'official' | 'recommended';
  sourceIds: RoutingSourceId[];
}

interface CorridorGraph {
  edges: Map<number, GraphEdge[]>;
  positions: Map<number, Position>;
  points: Map<number, GridPoint>;
}

interface Portals {
  graphByCell: Map<number, number[]>;
  cellsByGraph: Map<number, GridPoint[]>;
}

export interface CorridorBackboneRoute {
  path: PositionedGridPoint[];
  protectedPoints: PositionedGridPoint[];
  trustedPaths: PreparedPathLine[];
  totalCost: number;
  expandedNodes: number;
  graphNodes: number;
}

export interface CorridorBackboneAttempt {
  route: CorridorBackboneRoute | null;
  expandedNodes: number;
  graphNodes: number;
  startCandidates: number;
  endCandidates: number;
}

export interface CorridorBackboneOptions {
  surface: RoutingCostSurface;
  graph: PreparedRoutingGraph;
  vessel: RoutingVesselProfile;
  start: GridPoint;
  end: GridPoint;
  checkpoint?: () => void;
  yieldControl?: () => Promise<void>;
  maxExpandedNodes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Üks A* liigub nii ohutusvõrel kui valmis keskjoonte graafil. Graafi ja võre
 * vahel võib vahetada igas tegelikus kontaktlahtris, mistõttu ei ole vaja
 * eraldi kohaliku, kaug- ega domineeriva komponendi erijuhte.
 */
export async function findCorridorBackboneRoute(
  options: CorridorBackboneOptions,
): Promise<CorridorBackboneAttempt> {
  const checkpoint = options.checkpoint ?? (() => undefined);
  checkpoint();
  const graph = projectPreparedGraph(options.surface, options.graph, options.vessel, checkpoint);
  const graphNodes = graph.edges.size;
  if (graphNodes < 2 || !isTraversable(options.surface, options.start)
    || !isTraversable(options.surface, options.end)) {
    return emptyAttempt(graphNodes);
  }

  const portals = buildPortals(options.surface, graph, options.vessel);
  const startCandidates = portals.graphByCell.get(pointId(options.surface, options.start))?.length ?? 0;
  const endCandidates = portals.graphByCell.get(pointId(options.surface, options.end))?.length ?? 0;
  const gridSize = options.surface.width * options.surface.height;
  const stateCount = gridSize + options.graph.nodes.length;
  const scores = new Float64Array(stateCount);
  scores.fill(Number.POSITIVE_INFINITY);
  const parents = new Int32Array(stateCount);
  parents.fill(-1);
  const closed = new Uint8Array(stateCount);
  const open = new MinHeap<QueueItem>(compareQueueItems);
  const startId = pointId(options.surface, options.start);
  const goalId = pointId(options.surface, options.end);
  const minimumMultiplier = Math.min(
    options.surface.minimumCostMultiplier ?? EDGE_MULTIPLIER,
    EDGE_MULTIPLIER,
  );
  const startedAt = performance.now();
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxExpandedNodes = Math.max(1, Math.floor(
    options.maxExpandedNodes ?? DEFAULT_MAX_EXPANDED_NODES,
  ));
  const yieldControl = options.yieldControl
    ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let expandedNodes = 0;
  let sequence = 0;
  scores[startId] = 0;
  const startH = heuristic(options.start, options.end, minimumMultiplier);
  open.push({ id: startId, g: 0, h: startH, f: startH, sequence: sequence++ });

  const push = (fromId: number, toId: number, edgeCost: number): void => {
    if (!Number.isFinite(edgeCost) || edgeCost < 0) return;
    const tentative = scores[fromId]! + edgeCost;
    if (tentative + EPSILON >= scores[toId]!) return;
    scores[toId] = tentative;
    parents[toId] = fromId;
    closed[toId] = 0;
    const point = statePoint(options.surface, graph, gridSize, toId);
    const h = heuristic(point, options.end, minimumMultiplier);
    open.push({ id: toId, g: tentative, h, f: tentative + h, sequence: sequence++ });
  };

  while (open.size > 0) {
    if (options.signal?.aborted || performance.now() - startedAt >= timeoutMs
      || expandedNodes >= maxExpandedNodes) {
      return { route: null, expandedNodes, graphNodes, startCandidates, endCandidates };
    }
    const current = open.pop()!;
    if (closed[current.id] || Math.abs(scores[current.id]! - current.g) > EPSILON) continue;
    if (current.id === goalId) {
      const route = reconstructHybridRoute(
        options.surface,
        graph,
        parents,
        gridSize,
        goalId,
        current.g,
        expandedNodes,
      );
      return { route, expandedNodes, graphNodes, startCandidates, endCandidates };
    }
    closed[current.id] = 1;
    expandedNodes++;

    if (current.id < gridSize) {
      const point = pointFromId(options.surface, current.id);
      const currentCell = options.surface.cellAt(point.x, point.y);
      for (const neighbour of traversableNeighbours(options.surface, point)) {
        const nextCell = options.surface.cellAt(neighbour.point.x, neighbour.point.y);
        const transition = options.surface.transitionCostMultiplier?.(point, neighbour.point) ?? 1;
        push(
          current.id,
          pointId(options.surface, neighbour.point),
          neighbour.distance * (currentCell.costMultiplier + nextCell.costMultiplier) / 2 * transition,
        );
      }
      for (const graphId of portals.graphByCell.get(current.id) ?? []) {
        const graphPoint = graph.points.get(graphId)!;
        push(
          current.id,
          gridSize + graphId,
          portalCost(options.surface, point, graphPoint, graph.positions.get(graphId))
            + Math.max(1, GRAPH_ENTRY_PENALTY_M / options.surface.projection.cellSizeM),
        );
      }
    } else {
      const graphId = current.id - gridSize;
      for (const edge of graph.edges.get(graphId) ?? []) {
        push(
          current.id,
          gridSize + edge.to,
          edge.distance * EDGE_MULTIPLIER * edge.traversalMultiplier,
        );
      }
      const graphPoint = graph.points.get(graphId)!;
      for (const cell of portals.cellsByGraph.get(graphId) ?? []) {
        push(
          current.id,
          pointId(options.surface, cell),
          portalCost(options.surface, cell, graphPoint, graph.positions.get(graphId)),
        );
      }
    }

    if (expandedNodes % YIELD_EVERY === 0) {
      checkpoint();
      await yieldControl();
    }
  }
  return { route: null, expandedNodes, graphNodes, startCandidates, endCandidates };
}

function emptyAttempt(graphNodes: number): CorridorBackboneAttempt {
  return { route: null, expandedNodes: 0, graphNodes, startCandidates: 0, endCandidates: 0 };
}

function compareQueueItems(left: QueueItem, right: QueueItem): number {
  return left.f - right.f || left.h - right.h || left.id - right.id || left.sequence - right.sequence;
}

function heuristic(from: GridPoint, to: GridPoint, multiplier: number): number {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * multiplier;
}

function statePoint(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  gridSize: number,
  id: number,
): GridPoint {
  return id < gridSize ? pointFromId(surface, id) : graph.points.get(id - gridSize)!;
}

function buildPortals(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  vessel: RoutingVesselProfile,
): Portals {
  const graphByCell = new Map<number, number[]>();
  const cellsByGraph = new Map<number, GridPoint[]>();
  const smallCraft = isSmallCraftRoutingProfile(vessel);
  for (const [graphId, graphPoint] of graph.points) {
    const cells: GridPoint[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = { x: graphPoint.x + dx, y: graphPoint.y + dy };
        if (!isInsideGrid(surface, cell) || !isTraversable(surface, cell)) continue;
        if (!portalAllowed(
          surface,
          graphPoint,
          cell,
          graph.positions.get(graphId),
          smallCraft,
        )) continue;
        cells.push(cell);
        const cellId = pointId(surface, cell);
        const ids = graphByCell.get(cellId) ?? [];
        if (!ids.includes(graphId)) ids.push(graphId);
        graphByCell.set(cellId, ids);
      }
    }
    if (cells.length) cellsByGraph.set(graphId, cells);
  }
  return { graphByCell, cellsByGraph };
}

function portalAllowed(
  surface: RoutingCostSurface,
  graphPoint: GridPoint,
  cell: GridPoint,
  graphPosition: Position | undefined,
  smallCraft: boolean,
): boolean {
  if (!smallCraft && !isTraversable(surface, graphPoint)) return false;
  const graphDetails = surface.detailsAt(graphPoint.x, graphPoint.y);
  if (graphDetails.blocked && graphDetails.reasons.some((reason) => HARD_VECTOR_REASONS.has(reason))) {
    return false;
  }
  if (graphPosition
    && surface.positionTransitionAllowed?.(surface.toPosition(cell), graphPosition) === false) {
    return false;
  }
  if (graphPoint.x !== cell.x && graphPoint.y !== cell.y) {
    const sideA = { x: graphPoint.x, y: cell.y };
    const sideB = { x: cell.x, y: graphPoint.y };
    if ((!smallCraft || isTraversable(surface, graphPoint))
      && (!isTraversable(surface, sideA) || !isTraversable(surface, sideB))) return false;
  }
  return true;
}

function portalCost(
  surface: RoutingCostSurface,
  gridPoint: GridPoint,
  graphPoint: GridPoint,
  graphPosition?: Position,
): number {
  const distance = graphPosition
    ? distanceM(surface.toPosition(gridPoint), graphPosition) / surface.projection.cellSizeM
    : Math.hypot(graphPoint.x - gridPoint.x, graphPoint.y - gridPoint.y);
  if (distance <= EPSILON) return 0;
  const gridCell = surface.cellAt(gridPoint.x, gridPoint.y);
  const graphCell = surface.cellAt(graphPoint.x, graphPoint.y);
  const graphCost = graphCell.blocked ? 1 : graphCell.costMultiplier;
  const transition = surface.transitionCostMultiplier?.(gridPoint, graphPoint) ?? 1;
  return distance * (gridCell.costMultiplier + graphCost) / 2 * transition;
}

function projectPreparedGraph(
  surface: RoutingCostSurface,
  prepared: PreparedRoutingGraph,
  vessel: RoutingVesselProfile,
  checkpoint: () => void,
): CorridorGraph {
  const smallCraft = isSmallCraftRoutingProfile(vessel);
  if (smallCraft) {
    const cached = smallCraftProjections.get(prepared);
    if (cached && sameProjection(cached.projection, surface.projection)) return cached.graph;
  }
  const positions = new Map<number, Position>();
  const points = new Map<number, GridPoint>();
  const edgeMaps = new Map<number, Map<number, GraphEdge>>();
  const projected = new Map<number, GridPoint | null>();
  const pointFor = (id: number): GridPoint | null => {
    if (projected.has(id)) return projected.get(id)!;
    const node = prepared.nodes[id];
    if (!node) return null;
    const raw = surface.toGrid({ lon: node.position[0], lat: node.position[1] });
    const point = { x: Math.round(raw.x), y: Math.round(raw.y) };
    const value = isInsideGrid(surface, point) ? point : null;
    projected.set(id, value);
    return value;
  };

  for (const [edgeIndex, edge] of prepared.edges.entries()) {
    if ((edgeIndex & 255) === 0) checkpoint();
    if (!preparedEdgeIsUsable(edge, vessel)) continue;
    const fromPoint = pointFor(edge.from);
    const toPoint = pointFor(edge.to);
    const fromNode = prepared.nodes[edge.from];
    const toNode = prepared.nodes[edge.to];
    if (!fromPoint || !toPoint || !fromNode || !toNode) continue;
    if (!publishedEdgeAllowed(
      surface,
      fromPoint,
      toPoint,
      fromNode.position,
      toNode.position,
      smallCraft,
    )) continue;
    positions.set(edge.from, fromNode.position);
    positions.set(edge.to, toNode.position);
    points.set(edge.from, fromPoint);
    points.set(edge.to, toPoint);
    const projectedDistance = Math.hypot(
      toPoint.x - fromPoint.x,
      toPoint.y - fromPoint.y,
    );
    const geographicDistance = distanceM(fromNode.position, toNode.position)
      / surface.projection.cellSizeM;
    // Testvõred kasutavad teadlikult koordinaate otse x/y-na. Päris
    // geograafilisel projektsioonil säilitame alati täpse meetripikkuse;
    // sünteetilise võre tuvastab ebarealistlikult suur geo-/võresuhte erinevus.
    const distance = projectedDistance > EPSILON && geographicDistance > projectedDistance * 4
      ? projectedDistance
      : geographicDistance;
    addDirectedEdge(edgeMaps, edge.from, edge.to, {
      to: edge.to,
      distance,
      traversalMultiplier: publishedEdgeTrafficMultiplier(surface, fromPoint, toPoint),
      fromPosition: fromNode.position,
      toPosition: toNode.position,
      kind: edge.official ? 'official' : 'recommended',
      sourceIds: [...edge.sourceIds],
    });
    addDirectedEdge(edgeMaps, edge.to, edge.from, {
      to: edge.from,
      distance,
      traversalMultiplier: publishedEdgeTrafficMultiplier(surface, toPoint, fromPoint),
      fromPosition: toNode.position,
      toPosition: fromNode.position,
      kind: edge.official ? 'official' : 'recommended',
      sourceIds: [...edge.sourceIds],
    });
  }
  const edges = new Map([...edgeMaps].map(([id, values]) => [id, [...values.values()]]));
  const graph = { edges, positions, points };
  if (smallCraft) smallCraftProjections.set(prepared, { projection: surface.projection, graph });
  return graph;
}

const smallCraftProjections = new WeakMap<
  PreparedRoutingGraph,
  { projection: RoutingCostSurface['projection']; graph: CorridorGraph }
>();

function sameProjection(
  left: RoutingCostSurface['projection'],
  right: RoutingCostSurface['projection'],
): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.cellSizeM === right.cellSizeM
    && left.lonStep === right.lonStep
    && left.latStep === right.latStep
    && left.metresPerLongitudeDegree === right.metresPerLongitudeDegree
    && left.bbox.every((value, index) => value === right.bbox[index]);
}

function addDirectedEdge(
  edges: Map<number, Map<number, GraphEdge>>,
  from: number,
  to: number,
  edge: GraphEdge,
): void {
  if (from === to || edge.distance <= 0) return;
  const outgoing = edges.get(from) ?? new Map<number, GraphEdge>();
  const existing = outgoing.get(to);
  if (!existing || edge.distance < existing.distance) outgoing.set(to, edge);
  edges.set(from, outgoing);
}

function preparedEdgeIsUsable(
  edge: PreparedRoutingGraphEdge,
  vessel: RoutingVesselProfile,
): boolean {
  if (isSmallCraftRoutingProfile(vessel)) return true;
  const requiredDepthM = vessel.draughtM + vessel.underKeelClearanceM;
  if (edge.depthM !== undefined && edge.depthM < requiredDepthM) return false;
  if (edge.maxDraughtM !== undefined && edge.maxDraughtM < requiredDepthM) return false;
  if (edge.widthM !== undefined && edge.widthM < vessel.beamM) return false;
  return true;
}

function publishedEdgeAllowed(
  surface: RoutingCostSurface,
  from: GridPoint,
  to: GridPoint,
  fromPosition: Position,
  toPosition: Position,
  smallCraft: boolean,
): boolean {
  if (surface.positionTransitionAllowed?.(fromPosition, toPosition) === false) return false;
  for (const point of traceGridLine(from, to)) {
    const details = surface.detailsAt(point.x, point.y);
    if (!details.blocked) continue;
    if (!smallCraft || details.reasons.some((reason) => HARD_VECTOR_REASONS.has(reason))) return false;
  }
  return true;
}

function publishedEdgeTrafficMultiplier(
  surface: RoutingCostSurface,
  from: GridPoint,
  to: GridPoint,
): number {
  let multiplier = 1;
  for (const point of traceGridLine(from, to)) {
    multiplier = Math.max(
      multiplier,
      surface.transitionDetails?.(from, to, point).costMultiplier ?? 1,
    );
  }
  return multiplier;
}

function traceGridLine(from: GridPoint, to: GridPoint): GridPoint[] {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  const result: GridPoint[] = [];
  for (let step = 0; step <= steps; step++) {
    const ratio = steps === 0 ? 0 : step / steps;
    const point = {
      x: Math.round(from.x + (to.x - from.x) * ratio),
      y: Math.round(from.y + (to.y - from.y) * ratio),
    };
    const last = result.at(-1);
    if (!last || last.x !== point.x || last.y !== point.y) result.push(point);
  }
  return result;
}

function reconstructHybridRoute(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  parents: Int32Array,
  gridSize: number,
  goalId: number,
  totalCost: number,
  expandedNodes: number,
): CorridorBackboneRoute {
  const states: number[] = [];
  let id = goalId;
  for (let count = 0; count <= parents.length; count++) {
    states.push(id);
    if (parents[id] === -1) break;
    id = parents[id]!;
  }
  states.reverse();
  const path: PositionedGridPoint[] = [];
  for (const state of states) {
    if (state < gridSize) appendPositionedPoint(path, pointFromId(surface, state));
    else {
      const graphId = state - gridSize;
      appendPositionedPoint(path, {
        ...graph.points.get(graphId)!,
        position: graph.positions.get(graphId),
      });
    }
  }

  const graphRuns: number[][] = [];
  let currentRun: number[] = [];
  for (const state of states) {
    if (state >= gridSize) currentRun.push(state - gridSize);
    else if (currentRun.length) {
      graphRuns.push(currentRun);
      currentRun = [];
    }
  }
  if (currentRun.length) graphRuns.push(currentRun);
  const positionedRuns = graphRuns
    .filter((run) => run.length >= 2)
    .map((run) => positionedGraphPath(graph, run));
  return {
    path,
    protectedPoints: protectUsedBackbone(positionedRuns),
    trustedPaths: graphRuns.flatMap((run) => trustedGraphPaths(graph, run)),
    totalCost,
    expandedNodes,
    graphNodes: graph.edges.size,
  };
}

function positionedGraphPath(graph: CorridorGraph, ids: readonly number[]): PositionedGridPoint[] {
  return ids.map((id) => ({
    ...graph.points.get(id)!,
    position: graph.positions.get(id),
  }));
}

function trustedGraphPaths(graph: CorridorGraph, ids: readonly number[]): PreparedPathLine[] {
  const result: PreparedPathLine[] = [];
  let current: PreparedPathLine | null = null;
  let currentKey = '';
  for (let index = 1; index < ids.length; index++) {
    const fromId = ids[index - 1]!;
    const toId = ids[index]!;
    const edge = graph.edges.get(fromId)?.find((candidate) => candidate.to === toId);
    if (!edge) continue;
    const key = `${edge.kind}\0${edge.sourceIds.join(',')}`;
    const from = { ...graph.points.get(fromId)!, position: edge.fromPosition };
    const to = { ...graph.points.get(toId)!, position: edge.toPosition };
    if (!current || key !== currentKey) {
      current = { points: [from, to], kind: edge.kind, sourceIds: [...edge.sourceIds] };
      result.push(current);
      currentKey = key;
    } else {
      (current.points as PositionedGridPoint[]).push(to);
    }
  }
  return result;
}

function protectUsedBackbone(
  groups: ReadonlyArray<readonly PositionedGridPoint[]>,
): PositionedGridPoint[] {
  const result: PositionedGridPoint[] = [];
  for (const group of groups) {
    for (const point of douglasPeucker(group, 0.05)) appendPositionedPoint(result, point);
  }
  return result;
}

function douglasPeucker(
  path: readonly PositionedGridPoint[],
  toleranceM: number,
): PositionedGridPoint[] {
  if (path.length <= 2) return path.map((point) => ({ ...point }));
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = toleranceM;
    for (let index = first + 1; index < last; index++) {
      const distance = geographicSegmentDistance(path[index]!, path[first]!, path[last]!);
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([first, farthest], [farthest, last]);
  }
  return path.filter((_point, index) => keep[index]).map((point) => ({ ...point }));
}

function geographicSegmentDistance(
  point: PositionedGridPoint,
  from: PositionedGridPoint,
  to: PositionedGridPoint,
): number {
  const pointPosition = point.position;
  const fromPosition = from.position;
  const toPosition = to.position;
  if (!pointPosition || !fromPosition || !toPosition) {
    return pointSegmentDistance(point.x, point.y, from.x, from.y, to.x, to.y);
  }
  const latitude = (fromPosition[1] + toPosition[1]) / 2 * Math.PI / 180;
  const metresPerLon = 111_320 * Math.cos(latitude);
  return pointSegmentDistance(
    pointPosition[0] * metresPerLon,
    pointPosition[1] * 111_320,
    fromPosition[0] * metresPerLon,
    fromPosition[1] * 111_320,
    toPosition[0] * metresPerLon,
    toPosition[1] * 111_320,
  );
}

function pointSegmentDistance(
  px: number,
  py: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.max(0, Math.min(1,
    ((px - fromX) * dx + (py - fromY) * dy) / denominator));
  return Math.hypot(px - (fromX + dx * ratio), py - (fromY + dy * ratio));
}
