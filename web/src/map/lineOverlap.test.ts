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
      [traffic([[24, 59.5], [24.01, 59.5005]])],
      25,
    );

    expect(result?.type).toBe('LineString');
    if (result?.type !== 'LineString') return;
    // Algus kattub, kuid ligi 6° all lahknev OpenSeaMapi lõik ei tohi
    // Transpordiameti ülejäänud joont kaasa kustutada.
    expect(result.coordinates[0]![0]).toBeGreaterThan(24);
    expect(result.coordinates[0]![0]).toBeLessThan(24.01);
    expect(result.coordinates.at(-1)).toEqual([24.02, 59.5]);
  });

  it('eemaldab Kopli lahe 40 m nihkega OpenSeaMapi dubleti täielikult', () => {
    const result = fairwayVisibleGeometry(
      fairway([
        [24.5430449, 59.4998681],
        [24.6535713, 59.4475651],
      ]),
      [traffic([
        [24.6535667, 59.4475667],
        [24.6515556, 59.4485278],
        [24.5441667, 59.4998333],
      ])],
    );

    expect(result).toBeNull();
  });

  it('säilitab tervikliku unikaalse lühikese registrilõigu', () => {
    const original = fairway([[24, 59.5], [24.0002, 59.5]]);
    expect(fairwayVisibleGeometry(
      original,
      [traffic([[25, 59.5], [25.01, 59.5]])],
    )).toEqual(original);
  });

  it('jätab OpenSeaMapist puuduva Transpordiameti joone tervikuna alles', () => {
    const original = fairway([[24, 59.5], [24.02, 59.5]]);
    expect(fairwayVisibleGeometry(original, [])).toEqual(original);
  });
});
