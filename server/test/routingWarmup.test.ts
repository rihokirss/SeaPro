import { describe, expect, it, vi } from 'vitest';
import {
  RoutingWarmup,
  routingPrewarmTiles,
  routingTilesAround,
} from '../src/routing/warmup.js';
import { PriorityGate } from '../src/routing/sources/osm.js';

describe('routingu staatiliste paanide taustsoojendus', () => {
  it('katab Eesti, Soome lahe ja Edela-Soome ühe paani puhvriga', () => {
    const tiles = routingPrewarmTiles([57.45, 18.75, 66.2, 28.45]);
    const keys = new Set(tiles.map((tile) => tile.join(',')));

    expect(tiles).toHaveLength(64);
    expect(keys.has('59,24,60,25')).toBe(true); // Tallinn–Helsingi
    expect(keys.has('60,19,61,20')).toBe(true); // Edela-Soome
    expect(keys.has('58,27,59,28')).toBe(true); // Eesti idarannik
    expect(keys.has('64,23,65,24')).toBe(false); // Botnia lisandub kasutusest
    expect(tiles[0]).toEqual([59, 22, 60, 23]);
  });

  it('lisab kasutatud marsruudiala ümber ühe kanoonilise naaberpaani', () => {
    const tiles = routingTilesAround(
      [59.2, 24.2, 59.4, 24.4],
      [57.45, 18.75, 66.2, 28.45],
    );

    expect(tiles).toHaveLength(9);
    expect(tiles).toContainEqual([58, 23, 59, 24]);
    expect(tiles).toContainEqual([59, 24, 60, 25]);
    expect(tiles).toContainEqual([60, 25, 61, 26]);
  });

  it('ei lisa naaberpaani väljapoole konfigureeritud routinguala', () => {
    const tiles = routingTilesAround(
      [57.5, 18.8, 57.7, 19.1],
      [57.45, 18.75, 66.2, 28.45],
    );

    expect(tiles.every((tile) => tile[2] > 57.45 && tile[1] < 28.45)).toBe(true);
    expect(tiles.some((tile) => tile[2] <= 57.45 || tile[3] <= 18.75)).toBe(false);
  });

  it('lõpetab poolelioleva paani, kuid pausib järjekorra foreground-route ajal', async () => {
    const first = [59, 24, 60, 25] as const;
    const second = [59, 25, 60, 26] as const;
    const fresh = new Set<string>();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const warmup = new RoutingWarmup({
      coreTiles: () => [[...first], [...second]],
      tilesAround: () => [],
      isEstonianFresh: (tile) => fresh.has(tile.join(',')),
      isFinnishFresh: () => true,
      warmEstonian: async (tile) => {
        const key = tile.join(',');
        started.push(key);
        if (key === first.join(',')) await firstPending;
        fresh.add(key);
      },
      sweepIntervalMs: 60_000,
    });
    warmup.start({ info: vi.fn(), warn: vi.fn() });
    await vi.waitFor(() => expect(started).toEqual([first.join(',')]));

    warmup.foregroundStarted();
    releaseFirst();
    await vi.waitFor(() => expect(warmup.status().state).toBe('paused'));
    expect(started).toEqual([first.join(',')]);

    warmup.foregroundFinished();
    await vi.waitFor(() => expect(started).toEqual([first.join(','), second.join(',')]));
    await vi.waitFor(() => expect(warmup.status()).toMatchObject({
      state: 'idle', completedTiles: 2, totalTiles: 2, queuedTiles: 0,
    }));
    warmup.stop();
  });

  it('annab ühises Overpassi väravas foregroundile järjekorraeelise', async () => {
    const gate = new PriorityGate(1);
    const order: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = gate.run('background', async () => {
      order.push('background-1');
      await blocker;
    });
    await vi.waitFor(() => expect(order).toEqual(['background-1']));
    const second = gate.run('background', async () => { order.push('background-2'); });
    const foreground = gate.run('foreground', async () => { order.push('foreground'); });

    release();
    await Promise.all([first, second, foreground]);
    expect(order).toEqual(['background-1', 'foreground', 'background-2']);
  });
});
