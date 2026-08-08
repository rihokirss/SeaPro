import { describe, expect, it } from 'vitest';
import type { RoutingCostSurface, RoutingReasonCode } from '../src/routing/costSurface.js';
import type { RouteRisk } from '../src/routing/engineTypes.js';
import { describeRouteGeometry } from '../src/routing/segments.js';

describe('route risk segmentation', () => {
  it('keeps a narrow unknown band separate inside one simplified edge', () => {
    const surface = lineSurface([
      ['clear', []],
      ['clear', []],
      ['unknown', ['depth_unknown']],
      ['unknown', ['depth_unknown']],
      ['clear', []],
      ['clear', []],
      ['clear', []],
    ]);

    const described = describeRouteGeometry(surface, [{ x: 0, y: 0 }, { x: 6, y: 0 }]);

    expect(described.segments.map((segment) => segment.assessment))
      .toEqual(['clear', 'unknown', 'clear']);
    expect(described.segments[1]!.reasons).toEqual(['depth_unknown']);
    expect(described.coordinates).toHaveLength(4);
    expect(described.segments[1]!.to[0] - described.segments[1]!.from[0]).toBeLessThan(3);
    expect(described.segments[0]!.to).toEqual(described.segments[1]!.from);
    expect(described.segments[1]!.to).toEqual(described.segments[2]!.from);
  });

  it('interpolates segment boundaries between exact overridden endpoint positions', () => {
    const surface = lineSurface([
      ['clear', []],
      ['unknown', ['depth_unknown']],
      ['clear', []],
    ]);
    const regularToPosition = surface.toPosition;
    surface.toPosition = (point) => {
      if (point.x === 0 && point.y === 0) return [100, 10];
      if (point.x === 2 && point.y === 0) return [102, 12];
      return regularToPosition(point);
    };

    const described = describeRouteGeometry(surface, [{ x: 0, y: 0 }, { x: 2, y: 0 }]);

    expect(described.coordinates).toEqual([
      [100, 10],
      [100.5, 10.5],
      [101.5, 11.5],
      [102, 12],
    ]);
  });

  it('retains several exact harbour turns that share one coarse grid cell', () => {
    const surface = lineSurface([
      ['clear', []],
      ['clear', []],
      ['clear', []],
    ]);

    const described = describeRouteGeometry(surface, [
      { x: 0, y: 0, position: [0, 0] },
      { x: 1, y: 0, position: [0.8, 0] },
      { x: 1, y: 0, position: [1, 0.2] },
      { x: 1, y: 0, position: [1.2, 0.1] },
      { x: 2, y: 0, position: [2, 0] },
    ]);

    expect(described.coordinates).toEqual([
      [0, 0],
      [0.8, 0],
      [1, 0.2],
      [1.2, 0.1],
      [2, 0],
    ]);
  });
});

function lineSurface(
  cells: Array<[risk: RouteRisk, reasons: RoutingReasonCode[]]>,
): RoutingCostSurface {
  return {
    width: cells.length,
    height: 1,
    minimumCostMultiplier: 1,
    requiredDepthM: 2,
    projection: {
      bbox: [0, 0, 1, cells.length],
      width: cells.length,
      height: 1,
      cellSizeM: 1,
      lonStep: 1,
      latStep: 1,
      metresPerLongitudeDegree: 1,
    },
    cellAt(x) {
      const [risk, reasons] = cells[x]!;
      return { blocked: false, costMultiplier: risk === 'unknown' ? 25 : 1, risk, reasons };
    },
    toGrid(point) {
      return { x: point.lon, y: point.lat };
    },
    toPosition(point) {
      return [point.x, point.y];
    },
    detailsAt(x) {
      const [risk, reasons] = cells[x]!;
      return {
        blocked: false,
        risk,
        costMultiplier: risk === 'unknown' ? 25 : 1,
        reasons,
        sourceIds: risk === 'unknown' ? ['emodnet-depth'] : [],
        depthM: risk === 'unknown' ? null : 8,
      };
    },
  };
}
