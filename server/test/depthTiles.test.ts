import { describe, expect, it } from 'vitest';
import { depthTileBbox, depthTileUrl } from '../src/depthTiles.js';

describe('HIS depth tiles', () => {
  it('projects a Tallinn XYZ tile to L-EST97', () => {
    const bbox = depthTileBbox(12, 2329, 1202);
    expect(bbox[0]).toBeCloseTo(539557.42, 1);
    expect(bbox[1]).toBeCloseTo(6584920.64, 1);
    expect(bbox[2]).toBeCloseTo(544601.73, 1);
    expect(bbox[3]).toBeCloseTo(6589956.36, 1);
  });

  it('uses the official contour and sounding WMS layers', () => {
    const contour = new URL(depthTileUrl('contours', 12, 2329, 1202));
    const sounding = new URL(depthTileUrl('soundings', 12, 2329, 1202));
    expect(contour.searchParams.get('LAYERS')).toBe('sea_dl');
    expect(sounding.searchParams.get('LAYERS')).toBe('sea_dp');
    expect(sounding.searchParams.get('STYLES')).toBe('reduced');
    expect(contour.searchParams.get('SRS')).toBe('EPSG:3301');
    expect(contour.searchParams.get('TRANSPARENT')).toBe('true');
  });
});
