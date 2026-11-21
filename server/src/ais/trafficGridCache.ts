import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { gunzip, gzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);

/** The archive is authoritative. A missing, obsolete or damaged file is rebuilt from it. */
export async function cachedTrafficGrid(directory: string, key: string, revision: string, load: () => Promise<Float64Array>) {
  const file = join(directory, key + '.gz');
  try {
    const saved = deserialize(await decompress(await readFile(file)));
    if (saved.revision === revision && saved.grid instanceof Float64Array && saved.grid.length % 2 === 0)
      return saved.grid as Float64Array;
  } catch {
    // A cache miss also covers interrupted transfers and incompatible serialization versions.
  }
  const grid = await load();
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await mkdir(directory, { recursive: true });
    const bytes = await compress(serialize({ revision, grid }), { level: 1 });
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return grid;
}

export async function pruneTrafficGrids(directory: string, oldestDay: string) {
  for (const name of await readdir(directory).catch(() => [])) {
    const date = /^(\d{4}-\d{2}(?:-\d{2})?)\.gz$/.exec(name)?.[1];
    if (date && date < oldestDay.slice(0, date.length))
      await rm(join(directory, name), { force: true });
  }
}
