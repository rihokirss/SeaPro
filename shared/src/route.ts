import type { RouteAnalysisRequest } from './index.js';

export const EARTH_RADIUS_M = 6_371_008.8;
export const METRES_PER_NM = 1852;

export interface RouteSamplePoint {
  lat: number;
  lon: number;
  distanceNm: number;
  time: string;
  waypointIndex?: number;
}

const rad = (degrees: number): number => degrees * Math.PI / 180;
const deg = (radians: number): number => radians * 180 / Math.PI;

export function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat))
    - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Suure ringi interpolatsioon, mis toimib ka kuupäevaraja lähedal. */
export function interpolatePosition(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  fraction: number,
): { lat: number; lon: number } {
  const f = Math.max(0, Math.min(1, fraction));
  const angular = distanceMetres(a, b) / EARTH_RADIUS_M;
  if (angular < 1e-12) return { lat: a.lat, lon: a.lon };
  const scaleA = Math.sin((1 - f) * angular) / Math.sin(angular);
  const scaleB = Math.sin(f * angular) / Math.sin(angular);
  const x = scaleA * Math.cos(rad(a.lat)) * Math.cos(rad(a.lon))
    + scaleB * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon));
  const y = scaleA * Math.cos(rad(a.lat)) * Math.sin(rad(a.lon))
    + scaleB * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon));
  const z = scaleA * Math.sin(rad(a.lat)) + scaleB * Math.sin(rad(b.lat));
  return { lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: deg(Math.atan2(y, x)) };
}

export function routeDistanceNm(points: Array<{ lat: number; lon: number }>): number {
  let metres = 0;
  for (let i = 1; i < points.length; i++) metres += distanceMetres(points[i - 1]!, points[i]!);
  return metres / METRES_PER_NM;
}

const ROUTE_SAMPLE_INTERVAL_MINUTES = [30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;
const MAX_TIME_SAMPLES = 10;
const DISTANCE_EPSILON_NM = 1e-6;

interface RouteSampleTarget {
  distanceNm: number;
  waypointIndex?: number;
}

/** Väikseim mugav ajasamm, mis ei lisa marsruudile üle kümne ajaproovi. */
export function routeSampleIntervalMinutes(durationHours: number): number {
  if (!Number.isFinite(durationHours) || durationHours <= 0) return ROUTE_SAMPLE_INTERVAL_MINUTES[0];
  const durationMinutes = durationHours * 60;
  for (const interval of ROUTE_SAMPLE_INTERVAL_MINUTES) {
    if (Math.ceil(durationMinutes / interval) - 1 <= MAX_TIME_SAMPLES) return interval;
  }
  return Math.ceil(durationMinutes / MAX_TIME_SAMPLES / 1440) * 1440;
}

/**
 * Proov marsruudi alguses, iga jala lõpus ja ühtlase ajasammuga.
 *
 * Ajapunktid käivad üle terve marsruudi, mitte ei alga igal jalal uuesti.
 * Nii ei teki pika jala sisse juhusliku vahega ridu ega lühikeste jalgade
 * piiridele topeltpunkte. Jala otspunkt võidab samale ajale sattunud tavalise
 * ajaproovi, et UI saaks selle arusaadavalt märgistada.
 */
export function sampleRoute(request: Pick<RouteAnalysisRequest, 'waypoints' | 'startTime' | 'speedKnots'>): RouteSamplePoint[] {
  const startMs = new Date(request.startTime).getTime();
  if (request.waypoints.length < 2 || !Number.isFinite(startMs) || request.speedKnots <= 0) return [];

  const cumulativeDistances = [0];
  for (let i = 1; i < request.waypoints.length; i++) {
    const a = request.waypoints[i - 1]!;
    const b = request.waypoints[i]!;
    const segmentNm = distanceMetres(a, b) / METRES_PER_NM;
    cumulativeDistances.push(cumulativeDistances.at(-1)! + segmentNm);
  }
  const totalDistanceNm = cumulativeDistances.at(-1)!;
  const intervalMinutes = routeSampleIntervalMinutes(totalDistanceNm / request.speedKnots);
  const intervalDistanceNm = request.speedKnots * intervalMinutes / 60;
  const targets: RouteSampleTarget[] = cumulativeDistances.map((distanceNm, waypointIndex) => ({
    distanceNm,
    waypointIndex,
  }));
  for (let distanceNm = intervalDistanceNm; distanceNm < totalDistanceNm - DISTANCE_EPSILON_NM; distanceNm += intervalDistanceNm) {
    targets.push({ distanceNm });
  }
  targets.sort((a, b) => a.distanceNm - b.distanceNm);

  const mergedTargets: RouteSampleTarget[] = [];
  for (const target of targets) {
    const previous = mergedTargets.at(-1);
    if (previous && Math.abs(previous.distanceNm - target.distanceNm) <= DISTANCE_EPSILON_NM) {
      if (previous.waypointIndex === undefined && target.waypointIndex !== undefined) {
        previous.waypointIndex = target.waypointIndex;
      }
      continue;
    }
    mergedTargets.push({ ...target });
  }

  let segmentIndex = 0;
  return mergedTargets.map((target) => {
    while (
      segmentIndex < request.waypoints.length - 2
      && target.distanceNm > cumulativeDistances[segmentIndex + 1]! + DISTANCE_EPSILON_NM
    ) segmentIndex++;
    const segmentStartNm = cumulativeDistances[segmentIndex]!;
    const segmentEndNm = cumulativeDistances[segmentIndex + 1]!;
    const segmentNm = segmentEndNm - segmentStartNm;
    const position = target.waypointIndex !== undefined
      ? request.waypoints[target.waypointIndex]!
      : interpolatePosition(
        request.waypoints[segmentIndex]!,
        request.waypoints[segmentIndex + 1]!,
        segmentNm <= DISTANCE_EPSILON_NM ? 1 : (target.distanceNm - segmentStartNm) / segmentNm,
      );
    return {
      ...position,
      distanceNm: target.distanceNm,
      time: new Date(startMs + target.distanceNm / request.speedKnots * 3_600_000).toISOString(),
      ...(target.waypointIndex !== undefined ? { waypointIndex: target.waypointIndex } : {}),
    };
  });
}

/** Equirectangular lähendus lühikese merelõigu ristkauguseks. */
export function crossTrackDistanceMetres(
  point: { lat: number; lon: number },
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const meanLat = rad((a.lat + b.lat + point.lat) / 3);
  const project = (p: { lat: number; lon: number }) => ({ x: rad(p.lon) * Math.cos(meanLat) * EARTH_RADIUS_M, y: rad(p.lat) * EARTH_RADIUS_M });
  const p = project(point); const p1 = project(a); const p2 = project(b);
  const dx = p2.x - p1.x; const dy = p2.y - p1.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / length2));
  return Math.hypot(p.x - (p1.x + t * dx), p.y - (p1.y + t * dy));
}

/** 0 = lõigu algus, 1 = lõpp; väärtus üle ühe tähendab, et lõpp on ületatud. */
export function segmentProgress(
  point: { lat: number; lon: number },
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const meanLat = rad((a.lat + b.lat + point.lat) / 3);
  const x = (lon: number): number => rad(lon) * Math.cos(meanLat) * EARTH_RADIUS_M;
  const y = (lat: number): number => rad(lat) * EARTH_RADIUS_M;
  const dx = x(b.lon) - x(a.lon); const dy = y(b.lat) - y(a.lat);
  const length2 = dx * dx + dy * dy;
  return length2 === 0 ? 1 : ((x(point.lon) - x(a.lon)) * dx + (y(point.lat) - y(a.lat)) * dy) / length2;
}
