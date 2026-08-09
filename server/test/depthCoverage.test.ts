import { describe, expect, it } from 'vitest';
import {
  DepthCoverage,
  clipDepthContoursOutsideOfficialCoverage,
  filterDepthSamplesOutsideOfficialCoverage,
  officialDepthCoverage,
} from '../src/depthCoverage.js';

describe('depth coverage clipping', () => {
  const square = new DepthCoverage([[[
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ]]]);

  it('uses polygon coverage, including holes', () => {
    const withHole = new DepthCoverage([[
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
    ]]);
    expect(withHole.contains([0.5, 0.5])).toBe(true);
    expect(withHole.contains([2, 2])).toBe(false);
    expect(withHole.contains([5, 2])).toBe(false);
  });

  it('splits a crossing contour and keeps only the outside pieces', () => {
    expect(square.clipLineOutside([[-1, 1], [3, 1]])).toEqual([
      [[-1, 1], [0, 1]],
      [[2, 1], [3, 1]],
    ]);
  });

  it('clips both LineString and MultiLineString GeoJSON features', () => {
    const data = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { elevation: 5 },
        geometry: { type: 'LineString', coordinates: [[19, 58], [20, 58]] },
      }],
    };
    const clipped = clipDepthContoursOutsideOfficialCoverage(data) as typeof data;
    expect(clipped.type).toBe('FeatureCollection');
    expect(clipped.features.length).toBeLessThanOrEqual(1);
  });

  it('knows the generated Estonian and Finnish coverage and removes model labels', () => {
    // Tallinna ja Helsingi lahe ametlikud sügavusalad.
    const tallinnBay: [number, number] = [24.75, 59.5];
    const helsinkiBay: [number, number] = [24.9, 60.1];
    expect(officialDepthCoverage.contains(tallinnBay)).toBe(true);
    expect(officialDepthCoverage.contains(helsinkiBay)).toBe(true);
    const samples = {
      features: [
        { geometry: { type: 'Point' as const, coordinates: tallinnBay } },
        { geometry: { type: 'Point' as const, coordinates: helsinkiBay } },
        { geometry: { type: 'Point' as const, coordinates: [19, 58] as [number, number] } },
      ],
    };
    expect(filterDepthSamplesOutsideOfficialCoverage(samples).features).toHaveLength(1);
  });
});
