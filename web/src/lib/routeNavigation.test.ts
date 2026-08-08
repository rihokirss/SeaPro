import { describe, expect, it } from 'vitest';
import type { Route } from '@seapro/shared';
import { initialNavigationWaypointIndex, navigationWaypointReached } from './routeNavigation';

function routeWithPlan(): Route {
  const now = '2026-08-08T12:00:00Z';
  return {
    id: 'route',
    name: 'Route',
    waypoints: [
      { id: 'requested-a', lat: 59, lon: 24 },
      { id: 'requested-b', lat: 60, lon: 25 },
    ],
    startTime: now,
    speedKnots: 8,
    draughtM: 1.2,
    underKeelClearanceM: 0.5,
    beamM: 3,
    airDraughtM: 4,
    fuelLitresPerHour: 5,
    createdAt: now,
    updatedAt: now,
    plan: {
      status: 'route',
      geometry: { type: 'LineString', coordinates: [[24.01, 59], [25, 60]] },
      navigationWaypoints: [
        { id: 'auto-a', lat: 59, lon: 24.01 },
        { id: 'auto-b', lat: 60, lon: 25 },
      ],
      segments: [],
      endpoints: {
        start: {
          requested: { lat: 59, lon: 24 },
          snapped: { lat: 59, lon: 24.01 },
          distanceM: 560,
        },
        end: {
          requested: { lat: 60, lon: 25 },
          snapped: { lat: 60, lon: 25 },
          distanceM: 0,
        },
      },
      distanceNm: 70,
      generatedAt: now,
      snapshotId: 'snapshot',
      sources: [],
      issues: [],
    },
  };
}

describe('automatic route navigation entry', () => {
  it('targets snapped waypoint zero when GPS is farther than 50 metres', () => {
    expect(initialNavigationWaypointIndex(routeWithPlan(), { lat: 59, lon: 24 })).toBe(0);
  });

  it('continues with waypoint one when GPS is already at the snapped entry', () => {
    expect(initialNavigationWaypointIndex(routeWithPlan(), { lat: 59, lon: 24.01 })).toBe(1);
  });

  it('waits for waypoint zero when an automatic route starts before the first GPS fix', () => {
    expect(initialNavigationWaypointIndex(routeWithPlan(), null)).toBe(0);
  });

  it('keeps the existing waypoint-one start for a manual route', () => {
    const route = routeWithPlan();
    delete route.plan;
    expect(initialNavigationWaypointIndex(route, { lat: 59, lon: 24 })).toBe(1);
  });

  it('does not treat the zero-length entry leg as already passed', () => {
    const target = { lat: 59, lon: 24.01 };
    expect(navigationWaypointReached(0, { lat: 59, lon: 24 }, target, 1)).toBe(false);
    expect(navigationWaypointReached(0, { lat: 59, lon: 24.01 }, target, 1)).toBe(true);
  });
});
