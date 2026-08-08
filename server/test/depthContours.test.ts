import { describe, expect, it } from 'vitest';
import {
  depthContourUrl,
  depthCoverageUrl,
  depthSampleGrid,
  depthSampleUrl,
  snapDepthContourBbox,
  smoothContourLine,
} from '../src/depthContours.js';

describe('EMODnet depth contours', () => {
  it('requests GeoJSON vectors for the visible bbox', () => {
    const url = new URL(depthContourUrl([24.5, 59.3, 25, 59.6]));
    expect(url.origin + url.pathname).toBe('https://ows.emodnet-bathymetry.eu/wfs');
    expect(url.searchParams.get('request')).toBe('GetFeature');
    expect(url.searchParams.get('typeNames')).toBe('emodnet:contours');
    expect(url.searchParams.get('bbox')).toBe('24.5,59.3,25,59.6,EPSG:4326');
    expect(url.searchParams.get('outputFormat')).toBe('application/json');
  });

  it('creates a stable sparse sample grid only at close zooms', () => {
    expect(depthSampleGrid([24.5, 59.3, 25, 59.6], 11)).toEqual([]);
    const points = depthSampleGrid([24.5, 59.3, 25, 59.6], 12);
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(80);
    expect(depthSampleGrid([24.51, 59.31, 25, 59.6], 12)[0]).toEqual(points[0]);
  });

  it('encodes a DTM point request as WKT', () => {
    const url = new URL(depthSampleUrl(24.75, 59.5));
    expect(url.searchParams.get('geom')).toBe('POINT(24.75 59.5)');
  });

  it('requests the native-resolution DTM around a grid-snapped padded area', () => {
    const bbox = snapDepthContourBbox([24.60313, 59.44867, 24.60716, 59.45338]);
    expect(bbox[0]).toBeLessThan(24.60313);
    expect(bbox[3]).toBeGreaterThan(59.45338);
    const url = new URL(depthCoverageUrl(bbox));
    expect(url.searchParams.get('request')).toBe('GetCoverage');
    expect(url.searchParams.get('coverage')).toBe('emodnet:mean');
    expect(url.searchParams.get('format')).toBe('GeoTIFF');
  });

  it('can request a land-inclusive coarser raster for route planning', () => {
    const url = new URL(depthCoverageUrl([24, 59, 25, 60], {
      coverage: 'emodnet:mean_atlas_land',
      resolution: 0.01,
    }));
    expect(url.searchParams.get('coverage')).toBe('emodnet:mean_atlas_land');
    expect(url.searchParams.get('resx')).toBe('0.01');
    expect(url.searchParams.get('resy')).toBe('0.01');
  });

  it('smooths actual contour geometry while preserving open endpoints', () => {
    const original = [[0, 0], [1, 0], [1, 1]];
    const smoothed = smoothContourLine(original, 1);
    expect(smoothed[0]).toEqual(original[0]);
    expect(smoothed.at(-1)).toEqual(original.at(-1));
    expect(smoothed).toEqual([
      [0, 0],
      [0.25, 0],
      [0.75, 0],
      [1, 0.25],
      [1, 0.75],
      [1, 1],
    ]);
  });
});
