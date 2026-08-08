import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { DepthRiskSegment, RoutePlan, RouteWaypoint, TrackPoint } from '@seapro/shared';
import type { FeatureCollection, LineString, Point } from 'geojson';

export const ROUTE_WAYPOINT_LAYER = 'route-waypoints';
export const ROUTE_LINE_LAYER = 'route-lines';
export const ROUTE_WAYPOINT_HIT_LAYER = 'route-waypoints-hit';
export const ROUTE_LINE_HIT_LAYER = 'route-lines-hit';
const ROUTE_WAYPOINT_LABEL_LAYER = 'route-waypoint-labels';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export function addRouteLayers(map: MapLibreMap): void {
  if (!map.getSource('src-route-lines')) map.addSource('src-route-lines', { type: 'geojson', data: EMPTY });
  if (!map.getSource('src-route-waypoints')) map.addSource('src-route-waypoints', { type: 'geojson', data: EMPTY });
  if (!map.getSource('src-actual-track')) map.addSource('src-actual-track', { type: 'geojson', data: EMPTY });
  if (!map.getLayer(ROUTE_LINE_LAYER)) map.addLayer({
    id: ROUTE_LINE_LAYER, type: 'line', source: 'src-route-lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'risk'], 'danger', '#ef4444', 'caution', '#d99a19', 'unknown', '#8b75c9', 'snap', '#9aa6ad', '#1b91d1'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 13, 6],
      'line-dasharray': ['case', ['in', ['get', 'risk'], ['literal', ['unknown', 'snap']]], ['literal', [2, 2]], ['literal', [1, 0]]],
    },
  });
  if (!map.getLayer(ROUTE_LINE_HIT_LAYER)) map.addLayer({
    id: ROUTE_LINE_HIT_LAYER, type: 'line', source: 'src-route-lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#000000',
      'line-width': window.matchMedia('(max-width: 700px)').matches ? 24 : 16,
      'line-opacity': 0.01,
    },
  });
  if (!map.getLayer('actual-track')) map.addLayer({
    id: 'actual-track', type: 'line', source: 'src-actual-track',
    paint: { 'line-color': '#b236ff', 'line-width': 4, 'line-opacity': 0.9 },
  });
  if (!map.getLayer(ROUTE_WAYPOINT_LAYER)) map.addLayer({
    id: ROUTE_WAYPOINT_LAYER, type: 'circle', source: 'src-route-waypoints',
    paint: {
      'circle-radius': [
        'case',
        ['boolean', ['get', 'selected'], false], 12,
        ['boolean', ['get', 'editing'], false], 9,
        ['in', ['get', 'kind'], ['literal', ['plan-start', 'plan-finish']]], 8,
        ['==', ['get', 'kind'], 'plan-turn'], 6,
        7,
      ],
      'circle-color': [
        'match', ['get', 'kind'],
        'start', '#62c48d',
        'finish', '#ffad66',
        'plan-start', '#a6daba',
        'plan-finish', '#ffd0a3',
        '#f8f5e9',
      ],
      'circle-stroke-color': [
        'case',
        ['boolean', ['get', 'selected'], false], '#ffffff',
        ['in', ['get', 'kind'], ['literal', ['plan-start', 'plan-finish', 'plan-turn']]], '#1b91d1',
        '#0b5678',
      ],
      'circle-stroke-width': ['case', ['boolean', ['get', 'selected'], false], 5, ['==', ['get', 'kind'], 'plan-turn'], 2, 3],
    },
  });
  if (!map.getLayer(ROUTE_WAYPOINT_LABEL_LAYER)) map.addLayer({
    id: ROUTE_WAYPOINT_LABEL_LAYER, type: 'symbol', source: 'src-route-waypoints',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Regular'],
      'text-size': 10,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#082f42' },
  });
  if (!map.getLayer(ROUTE_WAYPOINT_HIT_LAYER)) map.addLayer({
    id: ROUTE_WAYPOINT_HIT_LAYER, type: 'circle', source: 'src-route-waypoints',
    paint: {
      'circle-radius': window.matchMedia('(max-width: 700px)').matches ? 22 : 16,
      'circle-color': '#000000',
      'circle-opacity': 0.01,
    },
  });
}

export function updateRouteLayers(
  map: MapLibreMap,
  waypoints: RouteWaypoint[],
  segments: DepthRiskSegment[],
  plan: RoutePlan | null,
  track: TrackPoint[],
  editing: boolean,
  selectedWaypointId: string | null,
): void {
  const lines = buildRouteLineData(waypoints, segments, plan, editing);
  const points = buildRouteWaypointData(waypoints, plan, editing, selectedWaypointId);
  const trackData: FeatureCollection<LineString> = { type: 'FeatureCollection', features: track.length > 1 ? [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) }, properties: {},
  }] : [] };
  map.getSource<GeoJSONSource>('src-route-lines')?.setData(lines);
  map.getSource<GeoJSONSource>('src-route-waypoints')?.setData(points);
  map.getSource<GeoJSONSource>('src-actual-track')?.setData(trackData);
}

/**
 * Automaatmarsruudi korral jäävad kasutaja küsitud A/B nähtavale ning
 * planeerija kleebitud sisenemis-/väljumispunktid ja pöörded lisatakse eraldi.
 * Nii ei näi snap-ühendus lihtsalt katkenud joonena ja navigatsiooniriba
 * waypoint'i number vastab kaardil olevale pöördepunktile.
 */
export function buildRouteWaypointData(
  waypoints: RouteWaypoint[],
  plan: RoutePlan | null,
  editing: boolean,
  selectedWaypointId: string | null,
): FeatureCollection<Point> {
  const requestedWaypoints = !editing && plan && waypoints.length >= 2
    ? [waypoints[0]!, waypoints.at(-1)!]
    : waypoints;
  const requested = requestedWaypoints.map((point, index) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
    properties: {
      id: point.id,
      index,
      editing,
      selected: point.id === selectedWaypointId,
      kind: index === 0 ? 'start' : index === requestedWaypoints.length - 1 ? 'finish' : 'middle',
      label: index === 0 ? 'A' : index === requestedWaypoints.length - 1 ? 'B' : String(index + 1),
    },
  }));
  const planned = !editing && plan ? plan.navigationWaypoints.flatMap((point, index) => {
    const last = index === plan.navigationWaypoints.length - 1;
    if ((index === 0 && plan.endpoints.start.distanceM <= 1)
      || (last && plan.endpoints.end.distanceM <= 1)) return [];
    return [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
      properties: {
        id: `plan:${point.id}:${index}`,
        index,
        editing: false,
        selected: false,
        kind: index === 0 ? 'plan-start' : last ? 'plan-finish' : 'plan-turn',
        label: index === 0 ? 'A′' : last ? 'B′' : String(index + 1),
      },
    }];
  }) : [];
  return { type: 'FeatureCollection', features: [...requested, ...planned] };
}

export function buildRouteLineData(
  waypoints: RouteWaypoint[],
  segments: DepthRiskSegment[],
  plan: RoutePlan | null,
  editing: boolean,
): FeatureCollection<LineString> {
  const fallback: DepthRiskSegment[] = !editing && segments.length ? segments : waypoints.slice(1).map((p, i) => ({
    from: [waypoints[i]!.lon, waypoints[i]!.lat], to: [p.lon, p.lat], risk: 'unknown', minDepthM: null, requiredDepthM: 0,
  }));
  const planCoordinates = !editing && plan ? plan.geometry.coordinates : [];
  // Geometry is the authoritative navigable line. Risk segments can be
  // compressed independently from its turning points, so draw them as
  // overlays instead of assuming a one-to-one index relationship.
  const riskOverlays: FeatureCollection<LineString>['features'] = plan?.segments.map((segment, index) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [segment.from, segment.to] },
    properties: {
      risk: segment.assessment,
      segmentIndex: index,
      reasons: segment.reasons.join(','),
      sourceIds: segment.sourceIds.join(','),
    },
  })) ?? [];
  const planLines: FeatureCollection<LineString>['features'] = planCoordinates.length > 1 ? [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: planCoordinates },
    properties: { risk: 'clear', segmentIndex: -1 },
  }, ...riskOverlays, ...endpointConnectors(plan)] : [];
  const manualLines: FeatureCollection<LineString>['features'] = fallback.map((segment, index) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [segment.from, segment.to] },
    properties: { risk: segment.risk, segmentIndex: index },
  }));
  const lines: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: planLines.length ? planLines : manualLines,
  };
  return lines;
}

function endpointConnectors(plan: RoutePlan | null): FeatureCollection<LineString>['features'] {
  if (!plan) return [];
  return [plan.endpoints.start, plan.endpoints.end].flatMap((endpoint) => endpoint.distanceM > 1 ? [{
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [endpoint.requested.lon, endpoint.requested.lat],
        [endpoint.snapped.lon, endpoint.snapped.lat],
      ],
    },
    properties: { risk: 'snap', segmentIndex: -1 },
  }] : []);
}
