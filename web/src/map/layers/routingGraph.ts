import type { FeatureCollection, LineString } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { insertBefore } from '../layerOrder';

const SOURCE_ID = 'routing-graph-src';
export const ROUTING_GRAPH_OFFICIAL_LAYER = 'routing-graph-official';
export const ROUTING_GRAPH_RECOMMENDED_LAYER = 'routing-graph-recommended';

type RoutingGraphProperties = {
  kind: 'official' | 'recommended';
  [key: string]: unknown;
};

export function updateRoutingGraph(
  map: MapLibreMap,
  graph: FeatureCollection<LineString, RoutingGraphProperties>,
): void {
  const source = map.getSource<GeoJSONSource>(SOURCE_ID);
  if (source) source.setData(graph);
  else map.addSource(SOURCE_ID, { type: 'geojson', data: graph });

  if (!map.getLayer(ROUTING_GRAPH_OFFICIAL_LAYER)) {
    map.addLayer({
      id: ROUTING_GRAPH_OFFICIAL_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'official'],
      minzoom: 6,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#00d8ff',
        'line-opacity': 0.9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 11, 2.5, 15, 4],
      },
    }, insertBefore(map, ROUTING_GRAPH_OFFICIAL_LAYER));
  }
  if (!map.getLayer(ROUTING_GRAPH_RECOMMENDED_LAYER)) {
    map.addLayer({
      id: ROUTING_GRAPH_RECOMMENDED_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'recommended'],
      minzoom: 6,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ff8a00',
        'line-opacity': 0.95,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 11, 2.5, 15, 4],
        'line-dasharray': [2, 1.25],
      },
    }, insertBefore(map, ROUTING_GRAPH_RECOMMENDED_LAYER));
  }
}

export function setRoutingGraphVisible(map: MapLibreMap, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  for (const id of [ROUTING_GRAPH_OFFICIAL_LAYER, ROUTING_GRAPH_RECOMMENDED_LAYER]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
  }
}
