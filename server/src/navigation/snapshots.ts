import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { NavigationAid } from '@seapro/shared';
import { Cache, cache, DATA_DIR } from '../cache.js';

interface Snapshot<T> {
  value: T;
  storedAt: number;
}

export interface NavigationSnapshot<T> extends Snapshot<T> {
  stale: boolean;
}

/** Registri viimane edukas vastus säilib kettal tähtajatult, ka LRU koristuse järel. */
export class NavigationSnapshots {
  private readonly memory = new Cache({ maxMemoryBytes: 16 * 1024 * 1024 });

  constructor(private readonly directory = join(DATA_DIR, 'navigation-snapshots')) {}

  async get<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    valid: (value: unknown) => value is T,
  ): Promise<NavigationSnapshot<T>> {
    // Üks võrgupäring võtme kohta; tõrke järel uus katse kõige varem 5 min pärast.
    const { value: result } = await this.memory.get<
      { snapshot: Snapshot<T> } | { error: unknown }
    >(key, 300, async () => {
      const file = join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
      let backup: Snapshot<T> | undefined;
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        if (saved.version === 1 && saved.key === key && Number.isFinite(saved.storedAt)
          && saved.storedAt > 0 && valid(saved.value)) {
          backup = { value: saved.value, storedAt: saved.storedAt };
        }
      } catch {
        // Puuduv/rikutud koopia ei takista allikast uuesti laadimist.
      }

      // Säilita ka enne seda muudatust üldisesse vahemällu jõudnud vastused.
      if (!backup) {
        const previous = cache.peek<T>(key);
        if (previous && valid(previous.value)) {
          backup = { value: previous.value, storedAt: Date.now() - previous.ageSeconds * 1000 };
          await this.save(file, key, backup);
        }
      }
      if (backup && Date.now() - backup.storedAt < ttlSeconds * 1000) return { snapshot: backup };

      try {
        const value = await loader();
        if (!valid(value)) throw new Error('Navigatsiooniandmete vastus on vigane');
        const fresh = { value, storedAt: Date.now() };
        await this.save(file, key, fresh);
        return { snapshot: fresh };
      } catch (error) {
        return backup ? { snapshot: backup } : { error };
      }
    });
    if ('error' in result) throw result.error;
    const { snapshot } = result;
    return { ...snapshot, stale: Date.now() - snapshot.storedAt >= ttlSeconds * 1000 };
  }

  private async save<T>(file: string, key: string, snapshot: Snapshot<T>): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, key, ...snapshot }), 'utf8');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export const navigationSnapshots = new NavigationSnapshots();

export function snapshotAids(
  aids: NavigationAid[],
  snapshot: NavigationSnapshot<unknown>,
): NavigationAid[] {
  return aids.map((aid) => ({
    ...aid,
    registryFetchedAt: new Date(snapshot.storedAt).toISOString(),
    registryStale: snapshot.stale,
  }));
}

export function isNavigationAidArray(value: unknown): value is NavigationAid[] {
  return Array.isArray(value) && value.every((aid) => aid && typeof aid.id === 'string'
    && typeof aid.name === 'string' && Array.isArray(aid.sources)
    && Number.isFinite(aid.lat) && Math.abs(aid.lat) <= 90
    && Number.isFinite(aid.lon) && Math.abs(aid.lon) <= 180);
}
