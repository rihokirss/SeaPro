import { expect, it } from 'vitest';
import type { TrafficDensity } from '@seapro/shared';
import { trafficRaster, TRAFFIC_COLORS } from './trafficDensity';

it('blends a transparent-bordered raster, colouring and weighting only the selected types', () => {
  const data: TrafficDensity = {
    from: '2026-11-10', to: '2026-11-11', coveredDays: 2, factor: 2, cells: [
      { x: 300, y: 1490, metres: { cargo: 1852 * 8, tanker: 1852 * 16 } },
      { x: 301, y: 1490, metres: { passenger: 1852 } },
    ],
  };
  const all = trafficRaster(data, [])!;
  const selected = trafficRaster(data, ['cargo', 'passenger'])!;
  expect(selected.width).toBe(4);
  expect(selected.height).toBe(3);
  const first = 4 * (selected.width + 1);
  const color = (pixels: Uint8ClampedArray, offset: number) =>
    '#' + Array.from(pixels.slice(offset, offset + 3), v => v.toString(16).padStart(2, '0')).join('');
  expect(color(all.pixels, first)).toBe(TRAFFIC_COLORS.tanker);
  expect(color(selected.pixels, first)).toBe(TRAFFIC_COLORS.cargo);
  expect(color(selected.pixels, first + 4)).toBe(TRAFFIC_COLORS.passenger);
  expect(selected.pixels[first + 3]).toBeLessThan(all.pixels[first + 3]!);
  expect(selected.pixels[3]).toBe(0);
  expect(trafficRaster(data, ['fast'])!.pixels.every(v => v === 0)).toBe(true);
});
