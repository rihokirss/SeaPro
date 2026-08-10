import { describe, expect, it } from 'vitest';
import type { RoutingCell, GridPoint } from '../src/routing/engineTypes.js';
import type {
  RoutingCellDetails,
  RoutingCostSurface,
  RoutingVesselProfile,
} from '../src/routing/costSurface.js';
import { findCorridorBackboneRoute } from '../src/routing/corridorGraph.js';
import { buildPreparedRoutingGraph } from '../src/routing/preparedGraph.js';
import type { RoutingCorridor } from '../src/routing/sourceTypes.js';

const VESSEL: RoutingVesselProfile = {
  draughtM: 1.2,
  underKeelClearanceM: 0.5,
  beamM: 3.5,
  airDraughtM: 12,
};

describe('laevatee graafil põhinev routing', () => {
  it('säilitab põhimarsruudil ametliku keskjoone kuju', async () => {
    const surface = testSurface(40, 20);
    const corridor = lineCorridor('dogleg', [
      [5, 12], [5, 4], [29, 4], [29, 12],
    ]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([corridor]),
      vessel: VESSEL,
      start: { x: 1, y: 12 },
      end: { x: 34, y: 12 },
      maxConnectorDistanceM: 8_000,
      maxExpandedNodes: 10_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 5, y: 4 }));
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 29, y: 4 }));
    const path = attempt.route?.path ?? [];
    const graphStart = path.findIndex((point) => point.position !== undefined);
    const graphEnd = path.findLastIndex((point) => point.position !== undefined);
    expect(graphStart).toBeGreaterThanOrEqual(0);
    expect(path.slice(graphStart, graphEnd + 1).every((point) => point.position !== undefined))
      .toBe(true);
  });

  it('säilitab ka ühte võrerakku jäävad algallika pöörded täpsete koordinaatidena', async () => {
    const surface = testSurface(16, 12);
    const turns: Array<[number, number]> = [
      [5.1, 5.1],
      [5.2, 5.8],
      [5.3, 5.1],
    ];
    const corridor = lineCorridor('sub-cell-turns', [[3, 5], ...turns, [10, 5]]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([corridor]),
      vessel: VESSEL,
      start: { x: 1, y: 5 },
      end: { x: 13, y: 5 },
      maxConnectorDistanceM: 3_500,
      maxExpandedNodes: 10_000,
    });

    expect(attempt.route).not.toBeNull();
    for (const position of turns) {
      expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ position }));
      expect(attempt.route?.path).toContainEqual(expect.objectContaining({ position }));
    }
  });

  it('valib sisenemise ja väljumise väikseima ühise kogukulu järgi', async () => {
    const surface = testSurface(42, 18);
    const nearbyDetour = lineCorridor('nearby-detour', [
      [2, 10], [2, 2], [37, 2], [37, 10],
    ]);
    const economical = lineCorridor('economical', [[4, 7], [35, 7]]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([nearbyDetour, economical]),
      vessel: VESSEL,
      start: { x: 1, y: 10 },
      end: { x: 38, y: 10 },
      maxConnectorDistanceM: 10_000,
      maxExpandedNodes: 15_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.path.some((point) => point.y === 7 && point.x >= 4 && point.x <= 35))
      .toBe(true);
    expect(attempt.route?.path.some((point) => point.y === 2 && point.x > 2 && point.x < 37))
      .toBe(false);
  });

  it('eelistab pikale ametlikule ringile lühemat ohutut soovituslikku teed', async () => {
    const surface = testSurface(42, 18);
    const officialDetour = lineCorridor('official-detour', [
      [4, 7], [4, 3], [35, 3], [35, 7],
    ]);
    const recommended = {
      ...lineCorridor('recommended-shortcut', [[4, 7], [35, 7]]),
      kind: 'recommended' as const,
      official: false,
      source: 'openstreetmap-overpass',
    };

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([officialDetour, recommended]),
      vessel: VESSEL,
      start: { x: 1, y: 10 },
      end: { x: 38, y: 10 },
      maxConnectorDistanceM: 10_000,
      maxExpandedNodes: 15_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 4, y: 7 }));
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 35, y: 7 }));
    expect(attempt.route?.path.some((point) => point.y === 3 && point.x > 4 && point.x < 35))
      .toBe(false);
  });

  it('leiab keskjoonele ohutu ühenduse ümber blokeeritud ala', async () => {
    const blocked = new Set(Array.from({ length: 8 }, (_value, y) => `${6}:${y}`));
    const surface = testSurface(32, 15, blocked);
    const corridor = lineCorridor('main', [[10, 5], [25, 5]]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([corridor]),
      vessel: VESSEL,
      start: { x: 2, y: 5 },
      end: { x: 29, y: 5 },
      maxConnectorDistanceM: 12_000,
      maxExpandedNodes: 12_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.path.some((point) => point.y >= 8)).toBe(true);
    expect(attempt.route?.path.every((point) => !blocked.has(`${point.x}:${point.y}`))).toBe(true);
  });

  it('valib eraldiseisvate laevateevõrkude vahel lühema kogutee', async () => {
    const surface = testSurface(45, 18);
    const startNetwork = lineCorridor('start-local', [[2, 10], [6, 10]]);
    const endNetwork = lineCorridor('end-backbone', [
      [20, 10], [20, 3], [38, 3], [38, 10],
    ]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([startNetwork, endNetwork]),
      vessel: VESSEL,
      start: { x: 1, y: 10 },
      end: { x: 41, y: 10 },
      maxConnectorDistanceM: 5_000,
      maxExpandedNodes: 20_000,
    });

    expect(attempt.startCandidates).toBeGreaterThan(0);
    expect(attempt.endCandidates).toBeGreaterThan(0);
    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.path.some((point) => point.y === 3 && point.x > 20 && point.x < 38))
      .toBe(false);
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 2, y: 10 }));
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 38, y: 10 }));
  });

  it('jätab vahele lähtekoha väikese võrgu, kui see tekitaks sadamasse ringi', async () => {
    const surface = testSurface(48, 20);
    const localHarbourDetour = lineCorridor('local-harbour-detour', [
      [5, 3], [2, 10], [9, 3],
    ]);
    const destinationBackbone = lineCorridor('destination-backbone', [
      ...Array.from({ length: 24 }, (_, index): [number, number] => [20 + index, 10]),
      [43, 16],
    ]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([localHarbourDetour, destinationBackbone]),
      vessel: VESSEL,
      start: { x: 1, y: 10 },
      end: { x: 45, y: 10 },
      maxConnectorDistanceM: 5_000,
      maxExpandedNodes: 20_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.remoteSelection).toBe('end_network');
    expect(attempt.bothNetworksCost).toBeUndefined();
    expect(attempt.route?.path.some((point) => point.y === 3)).toBe(false);
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 41, y: 10 }));
    expect(attempt.route?.path.some((point) => point.y === 16)).toBe(false);
    expect(attempt.route?.protectedPoints).not.toContainEqual(expect.objectContaining({ x: 5, y: 3 }));
  });

  it('lõpetab ühenduse esimesel laevateel ega tee teise võrgu kaudu tagasipööret', async () => {
    const surface = testSurface(45, 20);
    const startNetwork = lineCorridor('start-network', [[2, 5], [35, 5]]);
    const endNetwork = lineCorridor('end-network', [[20, 7], [35, 7], [35, 10]]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([startNetwork, endNetwork]),
      vessel: VESSEL,
      start: { x: 1, y: 5 },
      end: { x: 35, y: 10 },
      maxConnectorDistanceM: 10_000,
      maxExpandedNodes: 20_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.endCandidates).toBe(1);
    expect(hasRepeatedPoint(attempt.route?.path ?? [])).toBe(false);
  });

  it('ei sunni kaugühendust enne sobivat sisemist sõlme terminali kaudu ringi', async () => {
    const surface = testSurface(35, 25);
    const endNetwork = lineCorridor('end-network', [
      [21, 5], [10, 5], [10, 18],
    ]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([endNetwork]),
      vessel: VESSEL,
      start: { x: 1, y: 5 },
      end: { x: 10, y: 20 },
      maxConnectorDistanceM: 5_000,
      maxExpandedNodes: 20_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.path.some((point) => point.x > 10)).toBe(false);
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 10, y: 18 }));
    expect(hasRepeatedPoint(attempt.route?.path ?? [])).toBe(false);
  });

  it('liitub kaugelt võrgu sisemise sõlmega ega tee terminali kaudu ringi', async () => {
    const surface = testSurface(45, 20);
    const endNetwork = lineCorridor('end-network', [
      [20, 2], [25, 10], [40, 10],
    ]);

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([endNetwork]),
      vessel: VESSEL,
      start: { x: 1, y: 10 },
      end: { x: 42, y: 10 },
      maxConnectorDistanceM: 5_000,
      maxExpandedNodes: 20_000,
    });

    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.path.some((point) => point.y === 2)).toBe(false);
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 25, y: 10 }));
    expect(hasRepeatedPoint(attempt.route?.path ?? [])).toBe(false);
  });

  it('kasutab tiheda võrgu terminali varuna, kui sisemised kontaktid on takistuse taga', async () => {
    const blocked = new Set(
      Array.from({ length: 80 }, (_value, y) => `20:${y}`),
    );
    const surface = testSurface(180, 80, blocked);
    const endNetwork = lineCorridor('dense-end-network', [
      [5, 5],
      [25, 5],
      [25, 70],
      ...Array.from({ length: 146 }, (_, index): [number, number] => [25 + index, 70]),
    ]);
    const denseEndContacts = Array.from({ length: 18 }, (_, index) => lineCorridor(
      `dense-end-contact-${index}`,
      [[170, 70], [170 + (index + 1) / 100, 70 + (index + 1) / 100]],
    ));

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([endNetwork, ...denseEndContacts]),
      vessel: VESSEL,
      start: { x: 5, y: 70 },
      end: { x: 175, y: 70 },
      maxConnectorDistanceM: 20_000,
      maxExpandedNodes: 60_000,
    });

    expect(attempt.startCandidates).toBe(0);
    expect(attempt.endCandidates).toBeGreaterThan(16);
    expect(attempt.route).not.toBeNull();
    expect(attempt.route?.protectedPoints).toContainEqual(expect.objectContaining({ x: 5, y: 5 }));
    expect(hasRepeatedPoint(attempt.route?.path ?? [])).toBe(false);
  });

  it('ei usalda väikelaeva piirist suurema aluse jaoks liiga madalat keskjoont', async () => {
    const surface = testSurface(30, 15);
    const corridor = {
      ...lineCorridor('shallow', [[5, 7], [25, 7]]),
      maxDraughtM: 1.5,
    };

    const attempt = await findCorridorBackboneRoute({
      surface,
      graph: testGraph([corridor]),
      vessel: { ...VESSEL, draughtM: 4, beamM: 12 },
      start: { x: 2, y: 7 },
      end: { x: 28, y: 7 },
      maxConnectorDistanceM: 8_000,
    });

    expect(attempt.route).toBeNull();
    expect(attempt.graphNodes).toBe(0);
  });

  it('kasutab sama ala järgmisel päringul valmis graafiprojektsiooni uuesti', async () => {
    const graph = testGraph([lineCorridor('cached', [[5, 7], [25, 7]])]);
    const firstBase = testSurface(30, 15);
    const secondBase = testSurface(30, 15);
    let firstProjectionCalls = 0;
    let secondProjectionCalls = 0;
    const firstSurface: RoutingCostSurface = {
      ...firstBase,
      toGrid(point) {
        firstProjectionCalls++;
        return firstBase.toGrid(point);
      },
    };
    const secondSurface: RoutingCostSurface = {
      ...secondBase,
      toGrid(point) {
        secondProjectionCalls++;
        return secondBase.toGrid(point);
      },
    };
    const options = {
      graph,
      vessel: VESSEL,
      start: { x: 2, y: 7 },
      end: { x: 28, y: 7 },
      maxConnectorDistanceM: 8_000,
      maxExpandedNodes: 10_000,
    };

    expect((await findCorridorBackboneRoute({ ...options, surface: firstSurface })).route)
      .not.toBeNull();
    expect((await findCorridorBackboneRoute({ ...options, surface: secondSurface })).route)
      .not.toBeNull();
    expect(firstProjectionCalls).toBeGreaterThan(0);
    expect(secondProjectionCalls).toBe(0);
  });
});

function lineCorridor(id: string, coordinates: Array<[number, number]>): RoutingCorridor {
  return {
    id,
    kind: 'fairway',
    geometryRole: 'centreline',
    geometry: { type: 'LineString', coordinates },
    official: true,
    source: 'vaylavirasto-wfs',
    fetchedAt: '2026-08-09T12:00:00.000Z',
    stale: false,
  };
}

function testGraph(corridors: RoutingCorridor[]) {
  return buildPreparedRoutingGraph(
    corridors,
    [0, 0, 25, 45],
    '2026-08-09T12:00:00.000Z',
    { maxEdgeLengthM: Number.POSITIVE_INFINITY },
  );
}

function hasRepeatedPoint(path: readonly GridPoint[]): boolean {
  const seen = new Set<string>();
  for (const point of path) {
    const key = `${point.x}:${point.y}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function testSurface(
  width: number,
  height: number,
  blocked = new Set<string>(),
): RoutingCostSurface {
  const clearCell: RoutingCell = Object.freeze({
    blocked: false,
    costMultiplier: 1,
    risk: 'clear',
    reasons: Object.freeze([]),
  });
  const blockedCell: RoutingCell = Object.freeze({
    blocked: true,
    costMultiplier: 1,
    risk: 'clear',
    reasons: Object.freeze(['land']),
  });
  const details = (x: number, y: number): RoutingCellDetails => ({
    blocked: blocked.has(`${x}:${y}`),
    costMultiplier: 1,
    risk: 'clear',
    reasons: blocked.has(`${x}:${y}`) ? ['land'] : [],
    sourceIds: [],
    depthM: blocked.has(`${x}:${y}`) ? null : 10,
  });
  return {
    width,
    height,
    minimumCostMultiplier: 0.55,
    requiredDepthM: VESSEL.draughtM + VESSEL.underKeelClearanceM,
    trustPublishedRoutes: true,
    projection: {
      bbox: [0, 0, height, width],
      width,
      height,
      cellSizeM: 1_000,
      lonStep: 1,
      latStep: 1,
      metresPerLongitudeDegree: 1_000,
    },
    cellAt(x, y) {
      return blocked.has(`${x}:${y}`) ? blockedCell : clearCell;
    },
    detailsAt: details,
    toGrid(point) {
      return { x: point.lon, y: point.lat };
    },
    toPosition(point: GridPoint) {
      return [point.x, point.y];
    },
  };
}
