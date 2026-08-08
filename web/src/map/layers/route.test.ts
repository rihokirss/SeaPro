import { describe, expect, it } from 'vitest';
import type { DepthRiskSegment, RoutePlan, RouteWaypoint } from '@seapro/shared';
import { buildRouteLineData, buildRouteWaypointData } from './route';

const waypoints: RouteWaypoint[] = [
  { id: 'a', lat: 59, lon: 24 },
  { id: 'b', lat: 60, lon: 25 },
];

const plan: RoutePlan = {
  status: 'advisory',
  geometry: { type: 'LineString', coordinates: [[24, 59], [24.5, 59.6], [25, 60]] },
  navigationWaypoints: [
    waypoints[0]!,
    { id: 'turn', lat: 59.6, lon: 24.5 },
    waypoints[1]!,
  ],
  segments: [
    { from: [24, 59], to: [24.25, 59.3], assessment: 'caution', reasons: ['low_clearance'], sourceIds: ['depth'], minDepthM: 2, requiredDepthM: 1.7 },
    { from: [24.25, 59.3], to: [25, 60], assessment: 'unknown', reasons: ['depth_unknown'], sourceIds: [], minDepthM: null, requiredDepthM: 1.7 },
  ],
  endpoints: {
    start: { requested: waypoints[0]!, snapped: waypoints[0]!, distanceM: 0 },
    end: { requested: waypoints[1]!, snapped: waypoints[1]!, distanceM: 0 },
  },
  distanceNm: 70,
  generatedAt: '2026-08-08T12:00:00Z',
  snapshotId: 'snapshot',
  sources: [],
  issues: [],
};

describe('buildRouteLineData', () => {
  it('draws the authoritative automatic geometry with risk overlays', () => {
    const data = buildRouteLineData(waypoints, [], plan, false);
    expect(data.features).toHaveLength(3);
    expect(data.features[0]!.geometry.coordinates).toEqual(plan.geometry.coordinates);
    expect(data.features.map((feature) => feature.properties?.risk)).toEqual(['clear', 'caution', 'unknown']);
  });

  it('uses depth analysis for a manual route', () => {
    const segment: DepthRiskSegment = {
      from: [24, 59], to: [25, 60], risk: 'danger', minDepthM: 1, requiredDepthM: 1.7,
    };
    const data = buildRouteLineData(waypoints, [segment], null, false);
    expect(data.features).toHaveLength(1);
    expect(data.features[0]!.properties?.risk).toBe('danger');
  });

  it('shows the requested-to-snapped endpoint connector', () => {
    const shifted: RoutePlan = {
      ...plan,
      endpoints: {
        ...plan.endpoints,
        start: {
          requested: { lat: 59, lon: 24 },
          snapped: { lat: 59.001, lon: 24.002 },
          distanceM: 150,
        },
      },
    };
    const data = buildRouteLineData(waypoints, [], shifted, false);
    expect(data.features.at(-1)?.properties?.risk).toBe('snap');
    expect(data.features.at(-1)?.geometry.coordinates).toEqual([[24, 59], [24.002, 59.001]]);
  });

  it('falls back to the editable waypoint line while manual editing is active', () => {
    const data = buildRouteLineData(waypoints, [], plan, true);
    expect(data.features).toHaveLength(1);
    expect(data.features[0]!.geometry.coordinates).toEqual([[24, 59], [25, 60]]);
    expect(data.features[0]!.properties?.risk).toBe('unknown');
  });

  it('shows requested A/B and automatic turning points without duplicate unsnapped endpoints', () => {
    const data = buildRouteWaypointData(waypoints, plan, false, null);
    expect(data.features.map((feature) => feature.properties?.kind)).toEqual([
      'start',
      'finish',
      'plan-turn',
    ]);
    expect(data.features.map((feature) => feature.properties?.label)).toEqual(['A', 'B', '2']);
    expect(data.features[2]!.geometry.coordinates).toEqual([24.5, 59.6]);
  });

  it('marks snapped automatic endpoints separately from the requested A/B points', () => {
    const shifted: RoutePlan = {
      ...plan,
      navigationWaypoints: [
        { id: 'snapped-a', lat: 59.001, lon: 24.002 },
        ...plan.navigationWaypoints.slice(1, -1),
        { id: 'snapped-b', lat: 59.999, lon: 24.998 },
      ],
      endpoints: {
        start: {
          requested: { lat: 59, lon: 24 },
          snapped: { lat: 59.001, lon: 24.002 },
          distanceM: 150,
        },
        end: {
          requested: { lat: 60, lon: 25 },
          snapped: { lat: 59.999, lon: 24.998 },
          distanceM: 160,
        },
      },
    };
    const data = buildRouteWaypointData(waypoints, shifted, false, null);
    expect(data.features.map((feature) => feature.properties?.kind)).toEqual([
      'start',
      'finish',
      'plan-start',
      'plan-turn',
      'plan-finish',
    ]);
    expect(data.features.map((feature) => feature.properties?.label)).toEqual(['A', 'B', 'A′', '2', 'B′']);
    expect(data.features[2]!.geometry.coordinates).toEqual([24.002, 59.001]);
    expect(data.features.at(-1)!.geometry.coordinates).toEqual([24.998, 59.999]);
  });

  it('uses only manual waypoints while editing', () => {
    const manual = [...waypoints.slice(0, 1), { id: 'middle', lat: 59.5, lon: 24.5 }, ...waypoints.slice(1)];
    const data = buildRouteWaypointData(manual, plan, true, 'middle');
    expect(data.features.map((feature) => feature.properties?.kind)).toEqual(['start', 'middle', 'finish']);
    expect(data.features[1]!.properties?.selected).toBe(true);
  });
});
