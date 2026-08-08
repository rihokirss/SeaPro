import { describe, expect, it } from 'vitest';
import type { Fairway, TrafficScheme } from '@seapro/shared';
import { fairwayVisibleGeometry } from './lineOverlap';

const fairway = (coordinates: [number, number][]): Fairway['geometry'] => ({
  type: 'LineString',
  coordinates,
});

const traffic = (coordinates: [number, number][]): TrafficScheme => ({
  id: 'osm-test',
  kind: 'recommended_track',
  geometry: { type: 'LineString', coordinates },
});

describe('ametliku laevatee ja OpenSeaMapi kattuvus', () => {
  it('säilitab ametliku joone mõlemad unikaalsed otsad', () => {
    const result = fairwayVisibleGeometry(
      fairway([[24, 59.5], [24.02, 59.5]]),
      [traffic([[24.005, 59.50005], [24.015, 59.50005]])],
      10,
    );

    expect(result?.type).toBe('MultiLineString');
    if (result?.type !== 'MultiLineString') return;
    expect(result.coordinates).toHaveLength(2);
    expect(result.coordinates[0]![0]).toEqual([24, 59.5]);
    expect(result.coordinates[1]!.at(-1)).toEqual([24.02, 59.5]);
  });

  it('ei loe ristuvat joont dubletiks', () => {
    const original = fairway([[24, 59.5], [24.02, 59.5]]);
    const result = fairwayVisibleGeometry(
      original,
      [traffic([[24.01, 59.49], [24.01, 59.51]])],
    );

    expect(result).toEqual(original);
  });

  it('eemaldab lahknevatest joontest ainult tolerantsi sisse jääva osa', () => {
    const result = fairwayVisibleGeometry(
      fairway([[24, 59.5], [24.02, 59.5]]),
      [traffic([[24, 59.5], [24.01, 59.501]])],
      25,
    );

    expect(result?.type).toBe('LineString');
    if (result?.type !== 'LineString') return;
    // Algus kattub, kuid ligi 20° all lahknev OpenSeaMapi lõik ei tohi
    // Transpordiameti ülejäänud joont kaasa kustutada.
    expect(result.coordinates[0]![0]).toBeGreaterThan(24);
    expect(result.coordinates[0]![0]).toBeLessThan(24.01);
    expect(result.coordinates.at(-1)).toEqual([24.02, 59.5]);
  });

  it('jätab OpenSeaMapist puuduva Transpordiameti joone tervikuna alles', () => {
    const original = fairway([[24, 59.5], [24.02, 59.5]]);
    expect(fairwayVisibleGeometry(original, [])).toEqual(original);
  });
});
