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
  const channel = harbourChannel(harbour, position, vectors.hazards, vessel.beamM, target?.point);
  if (!target && !channel) return { status: 'none' };
  // Ilma avaldatud väylä sügavuse või sadama lubatud süviseta ei tohi
  // tuletatud joon EMODneti teadaolevat madalust avada.
  if (!target && harbour.maxDraughtM === undefined) return { status: 'none' };

  const waypoints: Position[] = [position, ...(channel?.midpoints ?? [])];
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

  const gateWidthM = channel?.widthM ?? 30;
  const widthM = Math.max(vessel.beamM + 4, Math.min(60, gateWidthM - 4));
  const targetDepthM = target?.corridor.sweptDepthM ?? target?.corridor.depthM;
  const targetDraughtM = target?.corridor.maxDraughtM;
  const maxDraughtM = minimumDefined(harbour.maxDraughtM, targetDraughtM);
  const boundaryAidIds = channel?.boundaryAidIds ?? [];
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

interface HarbourChannel {
  /** Sadamast mere suunas järjestatud keskjoone punktid. */
  midpoints: Position[];
  /** Kitsaim mõõdetud laius külgjoonte vahel. */
  widthM: number;
  boundaryAidIds: string[];
}

interface ChainEntry {
  aid: RoutingHazard;
  position: Position;
  /** Kaugus meetrites piki sadamast-merele telge. */
  along: number;
}

/**
 * Kanal tuletatakse külgede JOONTEST, mitte märgipaaridest: vasaku külje
 * märgid moodustavad ühe serva, parema külje märgid teise, ja keskjoon
 * jookseb joonte vahel. Märgid ei ole päriselt paaris ja külgede arvud
 * võivad erineda — kumbagi serva interpoleeritakse eraldi ning keskjoone
 * jaam võetakse iga märgi kõrguselt. Nii ei teki tiheda märgistusega
 * sadamas diagonaalseid "väravaid" üle basseini ega siksakitavat ketti.
 */
function harbourChannel(
  harbour: RoutingHarbour,
  endpoint: Position,
  hazards: readonly RoutingHazard[],
  beamM: number,
  target?: Position,
): HarbourChannel | null {
  const aids = hazards.filter((hazard) => hazard.kind === 'physical_aid'
    && hazard.geometry.type === 'Point'
    && hazard.operational !== false
    && (hazard.navigationRole === 'lateral-port' || hazard.navigationRole === 'lateral-starboard')
    && distance(positionOf(hazard), endpoint) <= MAX_GATE_DISTANCE_M
    && aidMatchesHarbour(hazard, harbour));
  if (aids.length === 0) return null;

  // Telg: sadamapunktist ametliku laevatee ühenduspunkti või märkide
  // keskme poole. Selle peale projitseerituna saab mõlema külje märgid
  // ühtsesse "sadamast merele" järjekorda.
  const positions = aids.map(positionOf);
  const axisTarget: Position = target ?? [
    positions.reduce((sum, p) => sum + p[0], 0) / positions.length,
    positions.reduce((sum, p) => sum + p[1], 0) / positions.length,
  ];
  const metresPerLon = 111_320 * Math.cos(endpoint[1] * Math.PI / 180);
  const axisX = (axisTarget[0] - endpoint[0]) * metresPerLon;
  const axisY = (axisTarget[1] - endpoint[1]) * 111_320;
  const axisLength = Math.hypot(axisX, axisY);
  if (axisLength <= 1e-6) return null;
  const along = (p: Position): number =>
    ((p[0] - endpoint[0]) * metresPerLon * axisX + (p[1] - endpoint[1]) * 111_320 * axisY) / axisLength;

  const chainOf = (role: 'lateral-port' | 'lateral-starboard'): ChainEntry[] => aids
    .filter((aid) => aid.navigationRole === role)
    .map((aid) => ({ aid, position: positionOf(aid), along: along(positionOf(aid)) }))
    .sort((a, b) => a.along - b.along || a.aid.id.localeCompare(b.aid.id));
  const rawPorts = chainOf('lateral-port');
  const rawStarboards = chainOf('lateral-starboard');
  if (rawPorts.length === 0 || rawStarboards.length === 0) return null;
  // Sama külje märgid peaaegu samal telje-kõrgusel (nt poi ja muulipealne
  // tulepaak kõrvuti) teeksid servajoone ENDA siksakiliseks. Klastrist jääb
  // kanalile ehk vastasservale lähem märk — kitsam serv on ohutum.
  const ports = dedupeAbeam(rawPorts, rawStarboards);
  const starboards = dedupeAbeam(rawStarboards, rawPorts);

  // Jaam iga märgi telje-kõrgusel, aga ainult seal, kus MÕLEMAD servad on
  // defineeritud (ulatuste ühisosa): klambris serv tõmbaks keskjoone
  // külgsuunas vingerdama. Kui ühisosa puudub (nt kummalgi küljel üks märk
  // eri kõrgustel), jääb üks jaam nende vahele. Sadama tagune (t <= 0)
  // jäetakse välja; otsad katavad sadamapunkt ja mere-pikendus.
  const overlapStart = Math.max(ports[0]!.along, starboards[0]!.along);
  const overlapEnd = Math.min(ports.at(-1)!.along, starboards.at(-1)!.along);
  const stations = (overlapStart > overlapEnd
    ? [(overlapStart + overlapEnd) / 2]
    : [...new Set([...ports, ...starboards]
      .map((entry) => entry.along)
      .filter((t) => t >= overlapStart && t <= overlapEnd))])
    .filter((t) => t > 1)
    .sort((a, b) => a - b);

  const midpoints: Position[] = [];
  let narrowestM = Number.POSITIVE_INFINITY;
  for (const station of stations) {
    const portSide = sideLineAt(ports, station);
    const starboardSide = sideLineAt(starboards, station);
    const widthM = distance(portSide, starboardSide);
    if (widthM < beamM + 4 || widthM > MAX_GATE_WIDTH_M) continue;
    const midpoint: Position = [
      (portSide[0] + starboardSide[0]) / 2,
      (portSide[1] + starboardSide[1]) / 2,
    ];
    if (target && distanceToSegment(midpoint, endpoint, target).distanceM > MAX_GATE_DISTANCE_M / 2) {
      continue;
    }
    // Sama koha duplikaadist piisab ühest; märkide loomulikku sammu ei muuda.
    if (midpoints.length > 0 && distance(midpoint, midpoints.at(-1)!) < 20) continue;
    midpoints.push(midpoint);
    narrowestM = Math.min(narrowestM, widthM);
  }
  // Kui üks külg jätkub ühisosast kaugemale (nt Tilgu sissesõit kaardub
  // punaste poidega edasi pärast rohelise rivi lõppu), järgib keskjoon
  // seda serva sama poole-laiuse nihkega, mis kehtis viimases ühisjaamas.
  const boundaryT = stations.at(-1);
  if (boundaryT !== undefined && midpoints.length > 0) {
    const portAtBoundary = sideLineAt(ports, boundaryT);
    const starboardAtBoundary = sideLineAt(starboards, boundaryT);
    const centreAtBoundary: Position = [
      (portAtBoundary[0] + starboardAtBoundary[0]) / 2,
      (portAtBoundary[1] + starboardAtBoundary[1]) / 2,
    ];
    const offsetOf = (side: ChainEntry[]): Position => {
      const atBoundary = side === ports ? portAtBoundary : starboardAtBoundary;
      return [centreAtBoundary[0] - atBoundary[0], centreAtBoundary[1] - atBoundary[1]];
    };
    const tails = [
      ...ports.map((entry) => ({ entry, side: ports })),
      ...starboards.map((entry) => ({ entry, side: starboards })),
    ].filter(({ entry }) => entry.along > boundaryT + 1)
      .sort((a, b) => a.entry.along - b.entry.along);
    for (const { entry, side } of tails) {
      const offset = offsetOf(side);
      const midpoint: Position = [entry.position[0] + offset[0], entry.position[1] + offset[1]];
      if (target && distanceToSegment(midpoint, endpoint, target).distanceM > MAX_GATE_DISTANCE_M / 2) {
        continue;
      }
      if (distance(midpoint, midpoints.at(-1)!) < 20) continue;
      midpoints.push(midpoint);
    }
  }
  if (midpoints.length === 0) return null;

  return {
    midpoints,
    widthM: narrowestM,
    // Ka klastripuhastuses kõrvale jäänud märgid ääristavad sama kanalit
    // ega tohi selle lahtreid takistusena sulgeda.
    boundaryAidIds: [...rawPorts, ...rawStarboards].map((entry) => entry.aid.id),
  };
}

/**
 * Eemaldab ketist märgid, mis on eelmisega peaaegu samal telje-kõrgusel
 * (< 25 m): klastrist jääb vastasserva joonele lähim.
 */
function dedupeAbeam(chain: ChainEntry[], opposite: ChainEntry[]): ChainEntry[] {
  const result: ChainEntry[] = [];
  let group: ChainEntry[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const best = group.reduce((a, b) =>
      distance(b.position, sideLineAt(opposite, b.along))
        < distance(a.position, sideLineAt(opposite, a.along)) ? b : a);
    result.push(best);
    group = [];
  };
  for (const entry of chain) {
    if (group.length > 0 && entry.along - group.at(-1)!.along >= 25) flush();
    group.push(entry);
  }
  flush();
  return result;
}

/**
 * Külgjoone punkt telje-kõrgusel t: ketiotstest väljaspool hoiab viimast
 * märki (konstantne jätk), vahepeal interpoleerib naabermärkide vahel.
 */
function sideLineAt(chain: ChainEntry[], t: number): Position {
  const first = chain[0]!;
  if (t <= first.along) return first.position;
  const last = chain.at(-1)!;
  if (t >= last.along) return last.position;
  for (let index = 1; index < chain.length; index++) {
    const a = chain[index - 1]!;
    const b = chain[index]!;
    if (t > b.along) continue;
    const span = b.along - a.along;
    if (span <= 1e-6) return a.position;
    const ratio = (t - a.along) / span;
    return [
      a.position[0] + (b.position[0] - a.position[0]) * ratio,
      a.position[1] + (b.position[1] - a.position[1]) * ratio,
    ];
  }
  return last.position;
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
