import { expect, it } from 'vitest';
import { TRAFFIC_TYPES, type TrafficDensity } from '@seapro/shared';
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
  const density = (1852 * 24) / (1852 * 2 * 2 ** 2);
  expect(all.pixels[first + 3]).toBe(Math.round(255 * (0.09 + 0.24 * Math.log1p(8 * density))));
  expect(trafficRaster(data, TRAFFIC_TYPES)!.pixels).toEqual(all.pixels);
  expect(selected.pixels[3]).toBe(0);
  expect(trafficRaster(data, ['fast'])!.pixels.every(v => v === 0)).toBe(true);
});

it('gives a rare type its own contrast range and rescales combined selections', () => {
  const data: TrafficDensity = { from: null, to: null, coveredDays: 7, factor: 1, cells: [
    { x: 0, y: 0, metres: { fishing: 10 } },
    { x: 1, y: 0, metres: { fishing: 50, sailing: 900 } },
    { x: 2, y: 0, metres: { fishing: 100 } },
    { x: 3, y: 0, metres: { cargo: 90000 } },
  ] };
  const alphas = (types: Parameters<typeof trafficRaster>[1]) => {
    const { pixels, width } = trafficRaster(data, types)!;
    return data.cells.map(({ x }) => pixels[4 * (width + 1 + x) + 3]!);
  };
  const [low, middle, high, empty] = alphas(['fishing']);
  expect(low).toBe(56);
  expect(middle).toBeGreaterThan(low!);
  expect(middle).toBeLessThan(high!);
  expect(high).toBe(230);
  expect(empty).toBe(0);
  expect(alphas([])[2]).toBeLessThan(high!);
  expect(alphas(['fishing', 'sailing'])[1]).toBe(high);
  expect(alphas(['sailing'])).toEqual([0, high, 0, 0]);
});
