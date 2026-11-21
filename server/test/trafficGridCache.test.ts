import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { cachedTrafficGrid, pruneTrafficGrids } from '../src/ais/trafficGridCache.js';

it('reuses saved grids, rebuilding revised or damaged days and pruning expired files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seapro-grids-'));
  try {
    const load = vi.fn(async () => Float64Array.of(3189772456, 5.5));
    const read = (revision: string) => cachedTrafficGrid(directory, '2026-09-01', revision, load);
    expect([...await read('first')]).toEqual([...await read('first')]);
    expect(load).toHaveBeenCalledTimes(1);
    load.mockResolvedValue(Float64Array.of(3189772456, 7.25));
    expect([...await read('second')]).toEqual([3189772456, 7.25]);
    await writeFile(join(directory, '2026-09-01.gz'), 'damaged');
    expect([...await read('second')]).toEqual([3189772456, 7.25]);
    expect(load).toHaveBeenCalledTimes(3);
    await cachedTrafficGrid(directory, '2026-09', 'month', load);
    await pruneTrafficGrids(directory, '2026-09-02');
    expect(await readdir(directory)).toEqual(['2026-09.gz']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
