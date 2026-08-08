import type { RouteAnalysis, RouteAnalysisRequest, RouteWeatherSample, TimeStep, Variable } from '@seapro/shared';
import { crossTrackDistanceMetres, distanceMetres, routeDistanceNm, sampleRoute } from '@seapro/shared';
import { analyseRouteDepth } from './depthContours.js';
import { getProvider } from './providers/registry.js';
import { fetchOfficialHarbours, fetchOfficialNavigation } from './navigation/arcgis.js';
import { RateLimitError } from './rateLimit.js';

const ROUTE_VARIABLES = ['wind_speed', 'wind_gust', 'wind_dir', 'wave_height', 'wave_period', 'wave_dir'] as const satisfies readonly Variable[];
const FORECAST_MS = 10 * 24 * 3_600_000;

function surroundingSteps(steps: TimeStep[], time: string): [TimeStep, TimeStep, number] | null {
  const target = new Date(time).getTime();
  const ordered = steps.map((step) => ({ step, at: new Date(step.time).getTime() })).filter((row) => Number.isFinite(row.at)).sort((a, b) => a.at - b.at);
  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i]!;
    if (current.at < target) continue;
    const previous = ordered[Math.max(0, i - 1)]!;
    if (Math.min(Math.abs(current.at - target), Math.abs(previous.at - target)) > 90 * 60_000) return null;
    const fraction = current.at === previous.at ? 0 : (target - previous.at) / (current.at - previous.at);
    return [previous.step, current.step, Math.max(0, Math.min(1, fraction))];
  }
  const last = ordered.at(-1);
  return last && Math.abs(last.at - target) <= 90 * 60_000 ? [last.step, last.step, 0] : null;
}

function interpolateValue(a: number, b: number, fraction: number, direction: boolean): number {
  if (!direction) return a + (b - a) * fraction;
  const ar = a * Math.PI / 180; const br = b * Math.PI / 180;
  const x = (1 - fraction) * Math.cos(ar) + fraction * Math.cos(br);
  const y = (1 - fraction) * Math.sin(ar) + fraction * Math.sin(br);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await fn(items[index]!); }
  });
  await Promise.all(workers); return result;
}

export async function analyseRoute(request: RouteAnalysisRequest): Promise<RouteAnalysis> {
  const pathPoints = request.path?.coordinates.map(([lon, lat]) => ({ lat, lon }))
    ?? request.waypoints;
  const samples = sampleRoute({ ...request, waypoints: pathPoints });
  const distanceNm = routeDistanceNm(pathPoints);
  const durationSeconds = distanceNm / request.speedKnots * 3600;
  const requiredDepthM = request.draughtM + request.underKeelClearanceM;
  const warnings: string[] = [];
  let weatherRateLimited = false;

  const depthPromise = analyseRouteDepth(pathPoints, requiredDepthM)
    .catch(() => { warnings.push('depth_unavailable'); return [] as RouteAnalysis['depthSegments']; });

  const provider = getProvider('open-meteo');
  const now = Date.now();
  const weather = provider ? await mapLimit(samples, 4, async (sample) => {
    if (new Date(sample.time).getTime() > now + FORECAST_MS) return null;
    try {
      const series = await provider.point({
        lat: sample.lat, lon: sample.lon, hours: 240, variables: [...ROUTE_VARIABLES],
        models: request.model ? [request.model] : undefined, waveModel: request.waveModel,
      });
      const merged: RouteWeatherSample['values'] = {};
      for (const row of series) {
        const window = surroundingSteps(row.steps, sample.time);
        if (!window) continue;
        const [before, after, fraction] = window;
        for (const variable of ROUTE_VARIABLES) {
          const a = before.values[variable]; const b = after.values[variable];
          if (a != null && b != null) merged[variable] = interpolateValue(a, b, fraction, variable.endsWith('_dir'));
          else if (a != null) merged[variable] = a;
          else if (b != null) merged[variable] = b;
        }
      }
      return merged;
    } catch (err) { if (err instanceof RateLimitError) weatherRateLimited = true; return null; }
  }) : samples.map(() => null);

  const depthSegments = await depthPromise;
  if (weatherRateLimited) warnings.push('weather_rate_limited');
  else if (weather.some((item) => item === null)) warnings.push('weather_partial');
  const lats = pathPoints.map((p) => p.lat); const lons = pathPoints.map((p) => p.lon);
  const bbox: [number, number, number, number] = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  const restrictions: RouteAnalysis['restrictions'] = [];
  if (bbox[2] >= 57 && bbox[0] <= 60.5 && bbox[3] >= 20 && bbox[1] <= 29) {
    const officialBbox: [number, number, number, number] = [Math.max(57, bbox[0] - 0.05), Math.max(20, bbox[1] - 0.05), Math.min(60.5, bbox[2] + 0.05), Math.min(29, bbox[3] + 0.05)];
    const [navigation, harbours] = await Promise.all([
      fetchOfficialNavigation(officialBbox).catch(() => ({ aids: [], fairways: [] })),
      fetchOfficialHarbours(officialBbox).catch(() => []),
    ]);
    for (const fairway of navigation.fairways) {
      const limit = fairway.shipDraughtM ?? fairway.depthM;
      if (limit == null || limit >= request.draughtM) continue;
      const lines = fairway.geometry.type === 'LineString' ? [fairway.geometry.coordinates] : fairway.geometry.coordinates;
      const close = lines.some((line) => line.slice(1).some((p, i) => samples.some((sample) => crossTrackDistanceMetres(sample, { lon: line[i]![0], lat: line[i]![1] }, { lon: p[0], lat: p[1] }) <= Math.max(100, (fairway.widthM ?? 0) / 2))));
      if (close) restrictions.push({ kind: 'fairway', name: fairway.name, maxDraughtM: limit });
    }
    const endpoints = [pathPoints[0]!, pathPoints.at(-1)!];
    for (const harbour of harbours) if (harbour.maxDraught != null && harbour.maxDraught < request.draughtM && endpoints.some((p) => distanceMetres(p, harbour) < 1000)) {
      restrictions.push({ kind: 'harbour', name: harbour.name, maxDraughtM: harbour.maxDraught });
    }
  }
  const resultSamples: RouteWeatherSample[] = samples.map((sample, i) => {
    const containing = depthSegments.find((segment) => {
      const minLon = Math.min(segment.from[0], segment.to[0]) - 1e-5;
      const maxLon = Math.max(segment.from[0], segment.to[0]) + 1e-5;
      const minLat = Math.min(segment.from[1], segment.to[1]) - 1e-5;
      const maxLat = Math.max(segment.from[1], segment.to[1]) + 1e-5;
      return sample.lon >= minLon && sample.lon <= maxLon && sample.lat >= minLat && sample.lat <= maxLat;
    });
    return {
      ...sample, values: weather[i] ?? {}, weatherAvailable: weather[i] !== null,
      depthM: containing?.minDepthM ?? null, depthRisk: containing?.risk ?? 'unknown',
    };
  });
  return {
    distanceNm, durationSeconds,
    arrivalTime: new Date(new Date(request.startTime).getTime() + durationSeconds * 1000).toISOString(),
    estimatedFuelLitres: durationSeconds / 3600 * request.fuelLitresPerHour,
    requiredDepthM, samples: resultSamples, depthSegments, warnings, restrictions,
  };
}
