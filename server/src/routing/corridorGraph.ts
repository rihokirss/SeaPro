import type { GridPoint, PathSearchOptions, PathSearchResult } from './engineTypes.js';
import { isInsideGrid, isTraversable, pointFromId, pointId, traversableNeighbours } from './grid.js';
import {
  isSmallCraftRoutingProfile,
  type RoutingCostSurface,
  type RoutingVesselProfile,
} from './costSurface.js';
import { MinHeap } from './minHeap.js';
import { findPath, integerOption } from './search.js';
import {
  distanceM,
  type PreparedPathLine,
  type PreparedRoutingGraph,
  type PreparedRoutingGraphEdge,
} from './preparedGraph.js';
import {
  appendPositionedPoint,
  pointSegmentDistance,
  type PositionedGridPoint,
} from './segments.js';
import type { Position, RoutingSourceId } from './sourceTypes.js';

const METRES_PER_NAUTICAL_MILE = 1_852;
const MIN_CONNECTOR_DISTANCE_M = 4 * METRES_PER_NAUTICAL_MILE;
const MAX_CONNECTOR_DISTANCE_M = 6 * METRES_PER_NAUTICAL_MILE;
const CONNECTOR_DISTANCE_RATIO = 0.1;
const CONNECTOR_CANDIDATE_SLACK_M = 2 * METRES_PER_NAUTICAL_MILE;
const DEFAULT_MAX_EXPANDED_NODES = 400_000;
// Graafi sees on kõik avaldatud keskjooned võrdse kaaluga, et paralleelsete
// ametlike/soovituslike harude vahel valitaks päriselt lühim. Ühtlane soodustus
// võrreldes vaba vee ühendusega paneb ökonoomse kogutee kasutama mõistliku
// pikkusega valmis võrku, mitte valima 100 km otseühendust sihtsadama kõrval
// oleva terminalini.
const EDGE_MULTIPLIER = 0.75;
const MAX_REMOTE_CANDIDATES = 24;
const MAX_REMOTE_SEARCH_CANDIDATES = 4;
const MAX_REMOTE_INTERIOR_EXPANDED_NODES = 75_000;
const MAX_DISCONNECTED_PAIRS = 4;
const DOMINANT_NETWORK_RATIO = 8;
const REMOTE_CANDIDATE_SPACING_CELLS = 4;
const YIELD_EVERY = 8_192;
const EPSILON = 1e-12;

interface QueueItem {
  id: number;
  cost: number;
}

function compareQueueItems(a: QueueItem, b: QueueItem): number {
  return a.cost - b.cost || a.id - b.id;
}

interface GraphEdge {
  to: number;
  distance: number;
  fromPosition: Position;
  toPosition: Position;
  kind: 'official' | 'recommended';
  sourceIds: RoutingSourceId[];
}

interface CorridorGraph {
  edges: Map<number, GraphEdge[]>;
  positions: Map<number, Position>;
  points: Map<number, GridPoint>;
  nodesByCell: Map<number, number[]>;
  terminals: Set<number>;
}

interface ConnectorSearch {
  graphCosts: Map<number, number>;
  parents: Int32Array;
  expandedNodes: number;
}

interface ResolvedBackbone {
  startPath: GridPoint[];
  prefixGraphPath?: number[];
  bridgePath?: GridPoint[];
  graphPath: number[];
  endPath: GridPoint[];
  totalCost: number;
  expandedNodes: number;
}

export interface CorridorBackboneRoute {
  path: PositionedGridPoint[];
  /** Keskjoonel valitud punktid, mida lõppgeomeetria ei tohi vahele jätta. */
  protectedPoints: PositionedGridPoint[];
  /** Ainult kasutatud graafiosad; eraldi read ei tekita katkestuse üle valeühendust. */
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
  remoteEndNetworkCost?: number;
  remoteStartNetworkCost?: number;
  bothNetworksCost?: number;
  remoteSelection?: 'both_networks' | 'end_network' | 'start_network';
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
  maxConnectorDistanceM?: number;
  signal?: AbortSignal;
  connectorTimeoutMs?: number;
}

/**
 * Leiab marsruudi, mille keskosa järgib avaldatud laevatee keskjooni.
 *
 * Alguse ja lõpu ühendusi ei valita teineteisest sõltumatult ega pelgalt
 * geomeetrilise läheduse järgi. Mõlemast otsast tehakse ohutul kulupinnal
 * piiratud Dijkstra, seejärel lahendatakse kõik sisenemis-/väljumispaarid ühe
 * mitme lähtega graafiotsinguna. Nii minimeeritakse ühenduste ja laevatee
 * kogukulu ning välditakse lähimale harule minekust tekkivat tagasipööret.
 */
export async function findCorridorBackboneRoute(
  options: CorridorBackboneOptions,
): Promise<CorridorBackboneAttempt> {
  const checkpoint = options.checkpoint ?? (() => undefined);
  checkpoint();
  const graph = projectPreparedGraph(options.surface, options.graph, options.vessel, checkpoint);
  if (graph.edges.size < 2) {
    return {
      route: null,
      expandedNodes: 0,
      graphNodes: graph.edges.size,
      startCandidates: 0,
      endCandidates: 0,
    };
  }

  const directDistanceM = Math.hypot(
    options.end.x - options.start.x,
    options.end.y - options.start.y,
  ) * options.surface.projection.cellSizeM;
  const connectorDistanceM = options.maxConnectorDistanceM ?? Math.max(
    options.surface.projection.cellSizeM * 2,
    Math.min(
      directDistanceM * 0.4,
      Math.max(
        MIN_CONNECTOR_DISTANCE_M,
        Math.min(MAX_CONNECTOR_DISTANCE_M, directDistanceM * CONNECTOR_DISTANCE_RATIO),
      ),
    ),
  );
  const connectorRadiusCells = connectorDistanceM / options.surface.projection.cellSizeM;
  const maxExpandedNodes = integerOption(
    options.maxExpandedNodes,
    DEFAULT_MAX_EXPANDED_NODES,
    1,
    'maxExpandedNodes',
  );
  const firstBudget = Math.max(1, Math.floor(maxExpandedNodes / 2));
  const secondBudget = Math.max(1, maxExpandedNodes - firstBudget);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const connectorSurface = isSmallCraftRoutingProfile(options.vessel)
    ? withOpenConnectorCells(options.surface, graph.nodesByCell)
    : options.surface;

  const startSearch = await searchConnectors(
    connectorSurface,
    options.start,
    graph,
    connectorRadiusCells,
    firstBudget,
    checkpoint,
    yieldControl,
  );
  const endSearch = await searchConnectors(
    connectorSurface,
    options.end,
    graph,
    connectorRadiusCells,
    secondBudget,
    checkpoint,
    yieldControl,
  );
  const connectorExpandedNodes = startSearch.expandedNodes + endSearch.expandedNodes;
  let resolved: ResolvedBackbone | null = null;
  let remoteEndNetworkCost: number | undefined;
  let remoteStartNetworkCost: number | undefined;
  let bothNetworksCost: number | undefined;
  let remoteSelection: CorridorBackboneAttempt['remoteSelection'];
  const remainingBudget = Math.max(0, maxExpandedNodes - connectorExpandedNodes);
  if (startSearch.graphCosts.size > 0 && endSearch.graphCosts.size > 0) {
    const graphSearch = searchGraphDijkstra(
      graph,
      startSearch.graphCosts,
      checkpoint,
      endSearch.graphCosts,
    );
    resolved = resolveLocalBackbone(
      options.surface,
      graph,
      options.start,
      options.end,
      startSearch,
      endSearch,
      graphSearch,
    );
    // Avamerel võivad mõlema sadama lähedal olla eri, omavahel ühendamata
    // võrgud. Arvutame mõlemad tervikteed ning valime sisenemise, vektoriosa ja
    // väljumise tegeliku ühise kogukulu järgi.
    if (!resolved && remainingBudget > 0) {
      // Kohalik sadamaharuke võib olla küll lähedal, kuid viia vastassuunas
      // (Tilgu puhul Meeruse sadamasse). Ühe võrgu variandis säilitame kahest
      // komponendist suurema põhivõrgu ja jätame väikese kõrvalharu vahele.
      // Nii ei arvutata ka teist pikka A*-d, mille ainus tulemus oleks suure
      // põhivõrgu asendamine väikese tupikuga.
      const startNetworkNodes = reachableGraphNodes(graph, startSearch.graphCosts.keys());
      const endNetworkNodes = reachableGraphNodes(graph, endSearch.graphCosts.keys());
      const keepEndNetwork = endNetworkNodes >= startNetworkNodes;
      const dominantNetwork = Math.max(startNetworkNodes, endNetworkNodes)
        >= Math.max(1, Math.min(startNetworkNodes, endNetworkNodes)) * DOMINANT_NETWORK_RATIO;
      // Väljumiseta lõppenud otsing on juba täielik algusepoolne Dijkstra puu;
      // sama puud ei arvutata alternatiivide jaoks uuesti.
      let startTreeMemo = graphSearch.exit === null ? graphSearch.tree : null;
      let endTreeMemo: GraphTree | null = null;
      const startTree = (): GraphTree =>
        startTreeMemo ??= searchGraphDijkstra(graph, startSearch.graphCosts, checkpoint).tree;
      const endTree = (): GraphTree =>
        endTreeMemo ??= searchGraphDijkstra(graph, endSearch.graphCosts, checkpoint).tree;
      const viaEndNetwork = keepEndNetwork
        ? await resolveRemoteLeg(options, graph, endSearch, endTree(), remainingBudget, checkpoint, 'start')
        : null;
      const viaStartNetwork = !keepEndNetwork
        ? await resolveRemoteLeg(options, graph, startSearch, startTree(), remainingBudget, checkpoint, 'end')
        : null;
      // Kui suurema võrgu kaugühendus üksinda ei ole läbitav, ei tohi
      // DOMINANT_NETWORK_RATIO kogu marsruuti tühistada. Sellisel juhul on
      // kohaliku sadamaharukese kasutamine vajalik ühendus, mitte valikuline
      // ring (Rosala). Kui suurema võrgu otsetee õnnestub, jätame väikese
      // haru endiselt vahele nagu Tilgu–Meeruse juhtumis.
      const viaBothNetworks = !dominantNetwork || (!viaEndNetwork && !viaStartNetwork)
        ? await resolveDisconnectedNetworks(
          options,
          graph,
          startSearch,
          endSearch,
          startTree(),
          endTree(),
          remainingBudget,
          checkpoint,
        )
        : null;
      bothNetworksCost = viaBothNetworks
        ? resolvedPhysicalCost(options.surface, graph, viaBothNetworks)
        : undefined;
      remoteEndNetworkCost = viaEndNetwork
        ? resolvedPhysicalCost(options.surface, graph, viaEndNetwork)
        : undefined;
      remoteStartNetworkCost = viaStartNetwork
        ? resolvedPhysicalCost(options.surface, graph, viaStartNetwork)
        : undefined;
      const alternatives = [
        viaBothNetworks && {
          selection: 'both_networks' as const,
          route: viaBothNetworks,
          physicalCost: bothNetworksCost!,
        },
        viaEndNetwork && {
          selection: 'end_network' as const,
          route: viaEndNetwork,
          physicalCost: remoteEndNetworkCost!,
        },
        viaStartNetwork && {
          selection: 'start_network' as const,
          route: viaStartNetwork,
          physicalCost: remoteStartNetworkCost!,
        },
      ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
      const chosen = alternatives.sort((left, right) =>
        left.physicalCost - right.physicalCost
          || selectionPriority(left.selection) - selectionPriority(right.selection))[0];
      if (chosen) {
        remoteSelection = chosen.selection;
        resolved = {
          ...chosen.route,
          totalCost: chosen.physicalCost,
          expandedNodes: alternatives.reduce(
            (sum, candidate) => sum + candidate.route.expandedNodes,
            0,
          ),
        };
      }
    }
  } else if (startSearch.graphCosts.size === 0 && endSearch.graphCosts.size > 0) {
    resolved = remainingBudget > 0
      ? await resolveRemoteLeg(
        options,
        graph,
        endSearch,
        searchGraphDijkstra(graph, endSearch.graphCosts, checkpoint).tree,
        remainingBudget,
        checkpoint,
        'start',
      )
      : null;
  } else if (startSearch.graphCosts.size > 0 && endSearch.graphCosts.size === 0) {
    resolved = remainingBudget > 0
      ? await resolveRemoteLeg(
        options,
        graph,
        startSearch,
        searchGraphDijkstra(graph, startSearch.graphCosts, checkpoint).tree,
        remainingBudget,
        checkpoint,
        'end',
      )
      : null;
  }
  const resolvedExpandedNodes = connectorExpandedNodes + (resolved?.expandedNodes ?? 0);
  if (!resolved) {
    return {
      route: null,
      expandedNodes: resolvedExpandedNodes,
      graphNodes: graph.edges.size,
      startCandidates: startSearch.graphCosts.size,
      endCandidates: endSearch.graphCosts.size,
      remoteEndNetworkCost,
      remoteStartNetworkCost,
      bothNetworksCost,
      remoteSelection,
    };
  }

  const prefixGraphPath = positionedGraphPath(
    graph,
    resolved.prefixGraphPath ?? [],
  );
  const graphPath = positionedGraphPath(graph, resolved.graphPath);
  const path: PositionedGridPoint[] = [];
  for (const point of [
    ...resolved.startPath,
    ...prefixGraphPath,
    ...(resolved.bridgePath ?? []),
    ...graphPath,
    ...resolved.endPath,
  ]) {
    appendPositionedPoint(path, point);
  }
  const protectedPoints = protectUsedBackbone(
    [prefixGraphPath, graphPath].filter((group) => group.length > 0),
  );
  const trustedPaths = [
    trustedGraphPaths(graph, resolved.prefixGraphPath ?? []),
    trustedGraphPaths(graph, resolved.graphPath),
  ].flat();
  return {
    route: {
      path,
      protectedPoints,
      trustedPaths,
      totalCost: resolved.totalCost,
      expandedNodes: resolvedExpandedNodes,
      graphNodes: graph.edges.size,
    },
    expandedNodes: resolvedExpandedNodes,
    graphNodes: graph.edges.size,
    startCandidates: startSearch.graphCosts.size,
    endCandidates: endSearch.graphCosts.size,
    remoteEndNetworkCost,
    remoteStartNetworkCost,
    bothNetworksCost,
    remoteSelection,
  };
}

// Väikelaeva projektsioon ei sõltu läbitavusest ega laeva mõõtudest, ainult
// võre paigutusest. Sama päringu korduskatsed (peenblokeeringu retry'd) ja
// järjestikused sama vaate päringud saavad ~120k serva uuesti läbimata sama
// struktuuri; graafifaili vahetus mtime-vahemälus tühjendab kirje iseenesest.
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
  const nodePositions = new Map<number, Position>();
  const nodePoints = new Map<number, GridPoint>();
  const edgeMaps = new Map<number, Map<number, GraphEdge>>();
  for (const [edgeIndex, edge] of prepared.edges.entries()) {
    if ((edgeIndex & 255) === 0) checkpoint();
    if (!preparedEdgeIsUsable(edge, vessel)) continue;
    const fromNode = prepared.nodes[edge.from];
    const toNode = prepared.nodes[edge.to];
    if (!fromNode || !toNode) continue;
    const projectedFrom = surface.toGrid({ lon: fromNode.position[0], lat: fromNode.position[1] });
    const projectedTo = surface.toGrid({ lon: toNode.position[0], lat: toNode.position[1] });
    const fromPoint = { x: Math.round(projectedFrom.x), y: Math.round(projectedFrom.y) };
    const toPoint = { x: Math.round(projectedTo.x), y: Math.round(projectedTo.y) };
    if (!isInsideGrid(surface, fromPoint) || !isInsideGrid(surface, toPoint)) continue;
    if (!smallCraft
      && (!isTraversable(surface, fromPoint) || !isTraversable(surface, toPoint))) continue;
    nodePositions.set(edge.from, fromNode.position);
    nodePositions.set(edge.to, toNode.position);
    nodePoints.set(edge.from, fromPoint);
    nodePoints.set(edge.to, toPoint);
    const distance = distanceM(fromNode.position, toNode.position)
      / surface.projection.cellSizeM;
    addUndirectedEdge(
      edgeMaps,
      edge.from,
      edge.to,
      distance,
      fromNode.position,
      toNode.position,
      edge.official ? 'official' : 'recommended',
      edge.sourceIds,
    );
  }

  const nodesByCell = new Map<number, number[]>();
  for (const id of edgeMaps.keys()) {
    const point = nodePoints.get(id);
    if (!point) continue;
    const cell = pointId(surface, point);
    const ids = nodesByCell.get(cell) ?? [];
    ids.push(id);
    nodesByCell.set(cell, ids);
  }
  const terminals = new Set(
    [...edgeMaps].filter(([, outgoing]) => outgoing.size === 1).map(([id]) => id),
  );
  const graph: CorridorGraph = {
    edges: new Map([...edgeMaps].map(([id, edges]) => [id, [...edges.values()]])),
    positions: nodePositions,
    points: nodePoints,
    nodesByCell,
    terminals,
  };
  if (smallCraft) smallCraftProjections.set(prepared, { projection: surface.projection, graph });
  return graph;
}

function preparedEdgeIsUsable(
  edge: PreparedRoutingGraphEdge,
  vessel: RoutingVesselProfile,
): boolean {
  if (isSmallCraftRoutingProfile(vessel)) return true;
  const requiredDepthM = vessel.draughtM + vessel.underKeelClearanceM;
  const publishedDepthM = edge.depthM;
  if (publishedDepthM !== undefined && publishedDepthM < requiredDepthM) return false;
  if (edge.maxDraughtM !== undefined && edge.maxDraughtM < requiredDepthM) return false;
  if (edge.widthM !== undefined && edge.widthM < vessel.beamM) return false;
  return true;
}

function addUndirectedEdge(
  edges: Map<number, Map<number, GraphEdge>>,
  a: number,
  b: number,
  distance: number,
  positionA: Position,
  positionB: Position,
  kind: 'official' | 'recommended',
  sourceIds: RoutingSourceId[],
): void {
  if (a === b || !Number.isFinite(distance) || distance <= 0) return;
  addEdge(edges, a, {
    to: b,
    distance,
    fromPosition: positionA,
    toPosition: positionB,
    kind,
    sourceIds,
  });
  addEdge(edges, b, {
    to: a,
    distance,
    fromPosition: positionB,
    toPosition: positionA,
    kind,
    sourceIds,
  });
}

function addEdge(edges: Map<number, Map<number, GraphEdge>>, from: number, edge: GraphEdge): void {
  let outgoing = edges.get(from);
  if (!outgoing) {
    outgoing = new Map();
    edges.set(from, outgoing);
  }
  if (!outgoing.has(edge.to)) outgoing.set(edge.to, edge);
}

async function searchConnectors(
  surface: RoutingCostSurface,
  origin: GridPoint,
  graph: CorridorGraph,
  radiusCells: number,
  maxExpandedNodes: number,
  checkpoint: () => void,
  yieldControl: () => Promise<void>,
): Promise<ConnectorSearch> {
  const size = surface.width * surface.height;
  const scores = new Float64Array(size);
  scores.fill(Number.POSITIVE_INFINITY);
  const parents = new Int32Array(size);
  parents.fill(-2);
  const closed = new Uint8Array(size);
  const graphCosts = new Map<number, number>();
  if (!isTraversable(surface, origin)) return { graphCosts, parents, expandedNodes: 0 };

  const heap = new MinHeap<QueueItem>(compareQueueItems);
  let bestGraphCost = Number.POSITIVE_INFINITY;
  const candidateSlack = CONNECTOR_CANDIDATE_SLACK_M / surface.projection.cellSizeM;
  const originId = pointId(surface, origin);
  scores[originId] = 0;
  parents[originId] = -1;
  heap.push({ id: originId, cost: 0 });
  let expandedNodes = 0;

  while (heap.size > 0 && expandedNodes < maxExpandedNodes) {
    const current = heap.pop()!;
    if (closed[current.id] || Math.abs(scores[current.id]! - current.cost) > EPSILON) continue;
    // Dijkstra järjekord on kasvava kuluga. Pärast esimest graafipuudutust
    // piisab lähedaste alternatiivsete harude kogumisest; kogu 6 NM ringi
    // tühjaks otsimine ei muuda ökonoomset sisenemist, kuid võib süüa sadu
    // tuhandeid rakke enne päris võrguotsingut.
    if (current.cost > bestGraphCost + candidateSlack) break;
    closed[current.id] = 1;
    expandedNodes++;
    const graphNodes = graph.nodesByCell.get(current.id) ?? [];
    if (graphNodes.length > 0) {
      bestGraphCost = Math.min(bestGraphCost, current.cost);
      for (const graphNode of graphNodes) graphCosts.set(graphNode, current.cost);
      // Ühendus lõpeb esimesel laevateegraafi puudutusel. Kui otsingul lubada
      // mööda üht graafikomponenti edasi liikuda ja teise komponenti jõuda,
      // võib graafitee minna kauge punktini ning sama ühendust mööda tagasi
      // pöörata. Tulemuseks on kaardil U-pööre või siksak paralleelsete
      // soovituslike teede ümber.
      continue;
    }
    const point = pointFromId(surface, current.id);
    const currentCell = surface.cellAt(point.x, point.y);

    for (const neighbour of traversableNeighbours(surface, point)) {
      if (Math.hypot(neighbour.point.x - origin.x, neighbour.point.y - origin.y) > radiusCells) continue;
      const nextId = pointId(surface, neighbour.point);
      const nextCell = surface.cellAt(neighbour.point.x, neighbour.point.y);
      const cost = current.cost + neighbour.distance
        * (currentCell.costMultiplier + nextCell.costMultiplier) / 2;
      if (cost + EPSILON >= scores[nextId]!) continue;
      scores[nextId] = cost;
      parents[nextId] = current.id;
      closed[nextId] = 0;
      heap.push({ id: nextId, cost });
    }

    if (expandedNodes % YIELD_EVERY === 0) {
      checkpoint();
      await yieldControl();
    }
  }
  checkpoint();
  return { graphCosts, parents, expandedNodes };
}

function resolveLocalBackbone(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  start: GridPoint,
  end: GridPoint,
  startSearch: ConnectorSearch,
  endSearch: ConnectorSearch,
  graphSearch: GraphSearchResult,
): ResolvedBackbone | null {
  if (graphSearch.exit === null) return null;
  const graphPath = followGraphTree(graphSearch.exit, graphSearch.tree.parents).reverse();
  const startPoint = graph.points.get(graphPath[0]!);
  const endPoint = graph.points.get(graphSearch.exit);
  if (!startPoint || !endPoint) return null;
  const startPath = reconstructConnector(surface, start, startPoint, startSearch.parents);
  const endPath = reconstructConnector(surface, end, endPoint, endSearch.parents)?.reverse();
  if (!startPath || !endPath) return null;
  return {
    startPath,
    graphPath,
    endPath,
    totalCost: graphSearch.totalCost,
    expandedNodes: graphSearch.tree.expandedNodes,
  };
}

/**
 * Kahe päriselt eraldatud keskjoonevõrgu korral järgitakse mõlemat võrku ja
 * võreotsingule antakse ainult nende sobivate terminalide vaheline katkestus.
 */
async function resolveDisconnectedNetworks(
  options: CorridorBackboneOptions,
  graph: CorridorGraph,
  startSearch: ConnectorSearch,
  endSearch: ConnectorSearch,
  startTree: GraphTree,
  endTree: GraphTree,
  maxExpandedNodes: number,
  checkpoint: () => void,
): Promise<ResolvedBackbone | null> {
  if (maxExpandedNodes <= 0) return null;
  let expandedNodes = startTree.expandedNodes + endTree.expandedNodes;
  const trustGraphTerminals = isSmallCraftRoutingProfile(options.vessel);
  const pairs = disconnectedTerminalPairs(
    options.surface,
    graph,
    startTree,
    endTree,
    trustGraphTerminals,
  );

  for (const pair of pairs) {
    const remainingNodes = maxExpandedNodes - expandedNodes;
    if (remainingNodes <= 0) break;
    const from = graph.points.get(pair.start);
    const to = graph.points.get(pair.end);
    if (!from || !to) continue;
    const bridgeSurface = trustGraphTerminals
      ? withOpenConnectorCells(options.surface, [pointId(options.surface, from), pointId(options.surface, to)])
      : options.surface;
    const connector = await findLongConnectorPath(bridgeSurface, from, to, {
      signal: options.signal,
      timeoutMs: options.connectorTimeoutMs ?? 20_000,
      maxExpandedNodes: remainingNodes,
    });
    expandedNodes += connector.expandedNodes;
    checkpoint();
    if (connector.status === 'not_found') {
      if (connector.reason !== 'no_route') break;
      continue;
    }

    const prefixGraphPath = followGraphTree(pair.start, startTree.parents).reverse();
    const graphPath = followGraphTree(pair.end, endTree.parents);
    const entry = prefixGraphPath[0]!;
    const exit = graphPath.at(-1)!;
    const entryPoint = graph.points.get(entry);
    const exitPoint = graph.points.get(exit);
    if (!entryPoint || !exitPoint) continue;
    const startPath = reconstructConnector(
      options.surface,
      options.start,
      entryPoint,
      startSearch.parents,
    );
    const endPath = reconstructConnector(
      options.surface,
      options.end,
      exitPoint,
      endSearch.parents,
    )?.reverse();
    if (!startPath || !endPath) continue;
    return {
      startPath,
      prefixGraphPath,
      bridgePath: connector.path.map((point) => ({ ...point })),
      graphPath,
      endPath,
      totalCost: startTree.scores.get(pair.start)! + connector.totalCost
        + endTree.scores.get(pair.end)!,
      expandedNodes,
    };
  }
  return null;
}

function disconnectedTerminalPairs(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  startTree: GraphTree,
  endTree: GraphTree,
  trustGraphTerminals: boolean,
): Array<{ start: number; end: number; score: number }> {
  const eligibleTerminals = (tree: GraphTree): Array<[number, number]> => [...tree.scores]
    .filter(([id]) => graph.terminals.has(id)
      && (trustGraphTerminals || isTraversable(surface, graph.points.get(id)!)));
  const startTerminals = eligibleTerminals(startTree);
  const endTerminals = eligibleTerminals(endTree);
  return startTerminals.flatMap(([start, startCost]) =>
    endTerminals.flatMap(([end, endCost]) => {
      const from = graph.points.get(start);
      const to = graph.points.get(end);
      if (!from || !to) return [];
      const gap = Math.hypot(to.x - from.x, to.y - from.y);
      return [{
        start,
        end,
        gap,
        score: startCost + gap + endCost,
      }];
    }))
    .sort((a, b) => a.score - b.score || a.gap - b.gap || a.start - b.start || a.end - b.end)
    .slice(0, MAX_DISCONNECTED_PAIRS);
}

interface RemoteAttempt {
  candidate: number;
  contact: GridPoint;
  connectorSurface: RoutingCostSurface;
  path: GridPoint[] | null;
  limitedInteriorSearch?: boolean;
}

/**
 * Üks ots (`side`) on graafist kaugel: järgitakse teise otsa võrgu Dijkstra
 * puud ja ühendatakse kauge ots sirge või A* ühendusega võrgu kontaktpunkti.
 * `search` ja `tree` kuuluvad graafi kõrval olevale otsale.
 */
async function resolveRemoteLeg(
  options: CorridorBackboneOptions,
  graph: CorridorGraph,
  search: ConnectorSearch,
  tree: GraphTree,
  maxExpandedNodes: number,
  checkpoint: () => void,
  side: 'start' | 'end',
): Promise<ResolvedBackbone | null> {
  if (maxExpandedNodes <= 0) return null;
  let expandedNodes = tree.expandedNodes;
  const remote = side === 'start' ? options.start : options.end;
  const opposite = side === 'start' ? options.end : options.start;
  const candidates = remoteCandidates(graph, remote, opposite, tree.physicalScores);
  const connectorSurfaceFor = (contact: GridPoint): RoutingCostSurface =>
    isSmallCraftRoutingProfile(options.vessel)
      ? withOpenConnectorCells(options.surface, [pointId(options.surface, contact)])
      : options.surface;
  let attempts: RemoteAttempt[] = [];
  for (const candidate of candidates) {
    const contact = graph.points.get(candidate);
    if (!contact) continue;
    const surface = connectorSurfaceFor(contact);
    const path = side === 'start'
      ? directConnectorPath(surface, remote, contact)
      : directConnectorPath(surface, contact, remote);
    if (path) {
      attempts = [{ candidate, contact, connectorSurface: surface, path }];
      break;
    }
  }
  if (attempts.length === 0) {
    // Kui avamere sirge ei ole ohutu, on terminal graafi loomulik katkestus-
    // ja ühenduspunkt. Sisemiste sõlmede geomeetriline pingerida võib muidu
    // täita kõik kallid A* katsed sama saare või madaliku vale poolega (Hitis).
    // Hõreda kohaliku kontakti puhul (nt Hitis) võib sobiv võrguosa alata
    // ainult kaugest terminalist. Tiheda võrgu puhul (nt Jussarö) proovime
    // esmalt lühemat sisemist ühendust, kuid terminal peab jääma varuks:
    // Rosala lähedased sisemised punktid võivad jämedal võrel olla saare
    // valel poolel, kuigi sama põhivõrgu kaugem terminal on ohutult leitav.
    const terminalCandidates = remoteFallbackTerminalCandidates(
      graph,
      remote,
      opposite,
      tree.scores,
      tree.parents,
    );
    const interiorCandidates = candidates.slice(0, MAX_REMOTE_SEARCH_CANDIDATES);
    const interiorSet = new Set(interiorCandidates);
    const searchCandidates = [
      ...interiorCandidates.map((candidate) => ({ candidate, limitedInteriorSearch: true })),
      ...terminalCandidates
        .filter((candidate) => !interiorSet.has(candidate))
        .slice(0, MAX_REMOTE_SEARCH_CANDIDATES)
        .map((candidate) => ({ candidate, limitedInteriorSearch: false })),
    ];
    attempts = searchCandidates.flatMap(({ candidate, limitedInteriorSearch }) => {
      const contact = graph.points.get(candidate);
      if (!contact) return [];
      return [{
        candidate,
        contact,
        connectorSurface: connectorSurfaceFor(contact),
        path: null,
        limitedInteriorSearch,
      }];
    });
  }
  for (const attempt of attempts) {
    checkpoint();
    const remainingNodes = maxExpandedNodes - expandedNodes;
    if (remainingNodes <= 0) break;
    const attemptNodeBudget = attempt.limitedInteriorSearch
      ? Math.min(MAX_REMOTE_INTERIOR_EXPANDED_NODES, remainingNodes)
      : remainingNodes;
    const connector: PathSearchResult = attempt.path
      ? directConnectorResult(attempt.connectorSurface, attempt.path)
      : await findPath(
        attempt.connectorSurface,
        side === 'start' ? remote : attempt.contact,
        side === 'start' ? attempt.contact : remote,
        {
          signal: options.signal,
          timeoutMs: options.connectorTimeoutMs ?? 20_000,
          maxExpandedNodes: attemptNodeBudget,
        },
      );
    expandedNodes += connector.expandedNodes;
    checkpoint();
    if (connector.status === 'not_found') {
      if (connector.reason === 'timeout') break;
      continue;
    }
    if (side === 'start') {
      const contact = firstGraphContact(options.surface, graph, connector.path, tree.scores);
      const connectorEndIndex = contact?.pathIndex ?? connector.path.length - 1;
      const contactId = contact?.graphId ?? attempt.candidate;
      const startPath = connector.path.slice(0, connectorEndIndex + 1)
        .map((point) => ({ ...point }));
      appendPositionedPoint(startPath, graph.points.get(contactId)!);
      const graphPath = followGraphTree(contactId, tree.parents);
      const exit = graphPath.at(-1)!;
      const endPath = reconstructConnector(
        options.surface,
        options.end,
        graph.points.get(exit)!,
        search.parents,
      )?.reverse();
      if (!endPath) continue;
      return {
        startPath,
        graphPath,
        endPath,
        totalCost: gridPathCost(options.surface, startPath) + tree.scores.get(contactId)!,
        expandedNodes,
      };
    }
    const contact = lastGraphContact(options.surface, graph, connector.path, tree.scores);
    const contactIndex = contact?.pathIndex ?? 0;
    const contactId = contact?.graphId ?? attempt.candidate;
    const graphBackwards = followGraphTree(contactId, tree.parents);
    const entry = graphBackwards.at(-1)!;
    const startPath = reconstructConnector(
      options.surface,
      options.start,
      graph.points.get(entry)!,
      search.parents,
    );
    if (!startPath) continue;
    const endPath: GridPoint[] = [];
    appendPositionedPoint(endPath, graph.points.get(contactId)!);
    for (const point of connector.path.slice(contactIndex)) appendPositionedPoint(endPath, point);
    return {
      startPath,
      graphPath: graphBackwards.reverse(),
      endPath,
      totalCost: tree.scores.get(contactId)! + gridPathCost(options.surface, endPath),
      expandedNodes,
    };
  }
  return null;
}

interface GraphContact {
  pathIndex: number;
  graphId: number;
}

/**
 * Võrejoon võib kulgeda keskjoone otspunktist ühe lahtri võrra mööda ilma
 * samasse lahtrisse sattumata. Vahetu läbitav naaber on siiski juba tegelik
 * kokkupuude: lõpetame võreühenduse seal ja jätkame lähtevektori täpsest
 * punktist. Nii ei teki laevatee kõrvale ühe lahtri laiust treppi.
 */
function firstGraphContact(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  path: readonly GridPoint[],
  graphScores: ReadonlyMap<number, number>,
): GraphContact | null {
  for (let pathIndex = 0; pathIndex < path.length; pathIndex++) {
    const graphId = adjacentGraphContact(surface, graph, path[pathIndex]!, graphScores);
    if (graphId !== null) return { pathIndex, graphId };
  }
  return null;
}

function lastGraphContact(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  path: readonly GridPoint[],
  graphScores: ReadonlyMap<number, number>,
): GraphContact | null {
  for (let pathIndex = path.length - 1; pathIndex >= 0; pathIndex--) {
    const graphId = adjacentGraphContact(surface, graph, path[pathIndex]!, graphScores);
    if (graphId !== null) return { pathIndex, graphId };
  }
  return null;
}

function adjacentGraphContact(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  point: GridPoint,
  graphScores: ReadonlyMap<number, number>,
): number | null {
  const exactCell = pointId(surface, point);
  const exactIds = (graph.nodesByCell.get(exactCell) ?? [])
    .filter((id) => graphScores.has(id));
  if (exactIds.length > 0) return bestGraphContact(exactIds, graphScores);

  let bestId: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const candidate = { x: point.x + dx, y: point.y + dy };
      if (!isInsideGrid(surface, candidate)) continue;
      // Enamikus lahtrites pole ühtegi graafisõlme; odav Map-kontroll käib
      // enne geomeetrilist läbitavuskontrolli.
      const candidateIds = graph.nodesByCell.get(pointId(surface, candidate));
      if (!candidateIds?.length) continue;
      if (!adjacentAndTraversable(surface, point, candidate)) continue;
      for (const candidateId of candidateIds) {
        const graphScore = graphScores.get(candidateId);
        if (graphScore === undefined) continue;
        const score = Math.hypot(dx, dy) + graphScore;
        if (score < bestScore - EPSILON || (Math.abs(score - bestScore) <= EPSILON
          && (bestId === null || candidateId < bestId))) {
          bestId = candidateId;
          bestScore = score;
        }
      }
    }
  }
  return bestId;
}

function bestGraphContact(
  ids: readonly number[],
  graphScores: ReadonlyMap<number, number>,
): number {
  return [...ids].sort((a, b) => graphScores.get(a)! - graphScores.get(b)! || a - b)[0]!;
}

function gridPathCost(surface: RoutingCostSurface, path: readonly GridPoint[]): number {
  let cost = 0;
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1]!;
    const to = path[index]!;
    const distance = from.x === to.x || from.y === to.y ? 1 : Math.SQRT2;
    cost += distance
      * (surface.cellAt(from.x, from.y).costMultiplier
        + surface.cellAt(to.x, to.y).costMultiplier) / 2;
  }
  return cost;
}

/** Tegelik kogukulu variandi valikuks; graafieelis ei tohi õigustada ringi. */
function resolvedPhysicalCost(
  surface: RoutingCostSurface,
  graph: CorridorGraph,
  route: ResolvedBackbone,
): number {
  return gridPathCost(surface, route.startPath)
    + graphPathPhysicalCost(graph, route.prefixGraphPath ?? [])
    + gridPathCost(surface, route.bridgePath ?? [])
    + graphPathPhysicalCost(graph, route.graphPath)
    + gridPathCost(surface, route.endPath);
}

function graphPathPhysicalCost(graph: CorridorGraph, path: readonly number[]): number {
  let cost = 0;
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1]!;
    const to = path[index]!;
    cost += graph.edges.get(from)?.find((edge) => edge.to === to)?.distance ?? 0;
  }
  return cost;
}

function reachableGraphNodes(graph: CorridorGraph, seeds: Iterable<number>): number {
  const visited = new Set<number>();
  const pending: number[] = [];
  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    pending.push(seed);
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    for (const edge of graph.edges.get(pending[cursor]!) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      pending.push(edge.to);
    }
  }
  return visited.size;
}

function selectionPriority(selection: CorridorBackboneAttempt['remoteSelection']): number {
  return selection === 'both_networks' ? 0 : selection === 'end_network' ? 1 : 2;
}

function findLongConnectorPath(
  surface: RoutingCostSurface,
  from: GridPoint,
  to: GridPoint,
  options: PathSearchOptions,
): Promise<PathSearchResult> {
  const direct = directConnectorPath(surface, from, to);
  if (direct) {
    return Promise.resolve(directConnectorResult(surface, direct));
  }
  return findPath(surface, from, to, options);
}

function directConnectorResult(
  surface: RoutingCostSurface,
  path: GridPoint[],
): PathSearchResult {
  return {
    status: 'found',
    path,
    totalCost: gridPathCost(surface, path),
    expandedNodes: 0,
    heapPushes: 0,
  };
}

/**
 * Avamerel on sirgjoon lühim võimalik ühendus. Kontrollime selle kõik
 * läbitud võrerakud enne A* käivitamist; kui teele jääb maa, madalik või
 * piirang, kasutatakse allpool endiselt täielikku ohutu võre otsingut.
 */
function directConnectorPath(
  surface: RoutingCostSurface,
  from: GridPoint,
  to: GridPoint,
): GridPoint[] | null {
  if (!isTraversable(surface, from) || !isTraversable(surface, to)) return null;
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  const path: GridPoint[] = [];
  for (let step = 0; step <= steps; step++) {
    const ratio = steps === 0 ? 0 : step / steps;
    const point = {
      x: Math.round(from.x + (to.x - from.x) * ratio),
      y: Math.round(from.y + (to.y - from.y) * ratio),
    };
    const previous = path.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    if (!isTraversable(surface, point)) return null;
    if (previous && !adjacentAndTraversable(surface, previous, point)) return null;
    path.push(point);
  }
  return path;
}

interface GraphTree {
  scores: Map<number, number>;
  /** Sama parent-puu tegelik kogukulu ilma graafisoodustuseta. */
  physicalScores: Map<number, number>;
  parents: Map<number, number>;
  expandedNodes: number;
}

interface GraphSearchResult {
  tree: GraphTree;
  exit: number | null;
  totalCost: number;
}

/**
 * Dijkstra üle keskjoonegraafi. `endCosts` korral lõpetatakse niipea, kui
 * odavaim sisenemis-+väljumissumma on kindel, ja `exit` näitab väljumissõlme.
 * Ilma selleta ehitatakse täielik puu, mille parent viib igast sõlmest lähima
 * seemne suunas.
 */
function searchGraphDijkstra(
  graph: CorridorGraph,
  seedCosts: ReadonlyMap<number, number>,
  checkpoint: () => void,
  endCosts?: ReadonlyMap<number, number>,
): GraphSearchResult {
  const scores = new Map<number, number>();
  const physicalScores = new Map<number, number>();
  const parents = new Map<number, number>();
  const closed = new Set<number>();
  const heap = new MinHeap<QueueItem>(compareQueueItems);
  for (const [id, cost] of seedCosts) {
    scores.set(id, cost);
    physicalScores.set(id, cost);
    parents.set(id, -1);
    heap.push({ id, cost });
  }
  let expandedNodes = 0;
  let bestExit: number | null = null;
  let bestTotalCost = Number.POSITIVE_INFINITY;
  while (heap.size > 0) {
    const current = heap.pop()!;
    if (current.cost >= bestTotalCost - EPSILON) break;
    if (closed.has(current.id) || Math.abs((scores.get(current.id) ?? Infinity) - current.cost) > EPSILON) {
      continue;
    }
    closed.add(current.id);
    expandedNodes++;
    if (endCosts) {
      const endCost = endCosts.get(current.id);
      if (endCost !== undefined && current.cost + endCost < bestTotalCost - EPSILON) {
        bestTotalCost = current.cost + endCost;
        bestExit = current.id;
      }
    }
    for (const edge of graph.edges.get(current.id) ?? []) {
      const score = current.cost + graphEdgeCost(edge);
      if (score + EPSILON >= (scores.get(edge.to) ?? Number.POSITIVE_INFINITY)) continue;
      scores.set(edge.to, score);
      physicalScores.set(edge.to, physicalScores.get(current.id)! + edge.distance);
      parents.set(edge.to, current.id);
      closed.delete(edge.to);
      heap.push({ id: edge.to, cost: score });
    }
    if ((expandedNodes & 4_095) === 0) checkpoint();
  }
  checkpoint();
  return {
    tree: { scores, physicalScores, parents, expandedNodes },
    exit: bestExit,
    totalCost: bestTotalCost,
  };
}

function remoteCandidates(
  graph: CorridorGraph,
  remote: GridPoint,
  opposite: GridPoint,
  physicalGraphScores: ReadonlyMap<number, number>,
): number[] {
  const directCells = Math.max(1, Math.hypot(opposite.x - remote.x, opposite.y - remote.y));
  // Kauge ühendus võib graafi siseneda suvalises keskjoone punktis. Valmis
  // graafi servad on kuni 150 m pikkused, seega sõlm on sisuliselt servale
  // projitseerimine selle täpsuse piires. Ainult terminalide kasutamine sunnib
  // avamerelt enne sobivast väilast mööda sõitma ja otspunkti kaudu tagasi
  // pöörama (Tilgu–Jussarö kolmnurk).
  const ranked = [...physicalGraphScores].flatMap(([id, physicalGraphCost]) => {
    const point = graph.points.get(id);
    if (!point) return [];
    const distance = Math.hypot(point.x - remote.x, point.y - remote.y);
    if (distance > directCells * 1.25) return [];
    // Kandidaadi valikul kasutame päris pikkust, mitte graafi 0,75× eelist.
    // Soodustus otsustab võrgu sees võrdsete ohutute harude vahel, kuid ei tohi
    // õigustada pikemat avamere ühendust ega terminaliringi.
    return [{ id, point, score: distance + physicalGraphCost }];
  }).sort((a, b) => a.score - b.score || a.id - b.id);

  const selected: Array<{ id: number; point: GridPoint }> = [];
  for (const candidate of ranked) {
    if (selected.some((other) => Math.hypot(
      other.point.x - candidate.point.x,
      other.point.y - candidate.point.y,
    ) < REMOTE_CANDIDATE_SPACING_CELLS)) continue;
    selected.push(candidate);
    if (selected.length >= MAX_REMOTE_CANDIDATES) break;
  }
  return selected.map((candidate) => candidate.id);
}

/**
 * Takistusest ümber otsitava kaugühenduse konservatiivne varupingerida.
 * Terminal peab olema päriselt graafitee kaudu kohaliku otsaga ühendatud;
 * parent=-1 seeme on kohaliku võreotsingu kontakt, mitte vastasotsast
 * ligipääsetav katkestuspunkt.
 */
function remoteFallbackTerminalCandidates(
  graph: CorridorGraph,
  remote: GridPoint,
  opposite: GridPoint,
  graphScores: ReadonlyMap<number, number>,
  graphParents: ReadonlyMap<number, number>,
): number[] {
  const directCells = Math.max(1, Math.hypot(opposite.x - remote.x, opposite.y - remote.y));
  const ranked = [...graphScores].flatMap(([id, graphCost]) => {
    if (!graph.terminals.has(id) || graphParents.get(id) === -1) return [];
    const point = graph.points.get(id);
    if (!point) return [];
    const distance = Math.hypot(point.x - remote.x, point.y - remote.y);
    if (distance > directCells * 1.25) return [];
    return [{ id, point, score: distance + graphCost }];
  }).sort((a, b) => a.score - b.score || a.id - b.id);

  const selected: Array<{ id: number; point: GridPoint }> = [];
  for (const candidate of ranked) {
    if (selected.some((other) => Math.hypot(
      other.point.x - candidate.point.x,
      other.point.y - candidate.point.y,
    ) < REMOTE_CANDIDATE_SPACING_CELLS)) continue;
    selected.push(candidate);
    if (selected.length >= MAX_REMOTE_CANDIDATES) break;
  }
  return selected.map((candidate) => candidate.id);
}

function followGraphTree(start: number, parents: ReadonlyMap<number, number>): number[] {
  const path: number[] = [];
  let id = start;
  for (let count = 0; count <= parents.size; count++) {
    path.push(id);
    id = parents.get(id) ?? -1;
    if (id < 0) return path;
  }
  throw new Error('Laevateegraafi parent-puus on tsükkel');
}

function graphEdgeCost(edge: GraphEdge): number {
  // Graafi pääsenud keskjoon on kogu lõigu ulatuses läbitav. Tundmatu või
  // hoiatusega raster ei tohi selle kuju ümber joonistada; need hinnangud
  // jäävad lõpptulemuse segmentidele, kuid ohutute laevateeharude vahel
  // valitakse füüsiliselt lühem tee.
  return edge.distance * EDGE_MULTIPLIER;
}

function positionedGraphPath(
  graph: CorridorGraph,
  ids: readonly number[],
): PositionedGridPoint[] {
  if (ids.length === 0) return [];
  if (ids.length === 1) {
    const point = graph.points.get(ids[0]!);
    if (!point) return [];
    return [{ ...point, position: graph.positions.get(ids[0]!) }];
  }

  const path: PositionedGridPoint[] = [];
  for (let index = 1; index < ids.length; index++) {
    const fromId = ids[index - 1]!;
    const toId = ids[index]!;
    const edge = graph.edges.get(fromId)?.find((candidate) => candidate.to === toId);
    const from = graph.points.get(fromId);
    const to = graph.points.get(toId);
    if (!from || !to) continue;
    appendPositionedPoint(path, {
      ...from,
      position: edge?.fromPosition ?? graph.positions.get(fromId),
    });
    appendPositionedPoint(path, {
      ...to,
      position: edge?.toPosition ?? graph.positions.get(toId),
    });
  }
  return path;
}

function trustedGraphPaths(
  graph: CorridorGraph,
  ids: readonly number[],
): PreparedPathLine[] {
  const result: PreparedPathLine[] = [];
  for (let index = 1; index < ids.length; index++) {
    const fromId = ids[index - 1]!;
    const toId = ids[index]!;
    const edge = graph.edges.get(fromId)?.find((candidate) => candidate.to === toId);
    const from = graph.points.get(fromId);
    const to = graph.points.get(toId);
    if (!edge || !from || !to) continue;
    result.push({
      points: [
        { ...from, position: edge.fromPosition },
        { ...to, position: edge.toPosition },
      ] satisfies PositionedGridPoint[],
      kind: edge.kind,
      sourceIds: [...edge.sourceIds],
    });
  }
  return result;
}

function reconstructConnector(
  surface: RoutingCostSurface,
  origin: GridPoint,
  target: GridPoint,
  parents: Int32Array,
): GridPoint[] | null {
  const originId = pointId(surface, origin);
  const reversed: GridPoint[] = [];
  let id = pointId(surface, target);
  for (let count = 0; count <= parents.length; count++) {
    reversed.push(pointFromId(surface, id));
    if (id === originId) {
      reversed.reverse();
      return reversed;
    }
    id = parents[id]!;
    if (id < 0) return null;
  }
  return null;
}

function protectUsedBackbone(
  groups: ReadonlyArray<readonly PositionedGridPoint[]>,
): PositionedGridPoint[] {
  const result: PositionedGridPoint[] = [];
  for (const group of groups) {
    // 5 cm eemaldab ehitaja 150 m kollineaarsed vahesõlmed, kuid ei ümarda
    // algallika päris pöördeid. Punktide arvu nimel ei tohi vektorit muuta.
    for (const point of douglasPeucker(group, 0.05)) appendPositionedPoint(result, point);
  }
  return result;
}

/**
 * Lubab lokaalsel ühendusotsingul puudutada väikelaeva jaoks usaldatud
 * graafipunkti ka siis, kui jäme rannajoone-/sügavuslahter selle blokeerib.
 * Avatakse ainult antud kontaktlahtrid. Otsing ei saa seetõttu mööda kogu
 * graafi rasterkujutist sõita ega tekitada vektori kõrvale paralleelteed.
 */
function withOpenConnectorCells(
  surface: RoutingCostSurface,
  indexes: Iterable<number> | ReadonlyMap<number, unknown> | ReadonlySet<number>,
): RoutingCostSurface {
  const open: { has(id: number): boolean; size: number } =
    indexes instanceof Set || indexes instanceof Map
      ? indexes
      : new Set(indexes as Iterable<number>);
  if (open.size === 0) return surface;
  const isOpen = (x: number, y: number): boolean => open.has(y * surface.width + x);
  return {
    ...surface,
    cellAt(x, y) {
      const cell = surface.cellAt(x, y);
      return isOpen(x, y) && cell.blocked ? { ...cell, blocked: false } : cell;
    },
    detailsAt(x, y) {
      const details = surface.detailsAt(x, y);
      return isOpen(x, y) && details.blocked ? { ...details, blocked: false } : details;
    },
  };
}

function douglasPeucker(
  path: readonly PositionedGridPoint[],
  tolerance: number,
): PositionedGridPoint[] {
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = tolerance;
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
  const [pointX, pointY] = metricPoint(point, from, to);
  const [fromX, fromY] = metricPoint(from, from, to);
  const [toX, toY] = metricPoint(to, from, to);
  return pointSegmentDistance(pointX, pointY, fromX, fromY, toX, toY);
}

function metricPoint(
  point: PositionedGridPoint,
  from: PositionedGridPoint,
  to: PositionedGridPoint,
): [number, number] {
  if (!point.position || !from.position || !to.position) return [point.x, point.y];
  const latitude = (from.position[1] + to.position[1]) * Math.PI / 360;
  return [
    point.position[0] * 111_320 * Math.cos(latitude),
    point.position[1] * 110_574,
  ];
}

/** Suunatud versioon traversableNeighbours-reeglist ühe naabri kontrolliks. */
function adjacentAndTraversable(
  surface: RoutingCostSurface,
  from: GridPoint,
  to: GridPoint,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
  if (!isTraversable(surface, to)) return false;
  if (dx !== 0 && dy !== 0) {
    return isTraversable(surface, { x: from.x + dx, y: from.y })
      && isTraversable(surface, { x: from.x, y: from.y + dy });
  }
  return true;
}
