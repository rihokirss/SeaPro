import { describe, expect, it } from 'vitest';
import type { BBox, RoutePlanRequest, RoutePlanSegment, RoutePlanSource } from '@seapro/shared';
import { distanceMetres } from '@seapro/shared';
import {
  buildRoutingCostSurface,
  createRoutingProjection,
  type BuildRoutingCostSurfaceInput,
  type RoutingCostSurface,
} from '../src/routing/costSurface.js';
import { ROUTING_COST_MULTIPLIERS } from '../src/routing/engineTypes.js';
import { isWithinRoutingServiceArea } from '../src/routing/coverage.js';
import { RoutingDepthState, type RoutingDepthRaster } from '../src/routing/depthRaster.js';
import {
  buildPreparedRoutingGraph,
  nearestPreparedGraphTerminal,
} from '../src/routing/preparedGraph.js';
import {
  planRoute,
  fineRevalidateSegments,
  RoutingDataUnavailableError,
  RoutingPlanTimeoutError,
  snapRouteEndpoint,
  snapToReachableCell,
  type RoutingSnapshot,
} from '../src/routing/planner.js';
import { deriveHarbourAccess, type HarbourAccess } from '../src/routing/harbourAccess.js';
import type {
  RoutingCorridor,
  RoutingHarbour,
  RoutingHazard,
  RoutingSourceMeta,
  RoutingVectorData,
  RoutingWarning,
} from '../src/routing/sourceTypes.js';
import { routingWaterAt, type RoutingWaterMask } from '../src/routing/waterMask.js';

const BBOX: BBox = [59, 24, 59.012, 24.024];
const REFINEMENT_BBOX: BBox = [59, 24, 59.03, 24.08];
const SOURCE: RoutePlanSource = {
  id: 'test',
  fetchedAt: '2026-08-08T12:00:00.000Z',
  ageSeconds: 0,
  stale: false,
  coverage: 'complete',
};

describe('routing cost surface precedence', () => {
  it('ignores cancelled navigation marks as physical obstacles', () => {
    const aid = (id: string, operational: boolean | undefined): RoutingHazard => ({
      id,
      kind: 'physical_aid',
      geometry: { type: 'Point', coordinates: [24.012, 59.006] },
      name: 'Testtooder',
      confidence: 'high',
      navigationRole: 'other',
      ...(operational === undefined ? {} : { operational }),
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    });
    const active = detailsNear(surfaceFor({ hazards: [aid('aid', undefined)] }), 24.012, 59.006);
    expect(active.blocked).toBe(true);
    // Tühistatud märk (nt Naissaare sadama S tooder) ei ole enam vees.
    const cancelled = detailsNear(surfaceFor({ hazards: [aid('aid', false)] }), 24.012, 59.006);
    expect(cancelled.blocked).toBe(false);
  });

  it('allows unknown water with a high cost instead of calling it safe', () => {
    const surface = surfaceFor({ depthState: RoutingDepthState.NoData });
    const cell = detailsNear(surface, 24.012, 59.006);
    expect(cell.blocked).toBe(false);
    expect(cell.risk).toBe('unknown');
    expect(cell.costMultiplier).toBe(25);
    expect(cell.reasons).toContain('depth_unknown');
  });

  it('reuses immutable cell descriptions during repeated pathfinding reads', () => {
    const surface = surfaceFor({ depthState: RoutingDepthState.NoData });
    const coordinate = surface.toGrid({ lon: 24.012, lat: 59.006 });
    const x = Math.max(0, Math.min(surface.width - 1, Math.round(coordinate.x)));
    const y = Math.max(0, Math.min(surface.height - 1, Math.round(coordinate.y)));
    const first = surface.cellAt(x, y);
    const second = surface.cellAt(x, y);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.reasons).toContain('depth_unknown');
    expect(Object.isFrozen(first.reasons)).toBe(true);
  });

  it('lets a bounded suitable official fairway override generalised shallow depth', () => {
    const corridor: RoutingCorridor = {
      id: 'official-fairway',
      kind: 'fairway',
      geometryRole: 'area',
      geometry: areaAround(24.012, 59.006),
      depthM: 4,
      maxDraughtM: 2.5,
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const surface = surfaceFor({ depthM: 0.5, corridors: [corridor] });
    const cell = detailsNear(surface, 24.012, 59.006);
    expect(cell.blocked).toBe(false);
    expect(cell.costMultiplier).toBeCloseTo(ROUTING_COST_MULTIPLIERS.preferred, 1);
    expect(cell.reasons).toContain('official_corridor');
    expect(cell.reasons).not.toContain('known_shallow');
  });

  it('never lets an OpenSeaMap recommendation area override known shallow water', () => {
    const corridor: RoutingCorridor = {
      id: 'osm-recommendation',
      kind: 'recommended',
      geometryRole: 'area',
      geometry: areaAround(24.012, 59.006),
      official: false,
      source: 'openstreetmap-overpass',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const surface = surfaceFor({ depthM: 0.5, corridors: [corridor] });
    const cell = detailsNear(surface, 24.012, 59.006);
    expect(cell.blocked).toBe(true);
    expect(cell.reasons).toContain('known_shallow');
    expect(cell.reasons).not.toContain('recommended_route');
  });

  it('trusts a published recommendation centreline for a small craft', () => {
    const corridor: RoutingCorridor = {
      id: 'osm-recommendation-line',
      kind: 'recommended',
      geometryRole: 'centreline',
      geometry: {
        type: 'LineString',
        coordinates: [[24.005, 59.006], [24.019, 59.006]],
      },
      official: false,
      source: 'openstreetmap-overpass',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const surface = surfaceFor({ depthM: 0.5, corridors: [corridor] });
    const cell = detailsNear(surface, 24.012, 59.006);
    expect(cell.blocked).toBe(false);
    expect(cell.costMultiplier).toBeCloseTo(ROUTING_COST_MULTIPLIERS.preferred, 1);
    expect(cell.reasons).toContain('recommended_route');
    expect(cell.reasons).not.toContain('known_shallow');
  });

  it('does not use a design draught that is smaller than draught plus requested UKC', () => {
    const corridor: RoutingCorridor = {
      id: 'design-draught-too-small',
      kind: 'fairway',
      geometryRole: 'area',
      geometry: areaAround(24.012, 59.006),
      maxDraughtM: 1.5,
      official: true,
      source: 'vaylavirasto-wfs',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const cell = detailsNear(surfaceFor({ depthM: 0.5, corridors: [corridor] }), 24.012, 59.006);
    expect(cell.blocked).toBe(true);
    expect(cell.reasons).toContain('known_shallow');
  });

  it('applies a rock buffer after a fairway override', () => {
    const corridor: RoutingCorridor = {
      id: 'official-fairway',
      kind: 'fairway',
      geometryRole: 'area',
      geometry: areaAround(24.012, 59.006),
      depthM: 4,
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const rock: RoutingHazard = {
      id: 'rock',
      kind: 'rock',
      geometry: { type: 'Point', coordinates: [24.012, 59.006] },
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const surface = surfaceFor({ depthM: 0.5, corridors: [corridor], hazards: [rock] });
    const cell = detailsNear(surface, 24.012, 59.006);
    expect(cell.blocked).toBe(true);
    expect(cell.reasons).toContain('hazard');
  });

  it('blocks a narrow island seen by a corner sample even when the cell centre is water', () => {
    const projection = createRoutingProjection(BBOX, 10_000, 40);
    const coordinate = {
      x: Math.round((24.012 - BBOX[1]) / projection.lonStep - 0.5),
      y: Math.round((BBOX[2] - 59.006) / projection.latStep - 0.5),
    };
    const centre = positionForProjection(projection, coordinate.x, coordinate.y);
    const corner = positionForProjection(projection, coordinate.x + 0.49, coordinate.y + 0.49);
    const epsilon = 0.00002;
    const mask = waterMask([[ ...globalWaterRing() ], [
      [corner[0] - epsilon, corner[1] - epsilon],
      [corner[0] + epsilon, corner[1] - epsilon],
      [corner[0] + epsilon, corner[1] + epsilon],
      [corner[0] - epsilon, corner[1] + epsilon],
      [corner[0] - epsilon, corner[1] - epsilon],
    ]]);
    const surface = surfaceFor({ depthM: 8, water: mask });

    expect(routingWaterAt(mask, centre[0], centre[1])).toBe(true);
    expect(detailsNear(surface, centre[0], centre[1]).blocked).toBe(true);
  });

  it('does not let an official depth clear a cell that straddles the published boundary', () => {
    const corridor: RoutingCorridor = {
      id: 'tiny-official-area',
      kind: 'fairway',
      geometryRole: 'area',
      geometry: areaAround(24.012, 59.006, 0.00003),
      depthM: 4,
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const cell = detailsNear(surfaceFor({ depthM: 0.5, corridors: [corridor] }), 24.012, 59.006);
    expect(cell.blocked).toBe(true);
    expect(cell.reasons).toContain('known_shallow');
  });

  it('uses a narrow derived harbour access without treating its boundary buoys as obstacles', () => {
    const boundaryAid: RoutingHazard = {
      id: 'gate-red',
      kind: 'physical_aid',
      geometry: { type: 'Point', coordinates: [24.012, 59.006] },
      confidence: 'high',
      navigationRole: 'lateral-port',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const corridor: RoutingCorridor = {
      id: 'harbour-access',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: { type: 'LineString', coordinates: [[24.010, 59.006], [24.014, 59.006]] },
      sweptDepthM: 4,
      maxDraughtM: 2,
      widthM: 20,
      official: true,
      harbourAccess: true,
      boundaryAidIds: ['gate-red'],
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const cell = detailsNear(surfaceFor({
      depthM: 0.5,
      corridors: [corridor],
      hazards: [boundaryAid],
    }), 24.012, 59.006);

    expect(cell.blocked).toBe(false);
    expect(cell.risk).toBe('caution');
    expect(cell.reasons).toContain('harbour_access');
    expect(cell.reasons).not.toContain('known_shallow');
    expect(cell.reasons).not.toContain('hazard');
  });

  it('keeps a harbour centreline open when only the coarse cell edge touches land or a distant rock', () => {
    const projection = createRoutingProjection(BBOX, 10_000, 40);
    const coordinate = {
      x: Math.round((24.012 - BBOX[1]) / projection.lonStep - 0.5),
      y: Math.round((BBOX[2] - 59.006) / projection.latStep - 0.5),
    };
    const centre = positionForProjection(projection, coordinate.x, coordinate.y);
    const corner = positionForProjection(projection, coordinate.x + 0.49, coordinate.y + 0.49);
    const epsilon = 0.00002;
    const mask = waterMask([[...globalWaterRing()], [
      [corner[0] - epsilon, corner[1] - epsilon],
      [corner[0] + epsilon, corner[1] - epsilon],
      [corner[0] + epsilon, corner[1] + epsilon],
      [corner[0] - epsilon, corner[1] + epsilon],
      [corner[0] - epsilon, corner[1] - epsilon],
    ]]);
    const corridor: RoutingCorridor = {
      id: 'harbour-access',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: {
        type: 'LineString',
        coordinates: [[centre[0] - 0.002, centre[1]], [centre[0] + 0.002, centre[1]]],
      },
      maxDraughtM: 2,
      widthM: 20,
      official: true,
      harbourAccess: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const rock: RoutingHazard = {
      id: 'nearby-rock',
      kind: 'rock',
      geometry: { type: 'Point', coordinates: [centre[0], centre[1] - 0.0005] },
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const cell = surfaceFor({
      depthM: 0.5,
      corridors: [corridor],
      hazards: [rock],
      water: mask,
      positionOverrides: [centre],
    }).detailsAt(coordinate.x, coordinate.y);

    expect(cell.blocked).toBe(false);
    expect(cell.reasons).toContain('harbour_access');
    expect(cell.reasons).not.toContain('land');
    expect(cell.reasons).not.toContain('known_shallow');
    expect(cell.reasons).not.toContain('hazard');
  });

  it('shows a caution navigation warning without routing around it', () => {
    const warning: RoutingWarning = {
      id: 'information-line',
      kind: 'navigation_warning',
      geometry: { type: 'LineString', coordinates: [[24.010, 59.006], [24.014, 59.006]] },
      severity: 'caution',
      source: 'transpordiamet-warnings',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const cell = detailsNear(surfaceFor({ depthM: 8, warnings: [warning] }), 24.012, 59.006);

    expect(cell.blocked).toBe(false);
    expect(cell.costMultiplier).toBe(1);
    expect(cell.risk).toBe('caution');
    expect(cell.reasons).toContain('navigation_warning');
  });

  it('keeps TSS traversal advisory until local travel direction is part of search state', () => {
    const lane: RoutingCorridor = {
      id: 'one-way-lane',
      kind: 'traffic_lane',
      geometryRole: 'area',
      geometry: areaAround(24.012, 59.006),
      direction: 'one_way',
      directionDegrees: 90,
      official: false,
      source: 'openstreetmap-overpass',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const cell = detailsNear(surfaceFor({ depthM: 8, corridors: [lane] }), 24.012, 59.006);
    expect(cell.risk).toBe('caution');
    expect(cell.costMultiplier).toBe(50);
    expect(cell.reasons).toContain('traffic_direction_unverified');
  });
});

describe('routing service coverage', () => {
  it('includes Tallinn and Helsinki but excludes Stockholm and Riga', () => {
    expect(isWithinRoutingServiceArea({ lon: 24.75, lat: 59.44 })).toBe(true);
    expect(isWithinRoutingServiceArea({ lon: 24.94, lat: 60.17 })).toBe(true);
    expect(isWithinRoutingServiceArea({ lon: 18.07, lat: 59.33 })).toBe(false);
    expect(isWithinRoutingServiceArea({ lon: 24.10, lat: 56.95 })).toBe(false);
  });
});

describe('route planner snapshot integration', () => {
  it('snaps an endpoint out of an isolated coastal cell into the route component', () => {
    const surface = disconnectedSurface();
    const snapped = snapToReachableCell(
      surface,
      { lon: 0.00002, lat: 0.00002 },
      { x: 0, y: 2 },
    );

    expect(snapped?.point).not.toEqual({ x: 2, y: 2 });
    expect(snapped?.point).toEqual({ x: 2, y: 0 });
  });

  it('snaps a blocked harbour endpoint to its access line instead of arbitrary nearby water', () => {
    const requested = { lat: 59.003, lon: 24.003 };
    const gate: [number, number] = [24.006, 59.003];
    const rock: RoutingHazard = {
      id: 'blocked-harbour-centre',
      kind: 'rock',
      geometry: { type: 'Point', coordinates: [requested.lon, requested.lat] },
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const access: HarbourAccess = {
      harbour: {
        id: 'test-harbour',
        geometry: { type: 'Point', coordinates: [requested.lon, requested.lat] },
        maxDraughtM: 2,
        source: 'transpordiamet-his',
        fetchedAt: SOURCE.fetchedAt,
        stale: false,
      },
      corridor: {
        id: 'test-harbour-access',
        kind: 'fairway',
        geometryRole: 'centreline',
        geometry: {
          type: 'LineString',
          coordinates: [[requested.lon, requested.lat], gate],
        },
        widthM: 20,
        maxDraughtM: 2,
        official: true,
        harbourAccess: true,
        source: 'transpordiamet-his',
        fetchedAt: SOURCE.fetchedAt,
        stale: false,
      },
      waypoints: [[requested.lon, requested.lat], gate],
    };
    const surface = surfaceFor({
      depthM: 8,
      hazards: [rock],
      corridors: [access.corridor],
      positionOverrides: access.waypoints,
    });

    const snapped = snapRouteEndpoint(surface, requested, access);
    const gateGrid = surface.toGrid({ lon: gate[0], lat: gate[1] });

    expect(snapped?.point).toEqual({ x: Math.round(gateGrid.x), y: Math.round(gateGrid.y) });
    expect(snapped?.position).toEqual(gate);
  });

  it('uses a nearby prepared graph terminal as the final harbour entrance', () => {
    const graph = buildPreparedRoutingGraph([{
      id: 'harbour-terminal',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: {
        type: 'LineString',
        coordinates: [[24.003, 59.003], [24.0107, 59.0073]],
      },
      official: true,
      source: 'vaylavirasto-wfs',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    }], BBOX, SOURCE.fetchedAt);
    const endpoint = { lat: 59.0073, lon: 24.0109 };

    const terminal = nearestPreparedGraphTerminal(endpoint, graph);

    expect(terminal).toEqual([24.0107, 59.0073]);
  });

  it('keeps the resolved endpoint after overlaying an exact prepared backbone', async () => {
    const request: RoutePlanRequest = {
      ...routeRequest(),
      draughtM: 0.7,
      underKeelClearanceM: 0,
      beamM: 2.5,
    };
    const terminal: [number, number] = [request.end.lon - 0.0002, request.end.lat];
    const corridor: RoutingCorridor = {
      id: 'prepared-terminal-overlay',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: {
        type: 'LineString',
        coordinates: [[request.start.lon, request.start.lat], terminal],
      },
      official: true,
      source: 'vaylavirasto-wfs',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };

    const result = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, corridors: [corridor] }),
      bbox: BBOX,
    });

    expect(result.status).not.toBe('no_route');
    if (result.status === 'no_route') throw new Error('Expected prepared terminal route');
    expect(result.geometry.coordinates.at(-1)).toEqual([request.end.lon, request.end.lat]);
    expect(result.endpoints.end.distanceM).toBe(0);
  });

  it('returns a revalidated route and navigation waypoints on known water', async () => {
    const request = routeRequest();
    const snapshot = snapshotFor({ depthM: 8 });
    const result = await planRoute(request, { snapshot, bbox: BBOX });
    expect(result.status).toBe('route');
    if (result.status === 'no_route') throw new Error('Expected route');
    expect(result.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    expect(result.navigationWaypoints.length).toBeGreaterThanOrEqual(2);
    expect(result.navigationWaypoints.length).toBeLessThanOrEqual(100);
    expect(result.segments.every((segment) => segment.assessment === 'clear')).toBe(true);
    expect(result.distanceNm).toBeGreaterThan(0);
  });

  it('uses the original vector turn of a centreline route', async () => {
    const request = routeRequest();
    const corridor: RoutingCorridor = {
      id: 'official-dogleg',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [24.003, 59.003],
          [24.0107, 59.0073],
          [24.021, 59.009],
        ],
      },
      official: true,
      source: 'vaylavirasto-wfs',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const phases: Array<{ name: string; meta?: Record<string, number> }> = [];

    const result = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, corridors: [corridor] }),
      bbox: BBOX,
      instrumentation: { phase: (name, _ms, meta) => phases.push({ name, meta }) },
    });

    expect(result.status).not.toBe('no_route');
    if (result.status === 'no_route') throw new Error('Expected corridor-backed route');
    expect(phases).toContainEqual(expect.objectContaining({
      name: 'corridor_graph',
      meta: expect.objectContaining({ used: 1 }),
    }));
    expect(result.geometry.coordinates).toContainEqual([24.0107, 59.0073]);
    expect(result.navigationWaypoints).toContainEqual(expect.objectContaining({
      lon: 24.0107,
      lat: 59.0073,
    }));
    expect(result.segments.some((segment) => segment.reasons.includes('official_corridor')))
      .toBe(true);
  });

  it('keeps a straight graph intersection virtual instead of emitting a navigation point', async () => {
    const request = routeRequest();
    const intersection: [number, number] = [24.012, 59.006001];
    const main: RoutingCorridor = {
      id: 'straight-main',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [request.start.lon, request.start.lat],
          intersection,
          [request.end.lon, request.end.lat],
        ],
      },
      official: true,
      source: 'vaylavirasto-wfs',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const crossing: RoutingCorridor = {
      ...main,
      id: 'crossing-branch',
      geometry: {
        type: 'LineString',
        coordinates: [[24.012, 59.002], intersection, [24.012, 59.01]],
      },
    };

    const result = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, corridors: [main, crossing] }),
      bbox: BBOX,
    });

    expect(result.status).not.toBe('no_route');
    if (result.status === 'no_route') throw new Error('Expected straight intersection route');
    expect(result.geometry.coordinates).toContainEqual(intersection);
    expect(result.navigationWaypoints).not.toContainEqual(expect.objectContaining({
      lon: intersection[0],
      lat: intersection[1],
    }));
  });

  it('keeps dense vector geometry exact but emits only meaningful navigation turns', async () => {
    const request = routeRequest();
    const coordinates: Array<[number, number]> = Array.from({ length: 101 }, (_, index) => {
      const ratio = index / 100;
      return [
        request.start.lon + (request.end.lon - request.start.lon) * ratio,
        request.start.lat + (request.end.lat - request.start.lat) * ratio
          + Math.sin(ratio * Math.PI * 2) * 0.0008,
      ];
    });
    const corridor: RoutingCorridor = {
      id: 'dense-curve',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: { type: 'LineString', coordinates },
      official: true,
      source: 'vaylavirasto-wfs',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };

    const result = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, corridors: [corridor] }),
      bbox: BBOX,
    });

    expect(result.status).not.toBe('no_route');
    if (result.status === 'no_route') throw new Error('Expected dense vector route');
    expect(result.geometry.coordinates.length).toBeGreaterThanOrEqual(100);
    expect(result.navigationWaypoints.length).toBeLessThan(20);
    expect(result.navigationWaypoints[0]?.name).toBe('A');
    expect(result.navigationWaypoints.at(-1)?.name).toBe('B');
  });

  it('uses prepared harbour support when the fast-path vector snapshot is empty', async () => {
    const request: RoutePlanRequest = {
      ...routeRequest(),
      draughtM: 0.7,
      underKeelClearanceM: 0,
      beamM: 2.5,
    };
    const harbour: RoutingHarbour = {
      id: 'transpordiamet-his:harbour:test',
      kind: 'harbour',
      geometry: { type: 'Point', coordinates: [request.start.lon, request.start.lat] },
      name: 'Test sadam',
      maxDraughtM: 1,
      maxBeamM: 4,
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const aids: RoutingHazard[] = [
      {
        id: 'test-port',
        kind: 'physical_aid',
        geometry: { type: 'Point', coordinates: [24.006, 59.0028] },
        name: 'Test 2',
        confidence: 'high',
        navigationRole: 'lateral-port',
        source: 'transpordiamet-his',
        fetchedAt: SOURCE.fetchedAt,
        stale: false,
      },
      {
        id: 'test-starboard',
        kind: 'physical_aid',
        geometry: { type: 'Point', coordinates: [24.006, 59.0032] },
        name: 'Test 1',
        confidence: 'high',
        navigationRole: 'lateral-starboard',
        source: 'transpordiamet-his',
        fetchedAt: SOURCE.fetchedAt,
        stale: false,
      },
    ];
    const centreline: RoutingCorridor = {
      id: 'prepared-main-line',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: { type: 'LineString', coordinates: [[24.006, 59.003], [24.021, 59.009]] },
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const snapshot = snapshotFor({ depthM: 8 });
    const harbourAccessSupport = { harbours: [harbour], hazards: aids, corridors: [] };
    snapshot.preparedGraph = buildPreparedRoutingGraph([centreline], BBOX, SOURCE.fetchedAt, {
      harbourAccessSupport,
    });
    const derived = deriveHarbourAccess(
      request.start,
      request,
      vectorData({ harbours: [harbour], hazards: aids }),
      'start',
    );
    expect(derived.status).toBe('access');
    if (derived.status !== 'access') throw new Error('Expected derived harbour access');

    const result = await planRoute(request, { snapshot, bbox: BBOX });

    expect(result.status).not.toBe('no_route');
    if (result.status === 'no_route') throw new Error('Expected prepared harbour access route');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'harbour_access_inferred' }));
    const gateIndex = result.geometry.coordinates.findIndex(([lon, lat]) =>
      Math.abs(lon - 24.006) < 0.0001 && Math.abs(lat - 59.003) < 0.0001);
    expect(gateIndex).toBeGreaterThan(0);
    const outer = derived.access.waypoints.at(-1)!;
    const outerIndex = result.geometry.coordinates.findIndex(([lon, lat]) =>
      Math.abs(lon - outer[0]) < 1e-10 && Math.abs(lat - outer[1]) < 1e-10);
    expect(outerIndex).toBeGreaterThan(0);
    expect(result.geometry.coordinates.slice(0, outerIndex + 1))
      .toEqual(derived.access.waypoints);
    expect(result.geometry.coordinates[0]).toEqual([request.start.lon, request.start.lat]);
    expect(result.geometry.coordinates.at(-1)).toEqual([request.end.lon, request.end.lat]);
  });

  it('retries a resolution-sensitive no_route on a strict two-times-finer grid', async () => {
    const gapRow = 30;
    const snapshot = refinementSnapshot({ barrierColumns: [80], gapRows: [gapRow] });
    const gapLat = rasterRowLatitude(REFINEMENT_BBOX, 60, gapRow);
    const request: RoutePlanRequest = {
      ...routeRequest(),
      start: { lat: gapLat, lon: 24.005 },
      end: { lat: gapLat, lon: 24.075 },
    };
    const phases: string[] = [];

    const result = await planRoute(request, {
      snapshot,
      bbox: REFINEMENT_BBOX,
      instrumentation: { phase: (name) => phases.push(name) },
    });

    expect(result.status).not.toBe('no_route');
    if (result.status === 'no_route') throw new Error('Expected the refined grid to find the narrow opening');
    expect(phases).toContain('refinement_probe');
    expect(phases).toContain('refinement.cost_surface');
    expect(result.segments.every((segment) => segment.minDepthM === null || segment.minDepthM >= 1.7)).toBe(true);
  });

  it('does not build a fine grid when the optimistic probe cannot cross a solid shallow barrier', async () => {
    const snapshot = refinementSnapshot({
      barrierColumns: Array.from({ length: 10 }, (_, index) => 75 + index),
    });
    const request: RoutePlanRequest = {
      ...routeRequest(),
      start: { lat: 59.015, lon: 24.005 },
      end: { lat: 59.015, lon: 24.075 },
    };
    const phases: string[] = [];

    const result = await planRoute(request, {
      snapshot,
      bbox: REFINEMENT_BBOX,
      instrumentation: { phase: (name) => phases.push(name) },
    });

    expect(result.status).toBe('no_route');
    expect(phases).toContain('refinement_probe');
    expect(phases).not.toContain('refinement.cost_surface');
  });

  it('never opens a hard vector hazard in the refinement probe', async () => {
    const wall: RoutingHazard = {
      id: 'solid-vector-wall',
      kind: 'obstruction',
      geometry: { type: 'LineString', coordinates: [[24.04, 59], [24.04, 59.03]] },
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const snapshot = refinementSnapshot({ barrierColumns: [] });
    snapshot.vectors = vectorData({ hazards: [wall] });
    const request: RoutePlanRequest = {
      ...routeRequest(),
      start: { lat: 59.015, lon: 24.005 },
      end: { lat: 59.015, lon: 24.075 },
    };
    const phases: string[] = [];

    const result = await planRoute(request, {
      snapshot,
      bbox: REFINEMENT_BBOX,
      instrumentation: { phase: (name) => phases.push(name) },
    });

    expect(result.status).toBe('no_route');
    expect(phases).toContain('refinement_probe');
    expect(phases).not.toContain('refinement.cost_surface');
  });

  it('does not add refinement work to a successful primary route', async () => {
    const phases: string[] = [];
    const result = await planRoute(routeRequest(), {
      snapshot: snapshotFor({ depthM: 8 }),
      bbox: BBOX,
      instrumentation: { phase: (name) => phases.push(name) },
    });

    expect(result.status).toBe('route');
    expect(phases).not.toContain('refinement_probe');
    expect(phases.some((name) => name.startsWith('refinement.'))).toBe(false);
  });

  it('reports a harbour registry limit as a warning instead of blocking the route', async () => {
    const request = routeRequest();
    const harbour: RoutingHarbour = {
      id: 'transpordiamet-his:harbour:test',
      kind: 'harbour',
      geometry: { type: 'Point', coordinates: [request.end.lon, request.end.lat] },
      name: 'Testisadam',
      maxDraughtM: 0.7,
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const result = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, harbours: [harbour] }),
      bbox: BBOX,
    });
    expect(result.status).toBe('advisory');
    if (result.status === 'no_route') throw new Error('Expected advisory');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'harbour_draught_limit',
      severity: 'critical',
      details: expect.objectContaining({ endpoint: 'end', limitM: 0.7, actualM: 1.2 }),
    }));
    // Registripiirang ei ava sadamakanalit: tuletatud ligipääsu ei ole.
    expect(result.issues.some((issue) => issue.code === 'harbour_access_inferred')).toBe(false);
    // Sügav vesi otspunktis: tavaline kleepimine, mitte kaugele nihutamine.
    expect(result.endpoints.end.distanceM).toBeLessThan(100);
  });

  it('drops a derived harbour access with a blocked gate instead of failing the route', async () => {
    const request = routeRequest();
    const harbour: RoutingHarbour = {
      id: 'transpordiamet-his:harbour:test',
      kind: 'harbour',
      geometry: { type: 'Point', coordinates: [request.end.lon, request.end.lat] },
      name: 'Testisadam',
      maxDraughtM: 3,
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const gateAid = (id: string, lon: number, role: 'lateral-port' | 'lateral-starboard'): RoutingHazard => ({
      id,
      kind: 'physical_aid',
      geometry: { type: 'Point', coordinates: [lon, 59.0088] },
      name: `Testisadam ${role === 'lateral-port' ? '2' : '1'}`,
      confidence: 'high',
      navigationRole: role,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    });
    // Võõras kivi täpselt väravakeskmes blokeerib tuletatud kanali tugipunkti.
    const rock: RoutingHazard = {
      id: 'rock-at-gate',
      kind: 'rock',
      geometry: { type: 'Point', coordinates: [24.021, 59.0088] },
      name: 'Kivi',
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const result = await planRoute(request, {
      snapshot: snapshotFor({
        depthM: 8,
        harbours: [harbour],
        hazards: [gateAid('aid-port', 24.0205, 'lateral-port'), gateAid('aid-starboard', 24.0215, 'lateral-starboard'), rock],
      }),
      bbox: BBOX,
    });
    expect(result.status).toBe('advisory');
    if (result.status === 'no_route') throw new Error('Expected a route');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'harbour_access_not_navigable',
      severity: 'warning',
      details: expect.objectContaining({ endpoint: 'end' }),
    }));
    expect(result.issues.some((issue) => issue.code === 'harbour_access_inferred')).toBe(false);
  });

  it('keeps the harbour limit issue in a no_route response for context', async () => {
    const request = routeRequest();
    const harbour: RoutingHarbour = {
      id: 'transpordiamet-his:harbour:test',
      kind: 'harbour',
      geometry: { type: 'Point', coordinates: [request.end.lon, request.end.lat] },
      name: 'Testisadam',
      maxDraughtM: 0.7,
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const result = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 0.5, harbours: [harbour] }),
      bbox: BBOX,
    });
    expect(result.status).toBe('no_route');
    if (result.status !== 'no_route') throw new Error('Expected no_route');
    expect(result.issues.some((issue) => issue.code === 'harbour_draught_limit')).toBe(true);
    expect(result.issues.some((issue) => issue.code !== 'harbour_draught_limit'
      && issue.severity === 'critical')).toBe(true);
  });

  it('returns an advisory and explicit unknown segments when depth is absent', async () => {
    const result = await planRoute(routeRequest(), {
      snapshot: snapshotFor({ depthState: RoutingDepthState.NoData }),
      bbox: BBOX,
    });
    expect(result.status).toBe('advisory');
    if (result.status === 'no_route') throw new Error('Expected advisory');
    expect(result.segments.some((segment) => segment.assessment === 'unknown')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'depth_unknown')).toBe(true);
  });

  it('keeps a narrow unknown stripe separate from clear parts of a simplified route', async () => {
    const snapshot = snapshotFor({ depthM: 8 });
    const stripeX = Math.floor(snapshot.depth.width / 2);
    for (let y = 0; y < snapshot.depth.height; y++) {
      const index = y * snapshot.depth.width + stripeX;
      snapshot.depth.states[index] = RoutingDepthState.NoData;
      snapshot.depth.depths[index] = Number.NaN;
    }
    const result = await planRoute(routeRequest(), { snapshot, bbox: BBOX });
    expect(result.status).toBe('advisory');
    if (result.status === 'no_route') throw new Error('Expected advisory');
    const assessments = result.segments.map((segment) => segment.assessment);
    expect(assessments[0]).toBe('clear');
    expect(assessments).toContain('unknown');
    expect(assessments.at(-1)).toBe('clear');
    expect(result.geometry.coordinates.length).toBeGreaterThanOrEqual(result.segments.length + 1);
    const unknownDistanceM = result.segments
      .filter((segment) => segment.assessment === 'unknown')
      .reduce((sum, segment) => sum + distanceMetres(
        { lon: segment.from[0], lat: segment.from[1] },
        { lon: segment.to[0], lat: segment.to[1] },
      ), 0);
    expect(unknownDistanceM).toBeGreaterThan(0);
    expect(unknownDistanceM).toBeLessThan(result.distanceNm * 1_852);
  });

  it('fails closed when the complete water-mask base layer is unavailable', async () => {
    const snapshot = snapshotFor({ depthM: 8 });
    snapshot.water.source = { ...snapshot.water.source, coverage: 'missing' };
    await expect(planRoute(routeRequest(), { snapshot, bbox: BBOX }))
      .rejects.toBeInstanceOf(RoutingDataUnavailableError);
  });

  it('makes a route advisory when an endpoint is snapped by more than 50 metres', async () => {
    const request = routeRequest();
    const rock: RoutingHazard = {
      id: 'start-rock',
      kind: 'rock',
      geometry: { type: 'Point', coordinates: [request.start.lon, request.start.lat] },
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const result = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, hazards: [rock] }),
      bbox: BBOX,
    });
    expect(result.status).toBe('advisory');
    if (result.status === 'no_route') throw new Error('Expected advisory');
    expect(result.endpoints.start.distanceM).toBeGreaterThan(50);
    expect(result.endpoints.start.distanceM).toBeLessThanOrEqual(1_852);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'start_snapped',
      severity: 'warning',
    }));
  });

  it('includes departure time and vector feature IDs in the snapshot identity', async () => {
    const request = routeRequest();
    const hazard = (id: string): RoutingHazard => ({
      id,
      kind: 'rock',
      // Väljaspool testiala: ID muutub, kuid oht ei muuda leitud geomeetriat.
      geometry: { type: 'Point', coordinates: [25, 60] },
      depthM: 20,
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    });
    const first = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, hazards: [hazard('a')] }),
      bbox: BBOX,
    });
    const later = await planRoute({ ...request, departureTime: '2026-08-08T13:00:00.000Z' }, {
      snapshot: snapshotFor({ depthM: 8, hazards: [hazard('a')] }),
      bbox: BBOX,
    });
    const changedFeature = await planRoute(request, {
      snapshot: snapshotFor({ depthM: 8, hazards: [hazard('b')] }),
      bbox: BBOX,
    });
    if (first.status === 'no_route' || later.status === 'no_route' || changedFeature.status === 'no_route') {
      throw new Error('Expected routes');
    }
    expect(later.snapshotId).not.toBe(first.snapshotId);
    expect(changedFeature.snapshotId).not.toBe(first.snapshotId);
  });

  it('enforces the complete planning deadline before expensive work starts', async () => {
    await expect(planRoute(routeRequest(), {
      snapshot: snapshotFor({ depthM: 8 }),
      bbox: BBOX,
      timeoutMs: 0,
    })).rejects.toBeInstanceOf(RoutingPlanTimeoutError);
  });

  it('honours a caller abort signal between planning stages', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(planRoute(routeRequest(), {
      signal: controller.signal,
      snapshot: snapshotFor({ depthM: 8 }),
      bbox: BBOX,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails closed when 10 m line revalidation finds a tiny island missed by the grid', () => {
    const midpoint: [number, number] = [24.012, 59.006];
    const epsilon = 0.00002;
    const snapshot = snapshotFor({ depthM: 8 });
    snapshot.water = waterMask([globalWaterRing(), [
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
    ]]);
    const segment: RoutePlanSegment = {
      from: [24.011, 59.006],
      to: [24.013, 59.006],
      assessment: 'clear',
      reasons: [],
      sourceIds: ['emodnet-depth', 'openfreemap-water'],
      minDepthM: 8,
      requiredDepthM: 1.7,
    };

    expect(fineRevalidateSegments(snapshot, surfaceFor({ depthM: 8 }), [segment], () => undefined))
      .toMatchObject({ status: 'blocked', reason: 'land', position: midpoint });
  });

  it('skips base-raster revalidation only on the selected small-craft backbone', () => {
    const midpoint: [number, number] = [24.012, 59.006];
    const epsilon = 0.00002;
    const snapshot = snapshotFor({ depthM: 0.5 });
    snapshot.water = waterMask([globalWaterRing(), [
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
    ]]);
    const segment: RoutePlanSegment = {
      from: [24.011, 59.006],
      to: [24.013, 59.006],
      assessment: 'clear',
      reasons: [],
      sourceIds: [],
      minDepthM: 0.5,
      requiredDepthM: 1.7,
    };
    const backbone = [
      { x: 0, y: 0, position: segment.from },
      { x: 0, y: 0, position: segment.to },
    ];

    expect(fineRevalidateSegments(
      snapshot,
      surfaceFor({ depthM: 0.5 }),
      [segment],
      () => undefined,
      [backbone],
    )).toMatchObject({ status: 'valid' });
  });

  it('accepts a generalised shoreline overlap only on an open derived harbour centreline', () => {
    const midpoint: [number, number] = [24.012, 59.006];
    const epsilon = 0.00002;
    const corridor: RoutingCorridor = {
      id: 'trusted-harbour-centreline',
      kind: 'fairway',
      geometryRole: 'centreline',
      geometry: { type: 'LineString', coordinates: [[24.011, 59.006], [24.013, 59.006]] },
      widthM: 200,
      maxDraughtM: 2,
      official: true,
      harbourAccess: true,
      source: 'transpordiamet-his',
      fetchedAt: SOURCE.fetchedAt,
      stale: false,
    };
    const snapshot = snapshotFor({ depthM: 8, corridors: [corridor] });
    snapshot.water = waterMask([globalWaterRing(), [
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
    ]]);
    const segment: RoutePlanSegment = {
      from: [24.011, 59.006],
      to: [24.013, 59.006],
      assessment: 'caution',
      reasons: ['harbour_access'],
      sourceIds: ['transpordiamet-his'],
      minDepthM: null,
      requiredDepthM: 1.7,
    };

    expect(fineRevalidateSegments(
      snapshot,
      surfaceFor({ depthM: 8, corridors: [corridor] }),
      [segment],
      () => undefined,
    )).toMatchObject({ status: 'valid' });
  });

  it('automatically reroutes around a tiny island discovered by fine revalidation', async () => {
    const midpoint: [number, number] = [24.012, 59.006];
    const epsilon = 0.00002;
    const snapshot = snapshotFor({ depthM: 8 });
    snapshot.water = waterMask([globalWaterRing(), [
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] - epsilon],
      [midpoint[0] + epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] + epsilon],
      [midpoint[0] - epsilon, midpoint[1] - epsilon],
    ]]);

    const result = await planRoute(routeRequest(), { snapshot, bbox: BBOX });

    expect(result.status).not.toBe('no_route');
    if (result.status === 'no_route') throw new Error('Expected a fine-revalidated detour');
    expect(result.geometry.coordinates.length).toBeGreaterThan(2);
  });
});

function routeRequest(): RoutePlanRequest {
  return {
    start: { lat: 59.003, lon: 24.003 },
    end: { lat: 59.009, lon: 24.021 },
    departureTime: '2026-08-08T12:00:00.000Z',
    speedKnots: 8,
    draughtM: 1.2,
    underKeelClearanceM: 0.5,
    beamM: 3.5,
    airDraughtM: 4,
  };
}

function snapshotFor(options: SurfaceOptions): RoutingSnapshot {
  const corridors = options.corridors ?? [];
  return {
    depth: depthRaster(options.depthState ?? RoutingDepthState.Water, options.depthM ?? 8),
    water: waterMask(),
    vectors: vectorData(options),
    preparedGraph: corridors.length > 0
      ? buildPreparedRoutingGraph(corridors, BBOX, SOURCE.fetchedAt)
      : null,
  };
}

interface SurfaceOptions {
  depthState?: RoutingDepthState;
  depthM?: number;
  corridors?: RoutingCorridor[];
  hazards?: RoutingHazard[];
  harbours?: RoutingHarbour[];
  water?: RoutingWaterMask;
  warnings?: RoutingWarning[];
  positionOverrides?: [number, number][];
}

function surfaceFor(options: SurfaceOptions): RoutingCostSurface {
  const input: BuildRoutingCostSurfaceInput = {
    bbox: BBOX,
    depth: depthRaster(options.depthState ?? RoutingDepthState.Water, options.depthM ?? 8),
    water: options.water ?? waterMask(),
    vectors: vectorData(options),
    vessel: { draughtM: 1.2, underKeelClearanceM: 0.5, beamM: 3.5, airDraughtM: 4 },
    maxCells: 10_000,
    minCellSizeM: 40,
    positionOverrides: options.positionOverrides,
  };
  return buildRoutingCostSurface(input);
}

function depthRaster(state: RoutingDepthState, depthM: number): RoutingDepthRaster {
  const width = 48;
  const height = 24;
  const states = new Uint8Array(width * height);
  states.fill(state);
  const depths = new Float32Array(width * height);
  depths.fill(state === RoutingDepthState.Water ? depthM : Number.NaN);
  return {
    bbox: [BBOX[1], BBOX[0], BBOX[3], BBOX[2]],
    width,
    height,
    states,
    depths,
    source: { ...SOURCE, id: 'emodnet-depth' },
  };
}

function refinementSnapshot(options: {
  barrierColumns: number[];
  gapRows?: number[];
}): RoutingSnapshot {
  const width = 160;
  const height = 60;
  const states = new Uint8Array(width * height);
  states.fill(RoutingDepthState.Water);
  const depths = new Float32Array(width * height);
  depths.fill(8);
  const gapRows = new Set(options.gapRows ?? []);
  for (let y = 0; y < height; y++) {
    if (gapRows.has(y)) continue;
    for (const x of options.barrierColumns) depths[y * width + x] = 0.5;
  }
  return {
    depth: {
      bbox: [REFINEMENT_BBOX[1], REFINEMENT_BBOX[0], REFINEMENT_BBOX[3], REFINEMENT_BBOX[2]],
      width,
      height,
      states,
      depths,
      source: { ...SOURCE, id: 'emodnet-depth' },
    },
    water: waterMask(),
    vectors: vectorData({}),
  };
}

function rasterRowLatitude(bbox: BBox, height: number, row: number): number {
  return bbox[2] - (row + 0.5) / height * (bbox[2] - bbox[0]);
}

function waterMask(rings: [number, number][][] = [globalWaterRing()]): RoutingWaterMask {
  return {
    zoom: 0,
    tiles: new Map([['0:0', { polygons: [rings] }]]),
    source: { ...SOURCE, id: 'openfreemap-water' },
  };
}

function vectorData(options: SurfaceOptions): RoutingVectorData {
  const sources: RoutingSourceMeta[] = [...new Set([
    ...(options.corridors ?? []).map((item) => item.source),
    ...(options.hazards ?? []).map((item) => item.source),
    ...(options.warnings ?? []).map((item) => item.source),
  ])].map((source) => ({
    id: source,
    source,
    status: 'ok',
    stale: false,
    fetchedAt: SOURCE.fetchedAt,
    ageSeconds: 0,
    coverage: 'complete',
    tilesRequested: 1,
    tilesLoaded: 1,
    attribution: 'test',
    attributionUrl: 'https://example.test',
  }));
  return {
    bbox: BBOX,
    hazards: options.hazards ?? [],
    corridors: options.corridors ?? [],
    restrictions: [],
    warnings: options.warnings ?? [],
    surveyAreas: [],
    harbours: options.harbours,
    sources,
  };
}

function areaAround(lon: number, lat: number, radius = 0.002): RoutingCorridor['geometry'] {
  const dx = radius;
  const dy = radius;
  return {
    type: 'Polygon',
    coordinates: [[
      [lon - dx, lat - dy],
      [lon + dx, lat - dy],
      [lon + dx, lat + dy],
      [lon - dx, lat + dy],
      [lon - dx, lat - dy],
    ]],
  };
}

function globalWaterRing(): [number, number][] {
  return [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
}

function positionForProjection(
  projection: ReturnType<typeof createRoutingProjection>,
  x: number,
  y: number,
): [number, number] {
  const [, west, north] = projection.bbox;
  return [west + (x + 0.5) * projection.lonStep, north - (y + 0.5) * projection.latStep];
}

function detailsNear(surface: RoutingCostSurface, lon: number, lat: number) {
  const coordinate = surface.toGrid({ lon, lat });
  const x = Math.max(0, Math.min(surface.width - 1, Math.round(coordinate.x)));
  const y = Math.max(0, Math.min(surface.height - 1, Math.round(coordinate.y)));
  return surface.detailsAt(x, y);
}

function disconnectedSurface(): RoutingCostSurface {
  const rows = [
    '.....',
    '.###.',
    '.#.#.',
    '.###.',
    '.....',
  ];
  return {
    width: 5,
    height: 5,
    minimumCostMultiplier: 1,
    requiredDepthM: 1,
    projection: {
      bbox: [0, 0, 0.00005, 0.00005],
      width: 5,
      height: 5,
      cellSizeM: 1,
      lonStep: 0.00001,
      latStep: 0.00001,
      metresPerLongitudeDegree: 111_320,
    },
    cellAt(x, y) {
      const blocked = rows[y]?.[x] === '#';
      return { blocked, costMultiplier: 1, risk: 'clear' };
    },
    toGrid(point) {
      return { x: point.lon / 0.00001, y: point.lat / 0.00001 };
    },
    toPosition(point) {
      return [point.x * 0.00001, point.y * 0.00001];
    },
    detailsAt(x, y) {
      const blocked = rows[y]?.[x] === '#';
      return {
        blocked,
        costMultiplier: 1,
        risk: 'clear',
        reasons: blocked ? ['land'] : [],
        sourceIds: [],
        depthM: blocked ? null : 8,
      };
    },
  };
}
