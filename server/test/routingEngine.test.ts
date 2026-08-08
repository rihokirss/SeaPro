import { describe, expect, it } from 'vitest';
import type { GridPoint, RoutingCell, RoutingGrid } from '../src/routing/engineTypes.js';
import { ROUTING_COST_MULTIPLIERS } from '../src/routing/engineTypes.js';
import { snapEndpoint } from '../src/routing/grid.js';
import { findHierarchicalPath, findPath } from '../src/routing/search.js';
import { compressRiskSegments, hasLineOfSight, simplifyPath, validatePath } from '../src/routing/simplify.js';

const CELLS: Record<string, RoutingCell> = {
  '.': { blocked: false, costMultiplier: ROUTING_COST_MULTIPLIERS.clear, risk: 'clear' },
  p: { blocked: false, costMultiplier: ROUTING_COST_MULTIPLIERS.preferred, risk: 'clear', reasons: ['preferred'] },
  c: { blocked: false, costMultiplier: ROUTING_COST_MULTIPLIERS.lowClearance, risk: 'caution', reasons: ['low_clearance'] },
  w: { blocked: false, costMultiplier: ROUTING_COST_MULTIPLIERS.lowClearance, risk: 'caution', reasons: ['structure_unverified'] },
  '?': { blocked: false, costMultiplier: ROUTING_COST_MULTIPLIERS.unknown, risk: 'unknown', reasons: ['no_depth_data'] },
  '#': { blocked: true, costMultiplier: 1, risk: 'clear', reasons: ['land'] },
  s: { blocked: true, costMultiplier: 1, risk: 'caution', reasons: ['insufficient_depth'] },
  r: { blocked: true, costMultiplier: 1, risk: 'caution', reasons: ['rock_buffer'] },
};

function makeGrid(rows: readonly string[]): RoutingGrid {
  if (rows.length === 0 || rows.some((row) => row.length !== rows[0]!.length)) throw new Error('Bad test grid');
  return {
    width: rows[0]!.length,
    height: rows.length,
    minimumCostMultiplier: ROUTING_COST_MULTIPLIERS.preferred,
    cellAt(x, y) {
      const symbol = rows[y]?.[x];
      const cell = symbol == null ? undefined : CELLS[symbol];
      if (cell == null) throw new Error(`Unknown test cell ${String(symbol)}`);
      return cell;
    },
  };
}

function points(result: Awaited<ReturnType<typeof findPath>>): readonly GridPoint[] {
  expect(result.status).toBe('found');
  if (result.status !== 'found') throw new Error(result.reason);
  return result.path;
}

describe('routing A*', () => {
  it('finds a deterministic hierarchical route around an island', async () => {
    const grid = makeGrid([
      '.............',
      '....#####....',
      '....#####....',
      '....#####....',
      '....#####....',
      '....#####....',
      '.............',
    ]);
    const start = { x: 1, y: 3 };
    const goal = { x: 11, y: 3 };
    const first = await findHierarchicalPath(grid, start, goal, { coarseFactor: 3 });
    const second = await findHierarchicalPath(grid, start, goal, { coarseFactor: 3 });
    expect(first).toEqual(second);
    expect(first.status).toBe('found');
    if (first.status !== 'found') return;
    expect(first.path.some((point) => point.y === 0 || point.y === 6)).toBe(true);
    expect(validatePath(grid, first.path).valid).toBe(true);
  });

  it('treats shallow water and buffered rocks as hard blocks', async () => {
    const grid = makeGrid([
      '.........',
      '....s....',
      '..s.r.s..',
      '....s....',
      '.........',
    ]);
    const route = points(await findPath(grid, { x: 0, y: 2 }, { x: 8, y: 2 }));
    for (const blocked of [
      { x: 4, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 2 }, { x: 6, y: 2 }, { x: 4, y: 3 },
    ]) expect(route).not.toContainEqual(blocked);
    expect(route.every((point) => !grid.cellAt(point.x, point.y).blocked)).toBe(true);
    expect(validatePath(grid, route).valid).toBe(true);
  });

  it('never cuts diagonally between touching blocked cells', async () => {
    const grid = makeGrid(['.#', '#.']);
    const result = await findPath(grid, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(result).toMatchObject({ status: 'not_found', reason: 'no_route' });
    expect(hasLineOfSight(grid, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });

  it('avoids unknown high-cost water when a safe detour exists', async () => {
    const grid = makeGrid([
      '.......',
      '.......',
      '.?????.',
      '.......',
      '.......',
    ]);
    const route = points(await findPath(grid, { x: 0, y: 2 }, { x: 6, y: 2 }));
    expect(route.slice(1, -1).every((point) => grid.cellAt(point.x, point.y).risk === 'clear')).toBe(true);
    expect(route.some((point) => point.y !== 2)).toBe(true);
  });

  it('prefers a slightly longer recommended corridor', async () => {
    const grid = makeGrid([
      '...........',
      '.ppppppppp.',
      '...........',
      '...........',
    ]);
    const route = points(await findPath(grid, { x: 0, y: 2 }, { x: 10, y: 2 }));
    expect(route.filter((point) => point.y === 1).length).toBeGreaterThanOrEqual(7);
  });

  it('returns no_route when a hard barrier separates the endpoints', async () => {
    const grid = makeGrid(['...#...', '...#...', '...#...']);
    await expect(findPath(grid, { x: 0, y: 1 }, { x: 6, y: 1 }))
      .resolves.toMatchObject({ status: 'not_found', reason: 'no_route' });
  });

  it('enforces abort, timeout and expanded-node caps', async () => {
    const grid = makeGrid(Array.from({ length: 20 }, () => '.'.repeat(20)));

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(findPath(grid, { x: 0, y: 0 }, { x: 19, y: 19 }, { signal: preAborted.signal }))
      .resolves.toMatchObject({ status: 'not_found', reason: 'aborted', expandedNodes: 0 });

    await expect(findPath(grid, { x: 0, y: 0 }, { x: 19, y: 19 }, { maxExpandedNodes: 2 }))
      .resolves.toMatchObject({ status: 'not_found', reason: 'node_limit', expandedNodes: 2 });

    let time = 0;
    await expect(findPath(grid, { x: 0, y: 0 }, { x: 19, y: 19 }, {
      timeoutMs: 2,
      clock: () => time++,
    })).resolves.toMatchObject({ status: 'not_found', reason: 'timeout' });

    const duringSearch = new AbortController();
    await expect(findPath(grid, { x: 0, y: 0 }, { x: 19, y: 19 }, {
      signal: duringSearch.signal,
      yieldEvery: 1,
      yieldControl: async () => { duringSearch.abort(); },
    })).resolves.toMatchObject({ status: 'not_found', reason: 'aborted', expandedNodes: 1 });
  });
});

describe('route post-processing', () => {
  it('string-pulls open water to endpoints and revalidates the result', async () => {
    const grid = makeGrid(Array.from({ length: 8 }, () => '.'.repeat(12)));
    const route = points(await findPath(grid, { x: 0, y: 1 }, { x: 11, y: 6 }));
    const simplified = simplifyPath(grid, route);
    expect(simplified).toEqual([{ x: 0, y: 1 }, { x: 11, y: 6 }]);
    expect(validatePath(grid, simplified).valid).toBe(true);
  });

  it('irons out refraction jinks at cost boundaries only with an absolute allowance', () => {
    // 5x rada (c) keskel: võreotsing ületab selle "murdudes" järsema nurga
    // all. Ilma absoluutse varuta jääb V-jõnks alles, sest sirge lõikab rada
    // pikemalt; väike varu lubab sirgeks tõmmata, riskiklass ei muutu.
    const grid = makeGrid([
      '.......',
      '.......',
      'ccccccc',
      'ccccccc',
      '.......',
      '.......',
      '.......',
    ]);
    const route = [
      { x: 0, y: 6 },
      { x: 2, y: 4 },
      { x: 2, y: 1 },
      { x: 6, y: 0 },
    ];
    expect(validatePath(grid, route).valid).toBe(true);
    expect(simplifyPath(grid, route).length).toBeGreaterThan(2);
    const smoothed = simplifyPath(grid, route, { maxCostIncrease: 10 });
    expect(smoothed).toEqual([{ x: 0, y: 6 }, { x: 6, y: 0 }]);
    expect(validatePath(grid, smoothed).valid).toBe(true);
  });

  it('retains required harbour gate points while string-pulling', () => {
    const grid = makeGrid(['...', '...', '...']);
    const gate = { x: 2, y: 0 };
    const route = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      gate,
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ];

    expect(simplifyPath(grid, route, { requiredPoints: [gate] })).toEqual([
      { x: 0, y: 0 },
      gate,
      { x: 2, y: 2 },
    ]);
  });

  it('does not simplify a safe detour through unknown high-cost cells', async () => {
    const grid = makeGrid([
      '.......',
      '.......',
      '.?????.',
      '.......',
    ]);
    const route = points(await findPath(grid, { x: 0, y: 2 }, { x: 6, y: 2 }));
    const simplified = simplifyPath(grid, route);
    expect(simplified.length).toBeGreaterThan(2);
    expect(validatePath(grid, simplified).totalCost).toBeLessThan(20);
  });

  it('does not introduce a different hazard reason from the same broad risk class', () => {
    const grid = makeGrid(['ccc', '.w.']);
    const route = [{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }];
    const simplified = simplifyPath(grid, route, { maxCostRatio: 2, preserveRisk: true });
    expect(simplified).not.toEqual([{ x: 0, y: 1 }, { x: 2, y: 1 }]);
    expect(validatePath(grid, simplified).valid).toBe(true);
  });

  it('compresses adjacent equal risk cells and normalises reasons', () => {
    const grid = makeGrid(['..cc??.']);
    const segments = compressRiskSegments(grid, [{ x: 0, y: 0 }, { x: 6, y: 0 }]);
    expect(segments.map(({ risk, reasons, cellCount }) => ({ risk, reasons, cellCount }))).toEqual([
      { risk: 'clear', reasons: [], cellCount: 2 },
      { risk: 'caution', reasons: ['low_clearance'], cellCount: 2 },
      { risk: 'unknown', reasons: ['no_depth_data'], cellCount: 2 },
      { risk: 'clear', reasons: [], cellCount: 1 },
    ]);
  });
});

describe('endpoint snapping', () => {
  it('snaps to the nearest traversable cell with deterministic tie-breaking', () => {
    const grid = makeGrid(['...', '.#.', '...']);
    expect(snapEndpoint(grid, { x: 1, y: 1 }, { maxDistanceCells: 1 })).toMatchObject({
      point: { x: 1, y: 0 },
      distanceCells: 1,
      shifted: true,
    });
    expect(snapEndpoint(grid, { x: 1, y: 1 }, { maxDistanceCells: 0.5 })).toBeNull();
  });

  it('can skip a locally isolated open cell when the caller requires connectivity', () => {
    const grid = makeGrid([
      '.....',
      '.###.',
      '.#.#.',
      '.###.',
      '.....',
    ]);
    const result = snapEndpoint(grid, { x: 2, y: 2 }, {
      maxDistanceCells: 3,
      allowed: (point) => !(point.x === 2 && point.y === 2),
    });

    expect(result?.point).not.toEqual({ x: 2, y: 2 });
    expect(result?.distanceCells).toBeGreaterThan(1);
  });
});
