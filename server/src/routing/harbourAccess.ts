import { distanceMetres } from '@seapro/shared';
import { pointInRoutingGeometry } from './sourceGeometry.js';
import type { RoutingVesselProfile } from './costSurface.js';
import type {
  Position,
  RoutingCorridor,
  RoutingGeometry,
  RoutingHarbour,
  RoutingHazard,
  RoutingVectorData,
} from './sourceTypes.js';

const MAX_HARBOUR_DISTANCE_M = 1_000;
const MAX_FAIRWAY_CONNECTOR_M = 1_500;
const MAX_GATE_DISTANCE_M = 1_200;
const MAX_GATE_WIDTH_M = 250;
const SEA_EXTENSION_M = 400;

export interface HarbourAccess {
  harbour: RoutingHarbour;
  corridor: RoutingCorridor;
  /** Sadamast mere suunas; planner läbib need punktid antud järjekorras. */
  waypoints: Position[];
}

export type HarbourAccessResult =
  | { status: 'none' }
  | {
      status: 'limit';
      harbour: RoutingHarbour;
      reason: 'draught' | 'beam';
      limitM: number;
    }
  | { status: 'access'; access: HarbourAccess };

/**
 * Tuletab valitud sadamapunktile kitsa ühenduse ametliku laevatee või
 * punase/rohelise märgipaari kaudu. See on otsapunkti ühendus, mitte luba
 * avada kogu sadama ümbruse madalikke. `limit` tähendab, et ligipääsu ei
 * tuletata — planner käsitleb otspunkti tavalise veepunktina ja raporteerib
 * registripiirangu hoiatusena, mitte kõva tõkkena.
 */
export function deriveHarbourAccess(
  endpoint: { lat: number; lon: number },
  vessel: RoutingVesselProfile,
  vectors: RoutingVectorData,
  endpointId: 'start' | 'end',
): HarbourAccessResult {
  const position: Position = [endpoint.lon, endpoint.lat];
  const harbour = nearestHarbour(position, vectors.harbours ?? []);
  if (!harbour) return { status: 'none' };

  if (harbour.maxDraughtM !== undefined && vessel.draughtM > harbour.maxDraughtM) {
    return { status: 'limit', harbour, reason: 'draught', limitM: harbour.maxDraughtM };
  }
  if (harbour.maxBeamM !== undefined && vessel.beamM > harbour.maxBeamM) {
    return { status: 'limit', harbour, reason: 'beam', limitM: harbour.maxBeamM };
  }

  const requiredDepthM = vessel.draughtM + vessel.underKeelClearanceM;
  const target = nearestSuitableOfficialCorridor(position, vectors.corridors, vessel, requiredDepthM);
  const gates = harbourGates(harbour, position, vectors.hazards, vessel.beamM, target?.point);
  if (!target && gates.length === 0) return { status: 'none' };
  // Ilma avaldatud väylä sügavuse või sadama lubatud süviseta ei tohi
  // tuletatud joon EMODneti teadaolevat madalust avada.
  if (!target && harbour.maxDraughtM === undefined) return { status: 'none' };

  const waypoints: Position[] = [position, ...gates.map((gate) => gate.midpoint)];
  if (target) {
    appendDistinct(waypoints, target.point);
    const interiorPoint = corridorContinuationPoint(position, target.point, target.corridor.geometry);
    if (interiorPoint) appendDistinct(waypoints, interiorPoint);
  } else {
    const outer = waypoints.at(-1)!;
    const inner = waypoints.at(-2) ?? position;
    appendDistinct(waypoints, extendPosition(inner, outer, SEA_EXTENSION_M));
  }
  if (waypoints.length < 2) return { status: 'none' };

  const gateWidthM = gates.length
    ? Math.min(...gates.map((gate) => gate.widthM))
    : 30;
  const widthM = Math.max(vessel.beamM + 4, Math.min(60, gateWidthM - 4));
  const targetDepthM = target?.corridor.sweptDepthM ?? target?.corridor.depthM;
  const targetDraughtM = target?.corridor.maxDraughtM;
  const maxDraughtM = minimumDefined(harbour.maxDraughtM, targetDraughtM);
  const boundaryAidIds = [...new Set(gates.flatMap((gate) => [gate.port.id, gate.starboard.id]))];
  const source = target?.corridor.source ?? harbour.source;
  const corridor: RoutingCorridor = {
    id: `derived:harbour-access:${endpointId}:${harbour.id}`,
    kind: 'fairway',
    geometry: { type: 'LineString', coordinates: waypoints },
    geometryRole: 'centreline',
    name: `${harbour.name ?? 'Sadam'} – sadamakanal`,
    ...(targetDepthM !== undefined ? { sweptDepthM: targetDepthM } : {}),
    ...(maxDraughtM !== undefined ? { maxDraughtM } : {}),
    widthM,
    official: Boolean(harbour.official || target?.corridor.official),
    harbourAccess: true,
    boundaryAidIds,
    waypoints,
    category: 'derived_harbour_access',
    source,
    fetchedAt: newestTimestamp(harbour.fetchedAt, target?.corridor.fetchedAt),
    stale: harbour.stale || Boolean(target?.corridor.stale),
  };
  return { status: 'access', access: { harbour, corridor, waypoints } };
}

function nearestHarbour(position: Position, harbours: readonly RoutingHarbour[]): RoutingHarbour | null {
  const candidates = harbours
    .map((harbour) => ({ harbour, distanceM: distanceToGeometry(position, harbour.geometry).distanceM }))
    .filter((candidate) => candidate.distanceM <= MAX_HARBOUR_DISTANCE_M)
    .sort((a, b) => Number(b.harbour.official) - Number(a.harbour.official)
      || a.distanceM - b.distanceM
      || a.harbour.id.localeCompare(b.harbour.id));
  return candidates[0]?.harbour ?? null;
}

function nearestSuitableOfficialCorridor(
  position: Position,
  corridors: readonly RoutingCorridor[],
  vessel: RoutingVesselProfile,
  requiredDepthM: number,
): { corridor: RoutingCorridor; point: Position; distanceM: number } | null {
  const candidates = corridors.flatMap((corridor) => {
    if (!corridor.official || corridor.harbourAccess) return [];
    const publishedDepth = corridor.sweptDepthM ?? corridor.depthM;
    if (publishedDepth === undefined && corridor.maxDraughtM === undefined) return [];
    if (publishedDepth !== undefined && publishedDepth < requiredDepthM) return [];
    if (corridor.maxDraughtM !== undefined && requiredDepthM > corridor.maxDraughtM) return [];
    if (corridor.widthM !== undefined && vessel.beamM > corridor.widthM) return [];
    const nearest = distanceToGeometry(position, corridor.geometry);
    if (nearest.distanceM > MAX_FAIRWAY_CONNECTOR_M) return [];
    return [{ corridor, point: nearest.point, distanceM: nearest.distanceM }];
  });
  candidates.sort((a, b) => a.distanceM - b.distanceM || a.corridor.id.localeCompare(b.corridor.id));
  const closest = candidates[0];
  if (!closest) return null;
  // Väilaala serv on sadamale veidi lähemal kui selle navigatsioonijoon, kuid
  // jämedas võrgus võib servalahter jääda ülejäänud väilast lahku. Kui ametlik
  // keskjoon on peaaegu sama lähedal, on see usaldusväärsem ühenduspunkt.
  return candidates.find((candidate) => candidate.corridor.geometryRole === 'centreline'
    && candidate.distanceM <= closest.distanceM + 250) ?? closest;
}

interface HarbourGate {
  port: RoutingHazard;
  starboard: RoutingHazard;
  midpoint: Position;
  widthM: number;
}

function harbourGates(
  harbour: RoutingHarbour,
  endpoint: Position,
  hazards: readonly RoutingHazard[],
  beamM: number,
  target?: Position,
): HarbourGate[] {
  const aids = hazards.filter((hazard) => hazard.kind === 'physical_aid'
    && hazard.geometry.type === 'Point'
    && hazard.operational !== false
    && (hazard.navigationRole === 'lateral-port' || hazard.navigationRole === 'lateral-starboard')
    && distance(positionOf(hazard), endpoint) <= MAX_GATE_DISTANCE_M
    && aidMatchesHarbour(hazard, harbour));
  const ports = aids.filter((aid) => aid.navigationRole === 'lateral-port');
  const starboards = aids.filter((aid) => aid.navigationRole === 'lateral-starboard');
  const pairs = new Map<string, HarbourGate>();

  const addNearest = (aid: RoutingHazard, others: RoutingHazard[]): void => {
    const candidates = others.map((other) => ({
      other,
      widthM: distance(positionOf(aid), positionOf(other)),
    })).filter(({ widthM }) => widthM >= beamM + 4 && widthM <= MAX_GATE_WIDTH_M)
      .sort((a, b) => a.widthM - b.widthM || a.other.id.localeCompare(b.other.id));
    const nearest = candidates[0];
    if (!nearest) return;
    const port = aid.navigationRole === 'lateral-port' ? aid : nearest.other;
    const starboard = aid.navigationRole === 'lateral-starboard' ? aid : nearest.other;
    const a = positionOf(port);
    const b = positionOf(starboard);
    const key = [port.id, starboard.id].sort().join('\0');
    pairs.set(key, {
      port,
      starboard,
      midpoint: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      widthM: nearest.widthM,
    });
  };
  ports.forEach((aid) => addNearest(aid, starboards));
  starboards.forEach((aid) => addNearest(aid, ports));

  const result = [...pairs.values()]
    .filter((gate) => !target
      || distanceToSegment(gate.midpoint, endpoint, target).distanceM <= MAX_GATE_DISTANCE_M / 2)
    .sort((a, b) => distance(endpoint, a.midpoint) - distance(endpoint, b.midpoint)
      || a.port.id.localeCompare(b.port.id));
  // Mitme sama koha duplikaadi korral piisab ühest keskpunktist.
  return result.filter((gate, index) => index === 0
    || distance(gate.midpoint, result[index - 1]!.midpoint) >= 15);
}

function aidMatchesHarbour(aid: RoutingHazard, harbour: RoutingHarbour): boolean {
  const harbourTokens = normalizedName(harbour.name ?? '').split(' ').filter((token) => token.length >= 4);
  if (harbourTokens.length === 0) return true;
  const aidName = normalizedName(aid.name ?? '');
  return harbourTokens.some((token) => aidName.includes(token));
}

function normalizedName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(sadam|harbour|harbor|marina|vierassatama|vierasvenesatama)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function positionOf(hazard: RoutingHazard): Position {
  if (hazard.geometry.type !== 'Point') throw new TypeError('Harbour gate aid must be a point');
  return hazard.geometry.coordinates;
}

function distanceToGeometry(origin: Position, geometry: RoutingGeometry): { point: Position; distanceM: number } {
  if ((geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
    && pointInRoutingGeometry(origin, geometry)) return { point: origin, distanceM: 0 };
  if (geometry.type === 'Point') return { point: geometry.coordinates, distanceM: distance(origin, geometry.coordinates) };
  if (geometry.type === 'MultiPoint') return nearestPoint(origin, geometry.coordinates);
  const lines = geometry.type === 'LineString' ? [geometry.coordinates]
    : geometry.type === 'MultiLineString' || geometry.type === 'Polygon' ? geometry.coordinates
      : geometry.coordinates.flat();
  let best: { point: Position; distanceM: number } | null = null;
  for (const line of lines) {
    if (line.length === 1) {
      const candidate = { point: line[0]!, distanceM: distance(origin, line[0]!) };
      if (!best || candidate.distanceM < best.distanceM) best = candidate;
    }
    for (let index = 1; index < line.length; index++) {
      const candidate = distanceToSegment(origin, line[index - 1]!, line[index]!);
      if (!best || candidate.distanceM < best.distanceM) best = candidate;
    }
  }
  return best ?? { point: origin, distanceM: Number.POSITIVE_INFINITY };
}

function nearestPoint(origin: Position, points: readonly Position[]): { point: Position; distanceM: number } {
  return points.map((point) => ({ point, distanceM: distance(origin, point) }))
    .sort((a, b) => a.distanceM - b.distanceM)[0]
    ?? { point: origin, distanceM: Number.POSITIVE_INFINITY };
}

function distanceToSegment(point: Position, a: Position, b: Position): { point: Position; distanceM: number } {
  const latitude = (point[1] + a[1] + b[1]) / 3;
  const metresPerLon = 111_320 * Math.cos(latitude * Math.PI / 180);
  const ax = (a[0] - point[0]) * metresPerLon;
  const ay = (a[1] - point[1]) * 111_320;
  const bx = (b[0] - point[0]) * metresPerLon;
  const by = (b[1] - point[1]) * 111_320;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator));
  const nearest: Position = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
  return { point: nearest, distanceM: distance(point, nearest) };
}

function extendPosition(from: Position, through: Position, extensionM: number): Position {
  const latitude = (from[1] + through[1]) / 2;
  const metresPerLon = 111_320 * Math.cos(latitude * Math.PI / 180);
  const dx = (through[0] - from[0]) * metresPerLon;
  const dy = (through[1] - from[1]) * 111_320;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-6) return through;
  return [
    through[0] + dx / length * extensionM / metresPerLon,
    through[1] + dy / length * extensionM / 111_320,
  ];
}

/**
 * Lähim punkt polügoonil asub tavaliselt täpselt väila piiril. Nihutame
 * ühenduse kuni 400 m väila sisse, et jämedas marsruudivõrgus ei jääks
 * sadamakanal ühe eraldatud servalahtri külge.
 */
function corridorContinuationPoint(
  harbour: Position,
  boundary: Position,
  geometry: RoutingGeometry,
): Position | null {
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
    const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
    const boundaryDistanceM = distance(harbour, boundary);
    const candidates = lines.flatMap((line) => line).flatMap((point) => {
      const alongM = distance(boundary, point);
      if (alongM <= 5 || alongM > SEA_EXTENSION_M * 1.25) return [];
      return distance(harbour, point) > boundaryDistanceM + 5 ? [point] : [];
    }).sort((a, b) => distance(boundary, b) - distance(boundary, a));
    return candidates[0] ?? null;
  }
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const candidates = polygons.flatMap((polygon) => {
    const centre = polygonCentroid(polygon[0] ?? []);
    if (!centre || !pointInRoutingGeometry(centre, geometry)) return [];
    return [centre];
  }).sort((a, b) => distance(boundary, a) - distance(boundary, b));

  for (const centre of candidates) {
    const totalM = distance(boundary, centre);
    if (totalM <= 1) continue;
    const preferredM = Math.min(SEA_EXTENSION_M, totalM);
    for (const fraction of [1, 0.75, 0.5, 0.25]) {
      const point = interpolateMetres(boundary, centre, preferredM * fraction);
      if (pointInRoutingGeometry(point, geometry)
        && distance(harbour, point) > distance(harbour, boundary) + 5) return point;
    }
  }
  return null;
}

function polygonCentroid(ring: readonly Position[]): Position | null {
  if (ring.length < 3) return null;
  let twiceArea = 0;
  let weightedLon = 0;
  let weightedLat = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    const cross = current[0] * next[1] - next[0] * current[1];
    twiceArea += cross;
    weightedLon += (current[0] + next[0]) * cross;
    weightedLat += (current[1] + next[1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    const points = ring.length > 1 && distance(ring[0]!, ring.at(-1)!) < 0.5
      ? ring.slice(0, -1)
      : ring;
    if (points.length === 0) return null;
    return [
      points.reduce((sum, point) => sum + point[0], 0) / points.length,
      points.reduce((sum, point) => sum + point[1], 0) / points.length,
    ];
  }
  return [weightedLon / (3 * twiceArea), weightedLat / (3 * twiceArea)];
}

function interpolateMetres(from: Position, to: Position, travelM: number): Position {
  const totalM = distance(from, to);
  if (totalM <= 1e-6) return from;
  const ratio = Math.min(1, travelM / totalM);
  return [
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
  ];
}

function distance(a: Position, b: Position): number {
  return distanceMetres({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] });
}

function appendDistinct(points: Position[], point: Position): void {
  if (distance(points.at(-1)!, point) > 0.5) points.push(point);
}

function minimumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function newestTimestamp(a: string, b?: string): string {
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
