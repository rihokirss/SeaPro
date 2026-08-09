import { describe, expect, it } from 'vitest';
import {
  bearingDegrees,
  crossTrackDistanceMetres,
  distanceMetres,
  interpolatePosition,
  routeDistanceNm,
  routeSampleIntervalMinutes,
  sampleRoute,
  segmentProgress,
} from '@seapro/shared';

describe('route geometry', () => {
  const tallinn = { lat: 59.437, lon: 24.7536 };
  const helsinki = { lat: 60.1699, lon: 24.9384 };

  it('calculates a plausible great-circle distance and bearing', () => {
    expect(distanceMetres(tallinn, helsinki) / 1852).toBeCloseTo(44.7, 0);
    expect(bearingDegrees(tallinn, helsinki)).toBeGreaterThan(0);
    expect(bearingDegrees(tallinn, helsinki)).toBeLessThan(20);
  });

  it('samples at waypoints and adapts the time interval on a longer route', () => {
    const samples = sampleRoute({ waypoints: [tallinn, helsinki], startTime: '2026-08-03T10:00:00Z', speedKnots: 6 });
    expect(samples[0]?.waypointIndex).toBe(0);
    expect(samples.at(-1)?.waypointIndex).toBe(1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.distanceNm - samples[i - 1]!.distanceNm).toBeLessThanOrEqual(6.01);
    }
    expect(routeSampleIntervalMinutes(routeDistanceNm([tallinn, helsinki]) / 6)).toBe(60);
    expect(new Date(samples.at(-1)!.time).getTime() - new Date(samples[0]!.time).getTime())
      .toBeCloseTo(routeDistanceNm([tallinn, helsinki]) / 6 * 3_600_000, -2);
  });

  it('uses a 30-minute interval on a short route', () => {
    const nearby = interpolatePosition(tallinn, helsinki, 0.1);
    const samples = sampleRoute({ waypoints: [tallinn, nearby], startTime: '2026-08-03T10:00:00Z', speedKnots: 6 });
    expect(samples).toHaveLength(3);
    expect(new Date(samples[1]!.time).getTime() - new Date(samples[0]!.time).getTime()).toBe(30 * 60_000);
  });

  it('keeps leg ends but does not restart the 30-minute clock on each leg', () => {
    const middle = interpolatePosition(tallinn, helsinki, 0.37);
    const startTime = '2026-08-03T10:00:00Z';
    const samples = sampleRoute({ waypoints: [tallinn, middle, helsinki], startTime, speedKnots: 12 });

    expect(samples.find((sample) => sample.waypointIndex === 1)).toMatchObject(middle);
    for (const sample of samples.filter((entry) => entry.waypointIndex === undefined)) {
      const elapsedMinutes = (new Date(sample.time).getTime() - new Date(startTime).getTime()) / 60_000;
      expect(elapsedMinutes % 30).toBeCloseTo(0, 6);
    }
  });

  it('adds at most ten timed rows on top of navigation leg ends', () => {
    const waypoints = Array.from({ length: 26 }, (_, index) => interpolatePosition(tallinn, helsinki, index / 25));
    const samples = sampleRoute({ waypoints, startTime: '2026-08-03T10:00:00Z', speedKnots: 6 });

    expect(samples.filter((sample) => sample.waypointIndex !== undefined)).toHaveLength(26);
    expect(samples.length).toBeLessThanOrEqual(36);
  });

  it('returns cross-track distance from the nearest point on a leg', () => {
    const lineA = { lat: 59, lon: 24 };
    const lineB = { lat: 59, lon: 25 };
    expect(crossTrackDistanceMetres({ lat: 59, lon: 24.5 }, lineA, lineB)).toBeLessThan(1);
    expect(crossTrackDistanceMetres({ lat: 59.01, lon: 24.5 }, lineA, lineB)).toBeGreaterThan(1000);
  });

  it('detects when a waypoint has been passed', () => {
    expect(segmentProgress({ lat: 59, lon: 25.1 }, { lat: 59, lon: 24 }, { lat: 59, lon: 25 })).toBeGreaterThan(1);
  });
});
