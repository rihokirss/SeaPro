export const TRAFFIC_TYPES = ['cargo', 'tanker', 'passenger', 'fishing', 'sailing', 'pleasure', 'fast', 'other'] as const;
export type TrafficType = typeof TRAFFIC_TYPES[number];
export const TRAFFIC_PERIODS = [1, 7, 30, 365] as const;
export type TrafficPeriod = typeof TRAFFIC_PERIODS[number];

export function trafficType(code?: number): TrafficType {
  if (code === 30) return 'fishing';
  if (code === 36) return 'sailing';
  if (code === 37) return 'pleasure';
  switch (Math.floor((code ?? 0) / 10)) {
    case 4: return 'fast';
    case 6: return 'passenger';
    case 7: return 'cargo';
    case 8: return 'tanker';
    default: return 'other';
  }
}

// A square in Web Mercator is ~500 m on the ground at 60°N. The fixed world
// division also keeps cell edges aligned when combining cells or wrapping the map.
export const TRAFFIC_WORLD_CELLS = 40_960;
export function trafficX(lon: number): number {
  return (lon + 180) / 360 * TRAFFIC_WORLD_CELLS;
}
export function trafficY(lat: number): number {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return Math.max(0, Math.min(TRAFFIC_WORLD_CELLS, (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * TRAFFIC_WORLD_CELLS));
}
export function trafficLon(x: number): number {
  return x / TRAFFIC_WORLD_CELLS * 360 - 180;
}
export function trafficLat(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / TRAFFIC_WORLD_CELLS))) * 180 / Math.PI;
}
export interface TrafficCell {
  x: number;
  y: number;
  metres: Partial<Record<TrafficType, number>>;
}
export interface TrafficDensity {
  from: string | null;
  to: string | null;
  coveredDays: number;
  /** Width and height in base grid cells. */
  factor: number;
  cells: TrafficCell[];
}
