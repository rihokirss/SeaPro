import { describe, expect, it } from 'vitest';
import type { RoutingDepthRaster } from '../src/routing/depthRaster.js';
import {
  RoutingDepthState,
  routingDepthAt,
} from '../src/routing/depthRaster.js';
import { routingWaterAt, type RoutingWaterMask } from '../src/routing/waterMask.js';

describe('routing raster data', () => {
  it('keeps water, land and missing depth distinct', () => {
    const raster: RoutingDepthRaster = {
      bbox: [24, 59, 26, 61], width: 2, height: 2,
      depths: new Float32Array([10, Number.NaN, Number.NaN, 3]),
      states: new Uint8Array([
        RoutingDepthState.Water, RoutingDepthState.NoData,
        RoutingDepthState.Land, RoutingDepthState.Water,
      ]),
      source: {
        id: 'fixture', fetchedAt: new Date(0).toISOString(), ageSeconds: 0,
        stale: false, coverage: 'complete',
      },
    };

    expect(routingDepthAt(raster, 24.2, 60.8)).toEqual({ state: RoutingDepthState.Water, depthM: 10 });
    expect(routingDepthAt(raster, 25.2, 60.8)).toEqual({ state: RoutingDepthState.NoData, depthM: null });
    expect(routingDepthAt(raster, 24.2, 59.2)).toEqual({ state: RoutingDepthState.Land, depthM: null });
    expect(routingDepthAt(raster, 30, 70)).toEqual({ state: RoutingDepthState.NoData, depthM: null });
  });

  it('uses vector water polygons and respects islands/holes', () => {
    const mask: RoutingWaterMask = {
      zoom: 0,
      tiles: new Map([['0:0', { polygons: [[
        [[20, 55], [30, 55], [30, 65], [20, 65], [20, 55]],
        [[24, 59], [26, 59], [26, 61], [24, 61], [24, 59]],
      ]] }]]),
      source: {
        id: 'fixture', fetchedAt: new Date(0).toISOString(), ageSeconds: 0,
        stale: false, coverage: 'complete',
      },
    };

    expect(routingWaterAt(mask, 22, 60)).toBe(true);
    expect(routingWaterAt(mask, 25, 60)).toBe(false);
    expect(routingWaterAt(mask, 10, 60)).toBe(false);
  });

  it('returns unknown when a vector tile failed to load', () => {
    const mask: RoutingWaterMask = {
      zoom: 0, tiles: new Map([['0:0', null]]),
      source: {
        id: 'fixture', fetchedAt: new Date(0).toISOString(), ageSeconds: 0,
        stale: false, coverage: 'missing',
      },
    };
    expect(routingWaterAt(mask, 25, 60)).toBeNull();
  });
});
