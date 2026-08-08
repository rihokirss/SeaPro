import { createHash } from 'node:crypto';
import type {
  BBox,
  RoutePlan,
  RoutePlanIssue,
  RoutePlanRequest,
  RoutePlanResponse,
  RoutePlanSegment,
  RoutePlanSource,
  RouteWaypoint,
} from '@seapro/shared';
import { distanceMetres, routeDistanceNm } from '@seapro/shared';
import { config } from '../config.js';
import {
  buildRoutingCostSurface,
  type RoutingCellDetails,
  type RoutingCostSurface,
} from './costSurface.js';
import {
  fetchRoutingDepthRaster,
  RoutingDepthState,
  routingDepthAt,
  type RoutingDepthRaster,
} from './depthRaster.js';
import { isWithinRoutingServicePosition } from './coverage.js';
import type { GridPoint, PathSearchFailure, PathSearchResult, RoutingCell } from './engineTypes.js';
import { snapEndpoint, traversableNeighbours } from './grid.js';
import {
  deriveHarbourAccess,
  type HarbourAccess,
  type HarbourAccessResult,
} from './harbourAccess.js';
import { findPath } from './search.js';
import { describeRouteGeometry, type PositionedGridPoint } from './segments.js';
import { simplifyPath } from './simplify.js';
import { loadRoutingVectorData } from './sources/index.js';
import type { RoutingSourceMeta, RoutingVectorData } from './sourceTypes.js';
import { loadRoutingWaterMask, routingWaterAt, type RoutingWaterMask } from './waterMask.js';

const MAX_ENDPOINT_SNAP_M = 1_852;
// ~2 lisalahtrit 5x koridoris või 10 lahtrit tavavees: piisav kulupiiride
// murdumis-jõnksude silumiseks, liiga väike marsruudi ümberkujundamiseks.
const SIMPLIFY_COST_SLACK = 10;
const MAX_GEOMETRY_POINTS = 2_000;
const MAX_NAVIGATION_WAYPOINTS = 100;
const FINE_REVALIDATION_STEP_M = 10;
const MIN_ENDPOINT_COMPONENT_CELLS = 64;

export interface RoutingSnapshot {
  depth: RoutingDepthRaster;
  water: RoutingWaterMask;
  vectors: RoutingVectorData;
}

/** Valikuline faasimõõtmine benchmarki ja logi jaoks; tulemust ei mõjuta. */
export interface RoutingInstrumentation {
  phase(name: string, ms: number, meta?: Record<string, number>): void;
}

export interface PlanRouteOptions {
  signal?: AbortSignal;
  /** Kogu planeerimise tähtaeg; testides võib vaikeseadet lühendada. */
  timeoutMs?: number;
  /** Testide ja eri deploy'de jaoks; tavakasutuses laetakse snapshot välisallikatest. */
  snapshot?: RoutingSnapshot;
  bbox?: BBox;
  instrumentation?: RoutingInstrumentation;
}

export class RoutingDataUnavailableError extends Error {
  readonly sourceIds: string[];

  constructor(message: string, sourceIds: string[] = []) {
    super(message);
    this.name = 'RoutingDataUnavailableError';
    this.sourceIds = sourceIds;
  }
}

export class RoutingPlanTimeoutError extends Error {
  constructor() {
    super('Marsruudi planeerimise tähtaeg ületati');
    this.name = 'RoutingPlanTimeoutError';
  }
}

/** Laeb ühe muutumatu andmesnapshot'i ja leiab selle peal valideeritud tee. */
export async function planRoute(
  request: RoutePlanRequest,
  options: PlanRouteOptions = {},
): Promise<RoutePlanResponse> {
  const deadline = planningDeadline(options.signal, options.timeoutMs ?? config.routingPlanTimeoutMs);
  const instrumentation = options.instrumentation;
  const totalStartedAt = performance.now();
  try {
  deadline.checkpoint();
  const directDistanceM = distanceMetres(request.start, request.end);
  const planningBbox = options.bbox ?? routePlanningBbox(request, directDistanceM);
  const snapshotStartedAt = performance.now();
  const snapshot = options.snapshot ?? await deadline.waitFor(loadRoutingSnapshot(
    planningBbox,
    request.departureTime,
  ));
  instrumentation?.phase('snapshot_load', performance.now() - snapshotStartedAt);
  deadline.checkpoint();
  const sources = snapshotSources(snapshot);

  if (snapshot.depth.source.coverage === 'missing') {
    throw new RoutingDataUnavailableError('EMODneti sügavusmudel puudub', ['emodnet-depth']);
  }
  if (snapshot.water.source.coverage === 'missing') {
    throw new RoutingDataUnavailableError('Rannajoone alusandmed puuduvad', ['openfreemap-water']);
  }

  const accessStartedAt = performance.now();
  const startAccessResult = deriveHarbourAccess(request.start, request, snapshot.vectors, 'start');
  const endAccessResult = deriveHarbourAccess(request.end, request, snapshot.vectors, 'end');
  instrumentation?.phase('harbour_access', performance.now() - accessStartedAt);
  // Sadamaregistri mõõtmelimiit (HIS max_laev_syv/lai) ei blokeeri marsruuti:
  // registrikirjed on kohati aegunud või kirjeldavad väikseimat kaikohta.
  // Ligipääsu siiski ei tuletata (accessFromResult annab 'limit' puhul null),
  // sest ületatud limiit ei või avada madalat vett; piirang jõuab vastusesse
  // kriitilise hoiatusena ja otspunkt kleebitakse tavalise veepunktina.
  const limitIssues = harbourLimitIssues(startAccessResult, endAccessResult, request);
  const derivedStartAccess = accessFromResult(startAccessResult);
  const derivedEndAccess = accessFromResult(endAccessResult);
  const routingVectors: RoutingVectorData = {
    ...snapshot.vectors,
    corridors: [
      ...snapshot.vectors.corridors,
      ...(derivedStartAccess ? [derivedStartAccess.corridor] : []),
      ...(derivedEndAccess ? [derivedEndAccess.corridor] : []),
    ],
  };
  const positionOverrides = uniquePositions([
    [request.start.lon, request.start.lat],
    ...(derivedStartAccess?.waypoints ?? []),
    ...(derivedEndAccess?.waypoints ?? []),
    [request.end.lon, request.end.lat],
  ]);

  const surfaceStartedAt = performance.now();
  const surface = buildRoutingCostSurface({
    bbox: planningBbox,
    depth: snapshot.depth,
    water: snapshot.water,
    vectors: routingVectors,
    vessel: request,
    checkpoint: deadline.checkpoint,
    positionOverrides,
    onPhase: instrumentation
      ? (name, ms) => instrumentation.phase(`cost_surface.${name}`, ms)
      : undefined,
  });
  instrumentation?.phase('cost_surface', performance.now() - surfaceStartedAt, {
    cells: surface.width * surface.height,
    cellSizeM: Math.round(surface.projection.cellSizeM),
  });
  deadline.checkpoint();
  // Pika marsruudi jämedas võres võib väga väike saare- või sadamabassein
  // moodustada näiliselt avatud, kuid merest eraldatud komponendi. Sellist
  // tuletatud ligipääsu ei sunnita marsruudile; otspunkt kleebitakse siis
  // lähimasse sama avamere komponendi lahtrisse.
  const snapStartedAt = performance.now();
  const startAccess = navigableHarbourAccess(surface, connectedHarbourAccess(surface, derivedStartAccess));
  const endAccess = navigableHarbourAccess(surface, connectedHarbourAccess(surface, derivedEndAccess));
  // Tuletatud kanali tugipunkt võib sattuda blokeeritud lahtrisse (nt
  // geomeetriline väravapaar võõra märgi puhvri kõrval). Siis ei sunni me
  // kanalit marsruudile ega blokeeri kogu tulemust, vaid kleebime otspunkti
  // tavalise veepunktina ja ütleme põhjuse hoiatusega.
  const accessDropIssues: RoutePlanIssue[] = [
    ...(derivedStartAccess && connectedHarbourAccess(surface, derivedStartAccess) && !startAccess
      ? [{ code: 'harbour_access_not_navigable', severity: 'warning' as const, details: { endpoint: 'start' } }]
      : []),
    ...(derivedEndAccess && connectedHarbourAccess(surface, derivedEndAccess) && !endAccess
      ? [{ code: 'harbour_access_not_navigable', severity: 'warning' as const, details: { endpoint: 'end' } }]
      : []),
  ];
  const start = snapRouteEndpoint(surface, request.start, startAccess);
  let end = snapRouteEndpoint(surface, request.end, endAccess);
  instrumentation?.phase('endpoint_snap', performance.now() - snapStartedAt);
  if (!start || !end) {
    return {
      status: 'no_route',
      sources,
      issues: [{
        code: !start && !end ? 'endpoints_not_navigable' : !start ? 'start_not_navigable' : 'end_not_navigable',
        severity: 'critical',
        details: { maxSnapDistanceM: MAX_ENDPOINT_SNAP_M },
      }, ...limitIssues, ...accessDropIssues],
    };
  }

  let requiredAnchors = requiredHarbourAnchors(surface, start, end, startAccess, endAccess);
  if (!requiredAnchors) {
    return {
      status: 'no_route',
      sources,
      issues: [{ code: 'harbour_access_not_navigable', severity: 'critical' }, ...limitIssues, ...accessDropIssues],
    };
  }
  let activeSurface = surface;
  let result = await findPathThrough(activeSurface, requiredAnchors, deadline, instrumentation);
  deadline.checkpoint();
  if (result.status === 'not_found' && result.reason === 'no_route' && !endAccess) {
    const seaSeed = startAccess
      ? gridPointAt(surface, startAccess.waypoints.at(-1)!)
      : start.point;
    const connectedEnd = snapToReachableCell(
      surface,
      request.end,
      seaSeed,
      deadline.checkpoint,
    );
    if (connectedEnd && !sameGridPoint(connectedEnd.point, end.point)) {
      end = connectedEnd;
      requiredAnchors = requiredHarbourAnchors(surface, start, end, startAccess, endAccess);
      if (!requiredAnchors) {
        return {
          status: 'no_route',
          sources,
          issues: [{ code: 'harbour_access_not_navigable', severity: 'critical' }, ...limitIssues, ...accessDropIssues],
        };
      }
      result = await findPathThrough(activeSurface, requiredAnchors, deadline, instrumentation);
      deadline.checkpoint();
    }
  }
  if (result.status === 'not_found') {
    if (result.reason === 'aborted') throw abortError();
    return noRouteForSearchFailure(result, sources, [...limitIssues, ...accessDropIssues]);
  }

  // Võre on teadlikult jämedam kui lõplik 10 m kontroll. Kui viimane leiab
  // lahtri seest väikese madaliku või maatüki, sulgeme ainult selle lahtri ja
  // otsime kuni kolm korda uue tee. Ohutuskontroll jääb rangeks; kasutaja ei
  // pea aga käsitsi kordama päringut, millele leidub lähedal ohutu alternatiiv.
  const fineBlockedCells = new Set<number>();
  let prepared: PreparedRouteCandidate | null = null;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const prepareStartedAt = performance.now();
    prepared = prepareRouteCandidate(
      snapshot,
      activeSurface,
      result.path,
      requiredAnchors,
      start,
      end,
      startAccess,
      endAccess,
      deadline,
    );
    instrumentation?.phase('prepare_candidate', performance.now() - prepareStartedAt, { attempt });
    if (prepared.status !== 'blocked') break;
    if (attempt === 3) break;

    const blockedPoint = gridPointAt(activeSurface, prepared.position);
    if (requiredAnchors.some((anchor) => sameGridPoint(anchor, blockedPoint))) break;
    fineBlockedCells.add(blockedPoint.y * activeSurface.width + blockedPoint.x);
    activeSurface = withFineBlockedCells(surface, fineBlockedCells);
    result = await findPathThrough(activeSurface, requiredAnchors, deadline, instrumentation);
    deadline.checkpoint();
    if (result.status === 'not_found') {
      if (result.reason === 'aborted') throw abortError();
      if (result.reason === 'timeout' || result.reason === 'node_limit') {
        return noRouteForSearchFailure(result, sources, [...limitIssues, ...accessDropIssues]);
      }
      break;
    }
  }

  if (!prepared || prepared.status === 'blocked') {
    return {
      status: 'no_route',
      sources,
      issues: [{
        code: 'fine_revalidation_blocked',
        severity: 'critical',
        details: { reason: prepared?.reason ?? 'land' },
      }, ...limitIssues, ...accessDropIssues],
    };
  }
  if (prepared.status === 'invalid') {
    return {
      status: 'no_route',
      sources,
      issues: [{ code: prepared.code, severity: 'critical' }, ...limitIssues, ...accessDropIssues],
    };
  }
  const { coordinates, segments, navigationPath } = prepared;
  const issues = dedupeIssues([
    ...limitIssues,
    ...accessDropIssues,
    ...sourceIssues(sources),
    ...harbourAccessIssues(startAccess, endAccess),
    ...endpointIssues(start.distanceM, end.distanceM),
    ...segmentIssues(segments),
  ]);
  const status: RoutePlan['status'] = segments.some((segment) => segment.assessment !== 'clear')
    || issues.some((issue) => issue.severity === 'warning' || issue.severity === 'critical')
    ? 'advisory'
    : 'route';
  const generatedAt = new Date().toISOString();

  return {
    status,
    geometry: { type: 'LineString', coordinates },
    navigationWaypoints: navigationWaypoints(activeSurface, navigationPath),
    segments,
    endpoints: {
      start: {
        requested: { ...request.start },
        snapped: { lat: start.position[1], lon: start.position[0] },
        distanceM: Math.round(start.distanceM),
      },
      end: {
        requested: { ...request.end },
        snapped: { lat: end.position[1], lon: end.position[0] },
        distanceM: Math.round(end.distanceM),
      },
    },
    distanceNm: routeDistanceNm(coordinates.map(([lon, lat]) => ({ lon, lat }))),
    generatedAt,
    snapshotId: snapshotId(planningBbox, request.departureTime, sources, routingVectors),
    sources,
    issues,
  };
  } finally {
    instrumentation?.phase('total', performance.now() - totalStartedAt);
    deadline.dispose();
  }
}

export async function loadRoutingSnapshot(
  bbox: BBox,
  departureTime: string,
): Promise<RoutingSnapshot> {
  const [depth, water, vectors] = await Promise.allSettled([
    fetchRoutingDepthRaster(bbox),
    loadRoutingWaterMask(bbox),
    loadRoutingVectorData(bbox, departureTime),
  ]);
  const unavailable: string[] = [];
  if (depth.status === 'rejected') unavailable.push('emodnet-depth');
  if (water.status === 'rejected') unavailable.push('openfreemap-water');
  if (vectors.status === 'rejected') unavailable.push('routing-vectors');
  if (unavailable.length) {
    const failures = [depth, water, vectors]
      .flatMap((result) => result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : []);
    throw new RoutingDataUnavailableError(failures.join('; '), unavailable);
  }
  if (depth.status !== 'fulfilled' || water.status !== 'fulfilled' || vectors.status !== 'fulfilled') {
    throw new RoutingDataUnavailableError('Marsruudi snapshot jäi poolikuks', unavailable);
  }
  return { depth: depth.value, water: water.value, vectors: vectors.value };
}

export function routePlanningBbox(request: RoutePlanRequest, distanceM: number): BBox {
  const points = [request.start, request.end];
  const south = Math.min(...points.map((point) => point.lat));
  const north = Math.max(...points.map((point) => point.lat));
  const west = Math.min(...points.map((point) => point.lon));
  const east = Math.max(...points.map((point) => point.lon));
  const paddingM = Math.max(5 * 1_852, Math.min(40 * 1_852, distanceM * 0.25));
  const middleLatitude = (south + north) / 2;
  const latPadding = paddingM / 111_320;
  const lonPadding = paddingM / Math.max(1_000,
    111_320 * Math.cos(middleLatitude * Math.PI / 180));
  return [
    Math.max(config.routingBbox[0], south - latPadding),
    Math.max(config.routingBbox[1], west - lonPadding),
    Math.min(config.routingBbox[2], north + latPadding),
    Math.min(config.routingBbox[3], east + lonPadding),
  ];
}

function snapToNavigableCell(
  surface: RoutingCostSurface,
  requested: { lat: number; lon: number },
): SnappedRouteEndpoint | null {
  const snapped = snapEndpoint(surface, surface.toGrid(requested), {
    maxDistanceCells: MAX_ENDPOINT_SNAP_M / surface.projection.cellSizeM,
    allowed: endpointEscapePredicate(surface),
  });
  if (!snapped) return null;
  const position = surface.toPosition(snapped.point);
  const distanceM = distanceMetres(requested, { lon: position[0], lat: position[1] });
  return distanceM <= MAX_ENDPOINT_SNAP_M
    ? { point: snapped.point, position, distanceM }
    : null;
}

function endpointEscapePredicate(surface: RoutingCostSurface): (point: GridPoint) => boolean {
  const known = new Map<number, boolean>();
  return (start) => {
    const startIndex = start.y * surface.width + start.x;
    const cached = known.get(startIndex);
    if (cached !== undefined) return cached;

    const queue: GridPoint[] = [{ ...start }];
    const visited = new Set<number>([startIndex]);
    for (let cursor = 0; cursor < queue.length && queue.length < MIN_ENDPOINT_COMPONENT_CELLS; cursor++) {
      for (const neighbour of traversableNeighbours(surface, queue[cursor]!)) {
        const index = neighbour.point.y * surface.width + neighbour.point.x;
        if (visited.has(index)) continue;
        visited.add(index);
        queue.push(neighbour.point);
        if (queue.length >= MIN_ENDPOINT_COMPONENT_CELLS) break;
      }
    }
    const escaped = queue.length >= MIN_ENDPOINT_COMPONENT_CELLS;
    for (const index of visited) known.set(index, escaped);
    return escaped;
  };
}

function connectedHarbourAccess(
  surface: RoutingCostSurface,
  access: HarbourAccess | null,
): HarbourAccess | null {
  if (!access) return null;
  const outerPoint = gridPointAt(surface, access.waypoints.at(-1)!);
  if (surface.cellAt(outerPoint.x, outerPoint.y).blocked) return null;
  return endpointEscapePredicate(surface)(outerPoint) ? access : null;
}

/**
 * Tuletatud kanal on kasutatav ainult siis, kui kõik selle tugipunktid
 * (peale sadamapunkti enda) on läbitavates lahtrites. Muidu jääb kanal
 * kõrvale ja otspunkt käitub tavalise veepunktina; vastasel juhul teeks
 * `requiredHarbourAnchors` kogu tulemusest no_route.
 */
function navigableHarbourAccess(
  surface: RoutingCostSurface,
  access: HarbourAccess | null,
): HarbourAccess | null {
  if (!access) return null;
  for (const position of access.waypoints.slice(1)) {
    const coordinate = surface.toGrid({ lon: position[0], lat: position[1] });
    const point = { x: Math.round(coordinate.x), y: Math.round(coordinate.y) };
    if (point.x < 0 || point.x >= surface.width || point.y < 0 || point.y >= surface.height) {
      return null;
    }
    if (surface.cellAt(point.x, point.y).blocked) return null;
  }
  return access;
}

/** Finds the nearest endpoint cell in the same navigable component as `seed`. */
export function snapToReachableCell(
  surface: RoutingCostSurface,
  requested: { lat: number; lon: number },
  seed: GridPoint,
  checkpoint: () => void = () => undefined,
): SnappedRouteEndpoint | null {
  if (seed.x < 0 || seed.x >= surface.width || seed.y < 0 || seed.y >= surface.height
    || surface.cellAt(seed.x, seed.y).blocked) return null;

  const size = surface.width * surface.height;
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);
  const seedIndex = seed.y * surface.width + seed.x;
  visited[seedIndex] = 1;
  queue[0] = seedIndex;
  let head = 0;
  let tail = 1;
  let best: SnappedRouteEndpoint | null = null;
  const requestedGrid = surface.toGrid(requested);
  const maxDistanceCells = MAX_ENDPOINT_SNAP_M / surface.projection.cellSizeM;

  while (head < tail) {
    if ((head & 1_023) === 0) checkpoint();
    const index = queue[head++]!;
    const point = { x: index % surface.width, y: Math.floor(index / surface.width) };
    if (Math.hypot(point.x - requestedGrid.x, point.y - requestedGrid.y) <= maxDistanceCells + 1) {
      const position = surface.toPosition(point);
      const distanceM = distanceMetres(requested, { lon: position[0], lat: position[1] });
      if (distanceM <= MAX_ENDPOINT_SNAP_M && (!best
        || distanceM < best.distanceM - 1e-9
        || (Math.abs(distanceM - best.distanceM) <= 1e-9
          && (point.y < best.point.y || (point.y === best.point.y && point.x < best.point.x))))) {
        best = { point, position, distanceM };
      }
    }

    for (const neighbour of traversableNeighbours(surface, point)) {
      const neighbourIndex = neighbour.point.y * surface.width + neighbour.point.x;
      if (visited[neighbourIndex]) continue;
      visited[neighbourIndex] = 1;
      queue[tail++] = neighbourIndex;
    }
  }
  return best;
}

/**
 * Sadama lähedal ei piisa suvalisest lähimast avatud võrerakust: see võib
 * jääda küll veele, kuid teisele poole muuli või rannajoont. Kui lähim rakk
 * pole üks tuletatud sadamakoridori täpsetest tugipunktidest, alustame/lõpetame
 * lähimas läbitavas koridori tugipunktis.
 */
export function snapRouteEndpoint(
  surface: RoutingCostSurface,
  requested: { lat: number; lon: number },
  access: HarbourAccess | null,
): SnappedRouteEndpoint | null {
  const nearest = snapToNavigableCell(surface, requested);
  if (!access) return nearest;

  const accessCandidates = new Map<string, {
    point: GridPoint;
    position: [number, number];
    distanceM: number;
  }>();
  for (const waypoint of access.waypoints) {
    const coordinate = surface.toGrid({ lon: waypoint[0], lat: waypoint[1] });
    const point = { x: Math.round(coordinate.x), y: Math.round(coordinate.y) };
    if (point.x < 0 || point.x >= surface.width || point.y < 0 || point.y >= surface.height) continue;
    if (surface.cellAt(point.x, point.y).blocked) continue;
    const position: [number, number] = [waypoint[0], waypoint[1]];
    const distanceM = distanceMetres(requested, { lon: position[0], lat: position[1] });
    if (distanceM > MAX_ENDPOINT_SNAP_M) continue;
    const key = `${point.x}:${point.y}`;
    const previous = accessCandidates.get(key);
    if (!previous || distanceM < previous.distanceM) {
      accessCandidates.set(key, { point, position, distanceM });
    }
  }

  if (nearest) {
    const corridorCandidate = accessCandidates.get(`${nearest.point.x}:${nearest.point.y}`);
    if (corridorCandidate) return corridorCandidate;
  }
  return [...accessCandidates.values()].sort((left, right) =>
    left.distanceM - right.distanceM
      || left.point.y - right.point.y
      || left.point.x - right.point.x,
  )[0] ?? nearest;
}

interface SnappedRouteEndpoint {
  point: GridPoint;
  position: [number, number];
  distanceM: number;
}

function accessFromResult(result: HarbourAccessResult): HarbourAccess | null {
  return result.status === 'access' ? result.access : null;
}

function harbourLimitIssues(
  start: HarbourAccessResult,
  end: HarbourAccessResult,
  request: RoutePlanRequest,
): RoutePlanIssue[] {
  const issues: RoutePlanIssue[] = [];
  for (const [endpoint, result] of [['start', start], ['end', end]] as const) {
    if (result.status !== 'limit') continue;
    const actualM = result.reason === 'draught' ? request.draughtM : request.beamM;
    issues.push({
      code: result.reason === 'draught' ? 'harbour_draught_limit' : 'harbour_beam_limit',
      severity: 'critical',
      sourceIds: [result.harbour.source],
      details: {
        endpoint,
        harbourName: result.harbour.name ?? result.harbour.id,
        limitM: result.limitM,
        actualM,
      },
    });
  }
  return issues;
}

function requiredHarbourAnchors(
  surface: RoutingCostSurface,
  start: { point: GridPoint },
  end: { point: GridPoint },
  startAccess: HarbourAccess | null,
  endAccess: HarbourAccess | null,
): GridPoint[] | null {
  const positions = [
    ...(startAccess?.waypoints.slice(1) ?? []),
    ...(endAccess ? [...endAccess.waypoints].reverse().slice(0, -1) : []),
  ];
  const points: GridPoint[] = [start.point];
  for (const position of positions) {
    const coordinate = surface.toGrid({ lon: position[0], lat: position[1] });
    const point = { x: Math.round(coordinate.x), y: Math.round(coordinate.y) };
    if (point.x < 0 || point.x >= surface.width || point.y < 0 || point.y >= surface.height) {
      return null;
    }
    // Need punktid moodustavad tuletatud sadamakoridori täpse keskjoone.
    // Uus lähima-raku otsing võiks valida naabervee teisel pool muuli ning
    // tekitada keskjoonele tagasipöörde, seega peab just tugipunkti rakk olema
    // läbitav. Kui see pole läbitav, ei ole tuletatud ühendus piisavalt kindel.
    if (surface.cellAt(point.x, point.y).blocked) return null;
    appendGridPoint(points, point);
  }
  appendGridPoint(points, end.point);
  return points;
}

async function findPathThrough(
  surface: RoutingCostSurface,
  anchors: readonly GridPoint[],
  deadline: PlanningDeadline,
  instrumentation?: RoutingInstrumentation,
): Promise<PathSearchResult> {
  if (anchors.length < 2) throw new RangeError('Routing anchors require start and end');
  const path: GridPoint[] = [];
  let totalCost = 0;
  let expandedNodes = 0;
  const searchExpiresAt = performance.now()
    + Math.min(config.routingSearchTimeoutMs, deadline.remainingMs());

  for (let index = 1; index < anchors.length; index++) {
    deadline.checkpoint();
    const remainingNodes = Math.max(0, config.routingSearchMaxNodes - expandedNodes);
    if (remainingNodes === 0) return { status: 'not_found', reason: 'node_limit', expandedNodes };
    const remainingMs = Math.max(0, Math.min(
      searchExpiresAt - performance.now(),
      deadline.remainingMs(),
    ));
    const legStartedAt = performance.now();
    const result = await findPath(surface, anchors[index - 1]!, anchors[index]!, {
      signal: deadline.signal,
      timeoutMs: remainingMs,
      maxExpandedNodes: remainingNodes,
    });
    instrumentation?.phase('search', performance.now() - legStartedAt, {
      leg: index,
      expandedNodes: result.expandedNodes,
      ...(result.heapPushes !== undefined ? { heapPushes: result.heapPushes } : {}),
      ...(result.status === 'found' ? { totalCost: result.totalCost } : {}),
    });
    expandedNodes += result.expandedNodes;
    if (result.status === 'not_found') return { ...result, expandedNodes };
    totalCost += result.totalCost;
    for (const point of result.path) appendGridPoint(path, point);
  }
  return { status: 'found', path, totalCost, expandedNodes };
}

function appendGridPoint(points: GridPoint[], point: GridPoint): void {
  const last = points.at(-1);
  if (!last || last.x !== point.x || last.y !== point.y) points.push({ ...point });
}

function uniquePositions(positions: Array<[number, number]>): [number, number][] {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = `${position[0]}\0${position[1]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function harbourAccessIssues(
  start: HarbourAccess | null,
  end: HarbourAccess | null,
): RoutePlanIssue[] {
  return [start && ['start', start] as const, end && ['end', end] as const]
    .filter((entry): entry is readonly ['start' | 'end', HarbourAccess] => Boolean(entry))
    .map(([endpoint, access]) => ({
      code: 'harbour_access_inferred',
      severity: 'warning' as const,
      sourceIds: [access.corridor.source],
      details: {
        endpoint,
        harbourName: access.harbour.name ?? access.harbour.id,
      },
    }));
}

type PreparedRouteCandidate =
  | {
      status: 'valid';
      coordinates: [number, number][];
      segments: RoutePlanSegment[];
      navigationPath: GridPoint[];
    }
  | { status: 'blocked'; reason: 'land' | 'known_shallow'; position: [number, number] }
  | { status: 'invalid'; code: 'route_geometry_too_complex' | 'route_waypoint_limit' };

function prepareRouteCandidate(
  snapshot: RoutingSnapshot,
  surface: RoutingCostSurface,
  rawPath: readonly GridPoint[],
  requiredAnchors: readonly GridPoint[],
  start: SnappedRouteEndpoint,
  end: SnappedRouteEndpoint,
  startAccess: HarbourAccess | null,
  endAccess: HarbourAccess | null,
  deadline: PlanningDeadline,
): PreparedRouteCandidate {
  // Võreotsing "murrab" trassi kulupiiridel nagu valguskiir (nt TSS-i raja
  // ette tekib V-kujuline jõnks, et rada järsema nurga alt ületada). Väike
  // absoluutne kuluvaru laseb sellised lühikesed murded sirgeks tõmmata;
  // riskiklass ega põhjused halveneda ei tohi ja tulemus revalideeritakse.
  let geometryPath = simplifyPath(surface, rawPath, {
    maxCostRatio: 1.05,
    maxCostIncrease: SIMPLIFY_COST_SLACK,
    preserveRisk: true,
    requiredPoints: requiredAnchors,
    checkpoint: deadline.checkpoint,
  });
  deadline.checkpoint();
  if (geometryPath.length > MAX_GEOMETRY_POINTS) {
    geometryPath = simplifyPath(surface, rawPath, {
      maxCostRatio: 2,
      preserveRisk: true,
      requiredPoints: requiredAnchors,
      checkpoint: deadline.checkpoint,
    });
    deadline.checkpoint();
  }
  if (geometryPath.length > MAX_GEOMETRY_POINTS) {
    return { status: 'invalid', code: 'route_geometry_too_complex' };
  }

  // Navigeerimise waypoint'id peavad kirjeldama sama joont, mida kaart näitab.
  // Kui tavapärane geomeetria on liiga detailne, kasutame ühe kompaktsema,
  // endiselt täielikult revalideeritud variandi NII geomeetriaks kui juhisteks.
  let navigationPath = geometryPath;
  if (navigationPath.length > MAX_NAVIGATION_WAYPOINTS) {
    navigationPath = simplifyPath(surface, rawPath, {
      maxCostRatio: 1.5,
      preserveRisk: true,
      requiredPoints: requiredAnchors,
      checkpoint: deadline.checkpoint,
    });
    deadline.checkpoint();
    if (navigationPath.length <= MAX_NAVIGATION_WAYPOINTS) geometryPath = navigationPath;
  }
  if (navigationPath.length > MAX_NAVIGATION_WAYPOINTS) {
    return { status: 'invalid', code: 'route_waypoint_limit' };
  }

  // GeoJSON LineString vajab vähemalt kaht punkti ka siis, kui mõlemad otsad
  // kleebitakse samasse lahtrisse.
  if (geometryPath.length === 1) geometryPath = [geometryPath[0]!, geometryPath[0]!];
  if (navigationPath.length === 1) navigationPath = [navigationPath[0]!, navigationPath[0]!];

  const positionedGeometryPath = withExactHarbourPositions(
    surface,
    geometryPath,
    start,
    end,
    startAccess,
    endAccess,
  );
  const positionedNavigationPath = withExactHarbourPositions(
    surface,
    navigationPath,
    start,
    end,
    startAccess,
    endAccess,
  );
  if (positionedGeometryPath.length > MAX_GEOMETRY_POINTS) {
    return { status: 'invalid', code: 'route_geometry_too_complex' };
  }
  if (positionedNavigationPath.length > MAX_NAVIGATION_WAYPOINTS) {
    return { status: 'invalid', code: 'route_waypoint_limit' };
  }

  const described = describeRouteGeometry(surface, positionedGeometryPath, deadline.checkpoint);
  deadline.checkpoint();
  if (described.coordinates.length > MAX_GEOMETRY_POINTS
    || described.segments.length > MAX_GEOMETRY_POINTS) {
    return { status: 'invalid', code: 'route_geometry_too_complex' };
  }
  const fineValidation = fineRevalidateSegments(
    snapshot,
    surface,
    described.segments,
    deadline.checkpoint,
  );
  deadline.checkpoint();
  if (fineValidation.status === 'blocked') return fineValidation;
  return {
    status: 'valid',
    coordinates: described.coordinates,
    segments: fineValidation.segments,
    navigationPath: positionedNavigationPath,
  };
}

function withExactHarbourPositions(
  surface: RoutingCostSurface,
  path: readonly GridPoint[],
  start: SnappedRouteEndpoint,
  end: SnappedRouteEndpoint,
  startAccess: HarbourAccess | null,
  endAccess: HarbourAccess | null,
): PositionedGridPoint[] {
  let positioned: PositionedGridPoint[] = path.map((point) => ({ ...point }));

  if (startAccess) {
    const startPositions = harbourPositionsFromStart(startAccess, start.position);
    positioned = overlayExactPositions(surface, positioned, startPositions, 0);
  }

  if (endAccess) {
    const endPositions = harbourPositionsToEnd(endAccess, end.position);
    const outerPoint = gridPointAt(surface, endPositions[0]!);
    const outerIndex = findLastGridPointIndex(positioned, outerPoint);
    if (outerIndex < 0) throw new Error('End harbour outer anchor is missing from the path');
    positioned = overlayExactPositions(surface, positioned, endPositions, outerIndex);
  }

  return positioned;
}

function overlayExactPositions(
  surface: RoutingCostSurface,
  path: readonly PositionedGridPoint[],
  positions: readonly [number, number][],
  minimumIndex: number,
): PositionedGridPoint[] {
  const groups: Array<{ point: GridPoint; positions: [number, number][] }> = [];
  for (const position of positions) {
    const point = gridPointAt(surface, position);
    const last = groups.at(-1);
    if (last && sameGridPoint(last.point, point)) last.positions.push(position);
    else groups.push({ point, positions: [position] });
  }

  const result: PositionedGridPoint[] = [];
  let cursor = 0;
  let searchFrom = minimumIndex;
  for (const group of groups) {
    let found = -1;
    for (let index = searchFrom; index < path.length; index++) {
      if (sameGridPoint(path[index]!, group.point)) {
        found = index;
        break;
      }
    }
    if (found < 0) throw new Error('Harbour geometry anchor is missing from the path');
    result.push(...path.slice(cursor, found));
    result.push(...group.positions.map((position) => ({ ...group.point, position })));
    cursor = found + 1;
    searchFrom = cursor;
  }
  result.push(...path.slice(cursor));
  return result;
}

function harbourPositionsFromStart(
  access: HarbourAccess,
  snapped: [number, number],
): [number, number][] {
  const index = nearestPositionIndex(access.waypoints, snapped);
  return [[snapped[0], snapped[1]], ...access.waypoints.slice(index + 1)];
}

function harbourPositionsToEnd(
  access: HarbourAccess,
  snapped: [number, number],
): [number, number][] {
  const index = nearestPositionIndex(access.waypoints, snapped);
  return [...access.waypoints.slice(index + 1).reverse(), [snapped[0], snapped[1]]];
}

function nearestPositionIndex(
  positions: readonly [number, number][],
  requested: [number, number],
): number {
  let nearestIndex = 0;
  let nearestDistanceM = Number.POSITIVE_INFINITY;
  for (const [index, position] of positions.entries()) {
    const distanceM = distanceMetres(
      { lon: requested[0], lat: requested[1] },
      { lon: position[0], lat: position[1] },
    );
    if (distanceM < nearestDistanceM) {
      nearestDistanceM = distanceM;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function findLastGridPointIndex(
  path: readonly GridPoint[],
  target: GridPoint,
): number {
  for (let index = path.length - 1; index >= 0; index--) {
    if (sameGridPoint(path[index]!, target)) return index;
  }
  return -1;
}

function gridPointAt(surface: RoutingCostSurface, position: [number, number]): GridPoint {
  const coordinate = surface.toGrid({ lon: position[0], lat: position[1] });
  return {
    x: Math.max(0, Math.min(surface.width - 1, Math.round(coordinate.x))),
    y: Math.max(0, Math.min(surface.height - 1, Math.round(coordinate.y))),
  };
}

function sameGridPoint(a: GridPoint, b: GridPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

const FINE_BLOCKED_CELL: RoutingCell = Object.freeze({
  blocked: true,
  costMultiplier: 1,
  risk: 'caution',
  reasons: Object.freeze(['hazard']),
});

function withFineBlockedCells(
  surface: RoutingCostSurface,
  blockedIndexes: ReadonlySet<number>,
): RoutingCostSurface {
  const isBlocked = (x: number, y: number): boolean => blockedIndexes.has(y * surface.width + x);
  return {
    ...surface,
    cellAt(x, y): RoutingCell {
      return isBlocked(x, y) ? FINE_BLOCKED_CELL : surface.cellAt(x, y);
    },
    detailsAt(x, y): RoutingCellDetails {
      const details = surface.detailsAt(x, y);
      if (!isBlocked(x, y)) return details;
      return {
        ...details,
        blocked: true,
        reasons: [...new Set([...details.reasons, 'hazard' as const])],
      };
    },
  };
}

function navigationWaypoints(
  surface: RoutingCostSurface,
  path: readonly PositionedGridPoint[],
): RouteWaypoint[] {
  return path.map((point, index) => {
    const [lon, lat] = point.position ?? surface.toPosition(point);
    return {
      id: `auto-${index + 1}`,
      lat,
      lon,
      ...(index === 0 ? { name: 'A' } : index === path.length - 1 ? { name: 'B' } : {}),
    };
  });
}

type FineValidationResult =
  | { status: 'valid'; segments: RoutePlanSegment[] }
  | { status: 'blocked'; reason: 'land' | 'known_shallow'; position: [number, number] };

/**
 * Võre on otsinguindeks, mitte lõplik ohutustõend. Kontrollime tagastatava
 * joone 10 m sammuga uuesti otse lähterasteritest. Peidetud maa/madalik
 * sulgeb tulemuse; vahepealne NoData muudab ainult vastava lõigu unknown'iks.
 */
export function fineRevalidateSegments(
  snapshot: RoutingSnapshot,
  surface: RoutingCostSurface,
  input: readonly RoutePlanSegment[],
  checkpoint: () => void,
): FineValidationResult {
  const segments = input.map((segment) => ({
    ...segment,
    reasons: [...segment.reasons],
    sourceIds: [...segment.sourceIds],
  }));
  let sampleCount = 0;
  for (const segment of segments) {
    const lengthM = distanceMetres(
      { lon: segment.from[0], lat: segment.from[1] },
      { lon: segment.to[0], lat: segment.to[1] },
    );
    const steps = Math.max(1, Math.ceil(lengthM / FINE_REVALIDATION_STEP_M));
    const reasons = new Set(segment.reasons);
    const sourceIds = new Set(segment.sourceIds);
    let minDepthM = segment.minDepthM ?? Number.POSITIVE_INFINITY;

    for (let index = 0; index <= steps; index++) {
      if ((sampleCount++ & 1_023) === 0) checkpoint();
      const ratio = index / steps;
      const lon = segment.from[0] + (segment.to[0] - segment.from[0]) * ratio;
      const lat = segment.from[1] + (segment.to[1] - segment.from[1]) * ratio;
      const water = routingWaterAt(snapshot.water, lon, lat);
      const grid = surface.toGrid({ lon, lat });
      const cellX = Math.max(0, Math.min(surface.width - 1, Math.round(grid.x)));
      const cellY = Math.max(0, Math.min(surface.height - 1, Math.round(grid.y)));
      const cell = surface.detailsAt(cellX, cellY);
      const harbourAccessOverride = !cell.blocked
        && cell.reasons.includes('harbour_access')
        && !cell.reasons.includes('official_corridor_limit')
        && !cell.reasons.includes('hazard')
        && !cell.reasons.includes('restricted_area');
      if (water === false && !harbourAccessOverride) {
        return { status: 'blocked', reason: 'land', position: [lon, lat] };
      }
      const officialOverride = !cell.blocked
        && cell.reasons.includes('official_corridor')
        && !cell.reasons.includes('official_corridor_limit')
        && !cell.reasons.includes('depth_unknown')
        && !cell.reasons.includes('known_shallow')
        && !cell.reasons.includes('land');
      const depth = routingDepthAt(snapshot.depth, lon, lat);
      if (!officialOverride && (depth.state === RoutingDepthState.Land
        || (depth.state === RoutingDepthState.Water
          && depth.depthM !== null && depth.depthM < surface.requiredDepthM))) {
        return {
          status: 'blocked',
          reason: depth.state === RoutingDepthState.Land ? 'land' : 'known_shallow',
          position: [lon, lat],
        };
      }
      if (!officialOverride && depth.state === RoutingDepthState.Water && depth.depthM !== null) {
        minDepthM = Math.min(minDepthM, depth.depthM);
        if (depth.depthM < surface.requiredDepthM + 0.5) reasons.add('low_clearance');
      }
      if (water === null) {
        reasons.add('water_mask_unknown');
        sourceIds.add('openfreemap-water');
      }
      if (!officialOverride && (depth.state === RoutingDepthState.NoData || depth.depthM === null)) {
        reasons.add('depth_unknown');
        sourceIds.add('emodnet-depth');
      }
      if (!isWithinRoutingServicePosition(lon, lat)) reasons.add('official_coverage_unknown');
    }

    segment.reasons = [...reasons].sort();
    segment.sourceIds = [...sourceIds].sort();
    segment.minDepthM = Number.isFinite(minDepthM) ? minDepthM : null;
    if (reasons.has('water_mask_unknown') || reasons.has('depth_unknown')
      || reasons.has('official_coverage_unknown')) segment.assessment = 'unknown';
    else if (segment.assessment === 'clear' && reasons.has('low_clearance')) segment.assessment = 'caution';
  }
  return { status: 'valid', segments };
}

function snapshotSources(snapshot: RoutingSnapshot): RoutePlanSource[] {
  return [
    snapshot.depth.source,
    snapshot.water.source,
    ...snapshot.vectors.sources
      .filter((source) => source.status !== 'outside_coverage')
      .map(routePlanSource),
  ];
}

function routePlanSource(source: RoutingSourceMeta): RoutePlanSource {
  return {
    id: source.id,
    fetchedAt: source.fetchedAt,
    ageSeconds: source.ageSeconds,
    stale: source.stale,
    coverage: source.coverage,
    ...(source.error ? { error: source.error } : {}),
  };
}

function sourceIssues(sources: readonly RoutePlanSource[]): RoutePlanIssue[] {
  return sources.flatMap((source) => {
    if (source.coverage === 'missing') {
      return [{ code: 'source_unavailable', severity: 'warning' as const, sourceIds: [source.id] }];
    }
    if (source.coverage === 'partial') {
      return [{ code: 'source_partial', severity: 'warning' as const, sourceIds: [source.id] }];
    }
    if (source.stale) {
      return [{ code: 'source_stale', severity: 'warning' as const, sourceIds: [source.id] }];
    }
    return [];
  });
}

function endpointIssues(startDistanceM: number, endDistanceM: number): RoutePlanIssue[] {
  const issues: RoutePlanIssue[] = [];
  if (startDistanceM > 1) {
    issues.push({
      code: 'start_snapped',
      severity: startDistanceM > 50 ? 'warning' : 'info',
      details: { distanceM: Math.round(startDistanceM) },
    });
  }
  if (endDistanceM > 1) {
    issues.push({
      code: 'end_snapped',
      severity: endDistanceM > 50 ? 'warning' : 'info',
      details: { distanceM: Math.round(endDistanceM) },
    });
  }
  return issues;
}

function segmentIssues(segments: readonly RoutePlanSegment[]): RoutePlanIssue[] {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    for (const reason of segment.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].flatMap(([reason, affectedSegments]): RoutePlanIssue[] => {
    if (reason === 'official_corridor' || reason === 'recommended_route' || reason === 'traffic_lane') return [];
    return [{
      code: reason,
      severity: 'warning',
      details: { affectedSegments },
    }];
  });
}

function dedupeIssues(issues: RoutePlanIssue[]): RoutePlanIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\0${[...(issue.sourceIds ?? [])].sort().join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function noRouteForSearchFailure(
  failure: PathSearchFailure,
  sources: RoutePlanSource[],
  extraIssues: RoutePlanIssue[] = [],
): RoutePlanResponse {
  const code = failure.reason === 'timeout'
    ? 'search_timeout'
    : failure.reason === 'node_limit' ? 'search_node_limit' : 'no_navigable_route';
  return {
    status: 'no_route',
    sources,
    issues: [
      { code, severity: 'critical', details: { expandedNodes: failure.expandedNodes } },
      ...extraIssues,
    ],
  };
}

function snapshotId(
  bbox: BBox,
  departureTime: string,
  sources: readonly RoutePlanSource[],
  vectors: RoutingVectorData,
): string {
  const stableSources = sources.map(({ ageSeconds: _ageSeconds, ...source }) => source);
  const featureIds = [
    ...vectors.hazards.map((feature) => `hazard:${feature.id}`),
    ...vectors.corridors.map((feature) => `corridor:${feature.id}`),
    ...vectors.restrictions.map((feature) => `restriction:${feature.id}`),
    ...vectors.warnings.map((feature) => `warning:${feature.id}`),
    ...vectors.surveyAreas.map((feature) => `survey:${feature.id}`),
    ...(vectors.harbours ?? []).map((feature) => `harbour:${feature.id}`),
  ].sort();
  return createHash('sha256')
    .update(JSON.stringify({
      bbox,
      departureTime: new Date(departureTime).toISOString(),
      sources: stableSources,
      featureIds,
    }))
    .digest('hex')
    .slice(0, 20);
}

interface PlanningDeadline {
  signal: AbortSignal;
  checkpoint(): void;
  remainingMs(): number;
  waitFor<T>(promise: Promise<T>): Promise<T>;
  dispose(): void;
}

function planningDeadline(parent: AbortSignal | undefined, timeoutMs: number): PlanningDeadline {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('Routing plan timeout must be a finite non-negative number');
  }
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const abortWith = (reason: Error): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const abortFromParent = (): void => abortWith(abortError());
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => abortWith(new RoutingPlanTimeoutError()), timeoutMs);
  timer.unref();

  const abortedReason = (): Error => controller.signal.reason instanceof Error
    ? controller.signal.reason
    : abortError();
  const checkpoint = (): void => {
    if (!controller.signal.aborted && performance.now() >= expiresAt) {
      abortWith(new RoutingPlanTimeoutError());
    }
    if (controller.signal.aborted) throw abortedReason();
  };

  return {
    signal: controller.signal,
    checkpoint,
    remainingMs() {
      checkpoint();
      return Math.max(0, expiresAt - performance.now());
    },
    waitFor<T>(promise: Promise<T>): Promise<T> {
      checkpoint();
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortedReason());
        controller.signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          (value) => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function abortError(): Error {
  const error = new Error('Marsruudi arvutamine katkestati');
  error.name = 'AbortError';
  return error;
}
