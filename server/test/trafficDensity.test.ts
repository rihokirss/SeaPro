import { expect, it } from 'vitest';
import { trafficLat, trafficLon, trafficType } from '@seapro/shared';
import { addTrafficLine, packTrafficGrid, trafficView } from '../src/ais/trafficDensity.js';

function view(grid: Map<number, number>, left: number, right: number) {
  const entries = packTrafficGrid(grid);
  return trafficView({ from: '2026-10-01', to: '2026-10-07', coveredDays: 6, chunks: [entries] },
    [trafficLat(11895), trafficLon(left), trafficLat(11890), trafficLon(right)]);
}

it('splits a crossing at every cell boundary, conserving distance in both directions', () => {
  const grid = new Map<number, number>();
  const lat = trafficLat(11892.5);
  const a: [number, number] = [trafficLon(23000.25), lat], b: [number, number] = [trafficLon(23002.75), lat];
  addTrafficLine(grid, [a, b], 'cargo', 1000);
  addTrafficLine(grid, [b, a], 'passenger', 2000);
  addTrafficLine(grid, [a, a], 'other', 5);
  for (const y of [11888, 11900]) {
    const outside: [number, number] = [a[0], trafficLat(y)];
    addTrafficLine(grid, [outside, outside], 'cargo', 500);
  }
  const { cells, factor } = view(grid, 23000, 23003);
  expect(factor).toBe(1);
  expect(cells.map(c => c.metres)).toEqual([
    { cargo: 300, passenger: 600, other: 5 }, { cargo: 400, passenger: 800 }, { cargo: 300, passenger: 600 },
  ]);
  expect(view(grid, 23000 + 40960, 23003 + 40960).cells).toEqual(cells);
});

it('merges full cells at overview zoom and keeps types separate', () => {
  const grid = new Map<number, number>();
  const a: [number, number] = [trafficLon(23000.5), trafficLat(11892.5)];
  const b: [number, number] = [trafficLon(23001.5), a[1]];
  addTrafficLine(grid, [a, b], 'cargo', 1000);
  addTrafficLine(grid, [b, b], 'other', 50);
  expect(view(grid, 23000, 23300)).toMatchObject({
    factor: 2, coveredDays: 6, cells: [{ x: 11500, y: 5946, metres: { cargo: 1000, other: 50 } }],
  });
  expect(trafficType(79)).toBe('cargo');
});

it('preloads neighbouring cells for panning without changing the grid resolution', () => {
  const grid = new Map<number, number>();
  const bounds: [number, number, number, number] = [
    trafficLat(11900), trafficLon(23000), trafficLat(11800), trafficLon(23170),
  ];
  for (const x of [22970, 23080, 23220]) {
    const p: [number, number] = [trafficLon(x + 0.5), trafficLat(11850.5)];
    addTrafficLine(grid, [p, p], 'fishing', 300);
  }
  const snapshot = { from: null, to: null, coveredDays: 1, chunks: [packTrafficGrid(grid)] };
  expect(trafficView(snapshot, bounds).cells.map(c => c.x)).toEqual([23080]);
  const buffered = trafficView(snapshot, bounds, true);
  expect(buffered.factor).toBe(1);
  expect(buffered.cells.map(c => c.x)).toEqual([22970, 23080]);
});
