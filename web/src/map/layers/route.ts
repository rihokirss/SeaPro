import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { DepthRiskSegment, RouteWaypoint, TrackPoint } from '@seapro/shared';
import type { FeatureCollection, LineString, Point } from 'geojson';

export const ROUTE_WAYPOINT_LAYER = 'route-waypoints';
export const ROUTE_LINE_LAYER = 'route-lines';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export function addRouteLayers(map: MapLibreMap): void {
  if (!map.getSource('src-route-lines')) map.addSource('src-route-lines', { type: 'geojson', data: EMPTY });
  if (!map.getSource('src-route-waypoints')) map.addSource('src-route-waypoints', { type: 'geojson', data: EMPTY });
  if (!map.getSource('src-actual-track')) map.addSource('src-actual-track', { type: 'geojson', data: EMPTY });
  if (!map.getLayer(ROUTE_LINE_LAYER)) map.addLayer({
    id: ROUTE_LINE_LAYER, type: 'line', source: 'src-route-lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'risk'], 'danger', '#ef4444', 'caution', '#d99a19', 'unknown', '#7b8790', '#1b91d1'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 13, 6],
      'line-dasharray': ['case', ['==', ['get', 'risk'], 'unknown'], ['literal', [2, 2]], ['literal', [1, 0]]],
    },
  });
  if (!map.getLayer('actual-track')) map.addLayer({
    id: 'actual-track', type: 'line', source: 'src-actual-track',
    paint: { 'line-color': '#b236ff', 'line-width': 4, 'line-opacity': 0.9 },
  });
  if (!map.getLayer(ROUTE_WAYPOINT_LAYER)) map.addLayer({
    id: ROUTE_WAYPOINT_LAYER, type: 'circle', source: 'src-route-waypoints',
    paint: { 'circle-radius': ['case', ['boolean', ['get', 'editing'], false], 9, 7], 'circle-color': '#f8f5e9', 'circle-stroke-color': '#0b5678', 'circle-stroke-width': 3 },
  });
}

export function updateRouteLayers(map: MapLibreMap, waypoints: RouteWaypoint[], segments: DepthRiskSegment[], track: TrackPoint[], editing: boolean): void {
  const fallback: DepthRiskSegment[] = !editing && segments.length ? segments : waypoints.slice(1).map((p, i) => ({
    from: [waypoints[i]!.lon, waypoints[i]!.lat], to: [p.lon, p.lat], risk: 'unknown', minDepthM: null, requiredDepthM: 0,
  }));
  const lines: FeatureCollection<LineString> = { type: 'FeatureCollection', features: fallback.map((segment, index) => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: [segment.from, segment.to] }, properties: { risk: segment.risk, segmentIndex: index },
  })) };
  const points: FeatureCollection<Point> = { type: 'FeatureCollection', features: waypoints.map((p, index) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { index, editing },
  })) };
  const trackData: FeatureCollection<LineString> = { type: 'FeatureCollection', features: track.length > 1 ? [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) }, properties: {},
  }] : [] };
  map.getSource<GeoJSONSource>('src-route-lines')?.setData(lines);
  map.getSource<GeoJSONSource>('src-route-waypoints')?.setData(points);
  map.getSource<GeoJSONSource>('src-actual-track')?.setData(trackData);
}
