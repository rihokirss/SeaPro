import { trafficLat, trafficLon, TRAFFIC_TYPES, type TrafficDensity, type TrafficType } from '@seapro/shared';
import type { ImageSource, Map as MapLibreMap } from 'maplibre-gl';
import { insertBefore } from '../layerOrder';

const LAYER = 'traffic-density';
export const TRAFFIC_COLORS: Record<TrafficType, string> = {
  cargo: '#2c73b8', tanker: '#cb8721', passenger: '#20876a', fishing: '#a05899',
  sailing: '#4ea598', pleasure: '#3a99c5', fast: '#d16e5c', other: '#747d8c',
};

const rgb = Object.fromEntries(TRAFFIC_TYPES.map(type => [type, parseInt(TRAFFIC_COLORS[type].slice(1), 16)]));

// Each texel represents one measured cell. The transparent border lets isolated
// routes fade at their actual edges. MapLibre interpolates adjacent texels on the GPU.
export function trafficRaster(data: TrafficDensity, selected: readonly TrafficType[]) {
  if (!data.cells.length || !data.coveredDays) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of data.cells) {
    minX = Math.min(cell.x, minX); maxX = Math.max(cell.x, maxX);
    minY = Math.min(cell.y, minY); maxY = Math.max(cell.y, maxY);
  }
  minX--; minY--; maxX++; maxY++;
  const width = maxX - minX + 1, height = maxY - minY + 1;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const types = selected.length ? TRAFFIC_TYPES.filter(type => selected.includes(type)) : TRAFFIC_TYPES;
  const strengths = types.length < TRAFFIC_TYPES.length ? new Float64Array(width * height) : null;
  let minStrength = Infinity, maxStrength = -Infinity;
  for (const { x, y, metres } of data.cells) {
    let dominant = types[0]!, distance = 0;
    for (const type of types) {
      distance += metres[type] ?? 0;
      if ((metres[type] ?? 0) > (metres[dominant] ?? 0)) dominant = type;
    }
    if (!distance) continue;
    const index = (y - minY) * width + x - minX;
    const i = 4 * index;
    const color = rgb[dominant]!;
    pixels[i] = color >> 16;
    pixels[i + 1] = (color >> 8) & 255;
    pixels[i + 2] = color & 255;
    if (strengths) {
      const strength = Math.log1p(distance);
      strengths[index] = strength;
      minStrength = Math.min(minStrength, strength);
      maxStrength = Math.max(maxStrength, strength);
    } else {
      const density = distance / (1852 * data.coveredDays * data.factor ** 2);
      pixels[i + 3] = Math.round(255 * Math.min(0.90, 0.09 + 0.24 * Math.log1p(8 * density)));
    }
  }
  // Scale over occupied cells in the buffered area so small pans keep the same contrast.
  if (strengths) {
    for (let i = 0; i < strengths.length; i++) {
      if (!strengths[i]) continue;
      const level = maxStrength === minStrength ? 1 : (strengths[i]! - minStrength) / (maxStrength - minStrength);
      pixels[4 * i + 3] = Math.round(255 * (0.22 + 0.68 * level));
    }
  }
  const west = trafficLon(minX * data.factor), east = trafficLon((maxX + 1) * data.factor);
  const north = trafficLat(minY * data.factor), south = trafficLat((maxY + 1) * data.factor);
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] =
    [[west, north], [east, north], [east, south], [west, south]];
  return { pixels, width, height, coordinates };
}

export function showTrafficDensity(map: MapLibreMap, data: TrafficDensity, selected: readonly TrafficType[]) {
  const raster = trafficRaster(data, selected);
  if (!raster) return hideTrafficDensity(map);
  const { pixels, width, height, coordinates } = raster;
  if (!map.getSource(LAYER)) map.addSource(LAYER, { type: 'image', coordinates });
  map.getSource<ImageSource>(LAYER)!.updateImage({ image: new ImageData(pixels, width, height), coordinates });
  if (!map.getLayer(LAYER)) {
    map.addLayer({
      id: LAYER, type: 'raster', source: LAYER,
      paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
    }, insertBefore(map, LAYER));
  }
  map.setLayoutProperty(LAYER, 'visibility', 'visible');
}

export function hideTrafficDensity(map: MapLibreMap) {
  if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'none');
}
