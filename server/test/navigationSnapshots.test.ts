import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { NavigationSnapshots } from '../src/navigation/snapshots.js';

const DAY = 86_400;
const valid = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

describe('navigatsiooni püsikoopiad', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'seapro-navigation-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
    cache.delete('legacy-navigation-test');
  });

  it('säilitab kuudevanuse koopia restartide ja tõrgete ajal ning uuendab taastumisel', async () => {
    const first = new NavigationSnapshots(directory);
    const saved = await first.get('aids', DAY, async () => ['old'], valid);
    const files = await readdir(directory);
    const originalFile = await readFile(join(directory, files[0]!), 'utf8');
    vi.setSystemTime(Date.now() + 90 * DAY * 1000);
    const restarted = new NavigationSnapshots(directory);
    const failed = vi.fn(async (): Promise<string[]> => { throw new Error('403'); });
    const [a, b] = await Promise.all([
      restarted.get('aids', DAY, failed, valid),
      restarted.get('aids', DAY, failed, valid),
    ]);
    expect(a).toEqual({ ...saved, stale: true });
    expect(b).toEqual(a);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, files[0]!), 'utf8')).toBe(originalFile);
    expect(await restarted.get('aids', DAY, failed, valid)).toEqual(a);
    expect(failed).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 301_000);
    const fresh = await restarted.get('aids', DAY, async () => ['new'], valid);
    expect(fresh).toMatchObject({ value: ['new'], stale: false });
    expect(fresh.storedAt).toBeGreaterThan(saved.storedAt);
    const noNetwork = vi.fn(async () => ['unexpected']);
    expect(await new NavigationSnapshots(directory).get('aids', DAY, noNetwork, valid)).toEqual(fresh);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('vigane vastus ei kirjuta viimast edukat koopiat üle', async () => {
    const store = new NavigationSnapshots(directory);
    await store.get('aids', DAY, async () => ['safe'], valid);
    vi.setSystemTime(Date.now() + 2 * DAY * 1000);
    const result = await store.get('aids', DAY, async () => ({ error: 'upstream' }) as unknown as string[], valid);
    expect(result).toMatchObject({ value: ['safe'], stale: true });
    expect((await new NavigationSnapshots(directory).get('aids', DAY, async () => {
      throw new Error('offline');
    }, valid)).value).toEqual(['safe']);
  });

  it('eristab tühja edukat ala tõrkest ja piirab ka esimese laadimise kordusi', async () => {
    const store = new NavigationSnapshots(directory);
    const failed = vi.fn(async (): Promise<string[]> => { throw new Error('offline'); });
    await expect(store.get('aids', DAY, failed, valid)).rejects.toThrow('offline');
    await expect(store.get('aids', DAY, failed, valid)).rejects.toThrow('offline');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
    vi.setSystemTime(Date.now() + 301_000);
    expect(await store.get('aids', DAY, async () => [], valid)).toMatchObject({ value: [], stale: false });
  });

  it('säilitab üldise vahemälu olemasoleva kirje koos algse ajaga', async () => {
    cache.set('legacy-navigation-test', DAY, ['legacy']);
    const storedAt = Date.now();
    vi.setSystemTime(Date.now() + 2 * DAY * 1000);
    const failed = async (): Promise<string[]> => { throw new Error('offline'); };
    expect(await new NavigationSnapshots(directory).get('legacy-navigation-test', DAY, failed, valid))
      .toEqual({ value: ['legacy'], storedAt, stale: true });
    cache.delete('legacy-navigation-test');
    expect(await new NavigationSnapshots(directory).get('legacy-navigation-test', DAY, failed, valid))
      .toEqual({ value: ['legacy'], storedAt, stale: true });
  });

  it('taastub rikutud kettakoopiast', async () => {
    await new NavigationSnapshots(directory).get('aids', DAY, async () => ['old'], valid);
    const [file] = await readdir(directory);
    await writeFile(join(directory, file!), '{truncated');
    expect(await new NavigationSnapshots(directory).get('aids', DAY, async () => ['recovered'], valid))
      .toMatchObject({ value: ['recovered'], stale: false });
  });
});
