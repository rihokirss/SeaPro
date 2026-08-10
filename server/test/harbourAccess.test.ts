import { describe, expect, it } from 'vitest';
import {
  buildHarbourAccessSupport,
  deriveHarbourAccess,
} from '../src/routing/harbourAccess.js';
import type {
  RoutingCorridor,
  RoutingHarbour,
  RoutingHazard,
  RoutingVectorData,
} from '../src/routing/sourceTypes.js';

const STAMP = {
  fetchedAt: '2026-08-08T12:00:00.000Z',
  stale: false,
} as const;

const tilgu: RoutingHarbour = {
  id: 'transpordiamet-his:harbour:381',
  kind: 'harbour',
  geometry: { type: 'Point', coordinates: [24.48758, 59.45568] },
  name: 'TILGU SADAM',
  maxDraughtM: 0.7,
  maxBeamM: 3,
  official: true,
  source: 'transpordiamet-his',
  ...STAMP,
};

const tilguAids: RoutingHazard[] = [
  aid('red', 'Tilgu sadama 2', 'lateral-port', [24.49019, 59.45528]),
  aid('green', 'Tilgu sadama 1', 'lateral-starboard', [24.48949, 59.45534]),
];

describe('harbour endpoint access corridors', () => {
  it('keeps only compact harbour access data for the prepared graph', () => {
    const nearbyFairway: RoutingCorridor = {
      id: 'fairway-near-tilgu',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: { type: 'LineString', coordinates: [[24.49, 59.456], [24.5, 59.457]] },
      sweptDepthM: 2,
      official: true,
      source: 'transpordiamet-his',
      ...STAMP,
    };
    const remoteFairway: RoutingCorridor = {
      ...nearbyFairway,
      id: 'remote-fairway',
      geometry: { type: 'LineString', coordinates: [[25, 60], [25.1, 60.1]] },
    };
    const rock: RoutingHazard = {
      id: 'nearby-rock',
      kind: 'rock',
      geometry: { type: 'Point', coordinates: [24.49, 59.456] },
      confidence: 'high',
      source: 'transpordiamet-his',
      ...STAMP,
    };

    const support = buildHarbourAccessSupport({
      harbours: [tilgu, tilgu],
      hazards: [...tilguAids, rock],
      corridors: [nearbyFairway, remoteFairway],
    });

    expect(support.harbours).toEqual([tilgu]);
    expect(support.hazards.map(({ id }) => id).sort()).toEqual(['green', 'red']);
    expect(support.corridors.map(({ id }) => id)).toEqual(['fairway-near-tilgu']);
  });

  it('routes a fitting vessel through the midpoint of an official lateral pair', () => {
    const result = deriveHarbourAccess(
      { lon: 24.48658, lat: 59.45518 },
      vessel({ draughtM: 0.5, underKeelClearanceM: 0.1, beamM: 2 }),
      vectors({ harbours: [tilgu], hazards: tilguAids }),
      'start',
    );

    expect(result.status).toBe('access');
    if (result.status !== 'access') throw new Error('Expected access');
    expect(result.access.waypoints).toHaveLength(3);
    expect(result.access.waypoints[1]).toEqual([
      (24.49019 + 24.48949) / 2,
      (59.45528 + 59.45534) / 2,
    ]);
    expect(result.access.corridor).toMatchObject({
      harbourAccess: true,
      maxDraughtM: 0.7,
      boundaryAidIds: ['red', 'green'],
      official: true,
    });
  });

  it('derives a monotonic centreline from unequal side lines', () => {
    // Märgid ei ole päriselt paaris: siin on kaks vasakut ja kaks paremat
    // eri kõrgustel. Keskjoon tuleb külgjoonte vahelt ja peab liikuma
    // sadamast monotoonselt mere poole, mitte siksakima.
    const hazards: RoutingHazard[] = [
      aid('p1', 'Tilgu sadama 4', 'lateral-port', [24.48950, 59.45520]),
      aid('s1', 'Tilgu sadama 3', 'lateral-starboard', [24.48950, 59.45560]),
      aid('p2', 'Tilgu sadama 6', 'lateral-port', [24.49030, 59.45515]),
      aid('s2', 'Tilgu sadama 5', 'lateral-starboard', [24.49120, 59.45590]),
    ];
    const result = deriveHarbourAccess(
      { lon: 24.48658, lat: 59.45518 },
      vessel({ draughtM: 0.5, underKeelClearanceM: 0.1, beamM: 2 }),
      vectors({ harbours: [tilgu], hazards }),
      'start',
    );

    expect(result.status).toBe('access');
    if (result.status !== 'access') throw new Error('Expected access');
    // Mõlema külje KÕIK märgid osalevad servajoontes.
    expect([...result.access.corridor.boundaryAidIds ?? []].sort()).toEqual(['p1', 'p2', 's1', 's2']);
    expect(result.access.waypoints.length).toBeGreaterThanOrEqual(3);
    // Kett liigub sadamapunktist ühtlaselt ida (mere) suunas.
    for (let index = 1; index < result.access.waypoints.length; index++) {
      expect(result.access.waypoints[index]![0]).toBeGreaterThan(result.access.waypoints[index - 1]![0]);
    }
  });

  it('does not override the published harbour draught limit', () => {
    const result = deriveHarbourAccess(
      { lon: 24.48658, lat: 59.45518 },
      vessel({ draughtM: 1.2 }),
      vectors({ harbours: [tilgu], hazards: tilguAids }),
      'start',
    );

    expect(result).toMatchObject({
      status: 'limit',
      reason: 'draught',
      limitM: 0.7,
    });
  });

  it('connects a mapped guest harbour to a nearby suitable official fairway', () => {
    const harbour: RoutingHarbour = {
      id: 'openstreetmap:harbour:node/15',
      kind: 'harbour',
      geometry: { type: 'Point', coordinates: [23.57064, 59.82943] },
      name: 'Jussarö vierassatama',
      official: false,
      source: 'openstreetmap-overpass',
      ...STAMP,
    };
    const fairway: RoutingCorridor = {
      id: 'vaylavirasto-wfs:fairway-area:158710',
      kind: 'fairway',
      geometryRole: 'area',
      geometry: { type: 'Polygon', coordinates: [[
        [23.563, 59.831], [23.575, 59.831], [23.575, 59.832],
        [23.563, 59.832], [23.563, 59.831],
      ]] },
      sweptDepthM: 4.5,
      maxDraughtM: 3.7,
      official: true,
      source: 'vaylavirasto-wfs',
      ...STAMP,
    };
    const centreline: RoutingCorridor = {
      id: 'vaylavirasto-wfs:navigation-line:143005',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: { type: 'LineString', coordinates: [
        [23.56317, 59.83182], [23.56526, 59.83171], [23.57008, 59.83146],
      ] },
      sweptDepthM: 4.5,
      maxDraughtM: 3.7,
      official: true,
      source: 'vaylavirasto-wfs',
      ...STAMP,
    };
    const result = deriveHarbourAccess(
      { lon: 23.57064, lat: 59.82943 },
      vessel(),
      vectors({ harbours: [harbour], corridors: [fairway, centreline] }),
      'end',
    );

    expect(result.status).toBe('access');
    if (result.status !== 'access') throw new Error('Expected access');
    expect(result.access.corridor).toMatchObject({
      source: 'vaylavirasto-wfs',
      sweptDepthM: 4.5,
      maxDraughtM: 3.7,
      harbourAccess: true,
    });
    expect(result.access.waypoints).toHaveLength(3);
    expect(result.access.waypoints[1]?.[0]).toBeCloseTo(23.57008, 4);
    expect(result.access.waypoints.at(-1)?.[0]).toBeCloseTo(23.56317, 4);
  });
});

function aid(
  id: string,
  name: string,
  navigationRole: 'lateral-port' | 'lateral-starboard',
  coordinates: [number, number],
): RoutingHazard {
  return {
    id,
    kind: 'physical_aid',
    geometry: { type: 'Point', coordinates },
    name,
    confidence: 'high',
    navigationRole,
    operational: true,
    source: 'transpordiamet-his',
    ...STAMP,
  };
}

function vessel(overrides: Partial<{
  draughtM: number;
  underKeelClearanceM: number;
  beamM: number;
  airDraughtM: number;
}> = {}) {
  return {
    draughtM: 1.2,
    underKeelClearanceM: 0.5,
    beamM: 3,
    airDraughtM: 4,
    ...overrides,
  };
}

function vectors(overrides: Partial<RoutingVectorData> = {}): RoutingVectorData {
  return {
    bbox: [59, 23, 60, 25],
    hazards: [],
    corridors: [],
    restrictions: [],
    warnings: [],
    surveyAreas: [],
    sources: [],
    ...overrides,
  };
}
