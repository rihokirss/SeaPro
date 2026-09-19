import { mkdir, readdir, stat, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
if (!process.env.DATABASE_MAINTENANCE_URL) throw new Error('DATABASE_MAINTENANCE_URL puudub');
const url = new URL(process.env.DATABASE_MAINTENANCE_URL);
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
};
const destination = process.env.DATABASE_BACKUP_DIR || '/var/backups/seapro';
const keep = Number(process.env.DATABASE_BACKUP_KEEP || 2);
if (!Number.isSafeInteger(keep) || keep < 1)
  throw new Error('DATABASE_BACKUP_KEEP peab olema positiivne täisarv');
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const p = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed: ${err}`))));
  });
}
await mkdir(destination, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(':', '-');
const base = join(destination, `seapro-${stamp}`);
await run('pg_dump', ['--format=custom', '--compress=6', '--file', `${base}.dump.tmp`]);
await run('pg_restore', ['--list', `${base}.dump.tmp`]);
await run('tar', ['-czf', `${base}.navigation.tar.gz.tmp`, '-C', join(root, 'data'), 'navigation-snapshots']);
await rename(`${base}.navigation.tar.gz.tmp`, `${base}.navigation.tar.gz`);
await rename(`${base}.dump.tmp`, `${base}.dump`);
const dumps = (await readdir(destination))
  .filter((f) => /^seapro-.*\.dump$/.test(f))
  .sort()
  .reverse();
for (const old of dumps.slice(keep)) {
  await unlink(join(destination, old));
  await unlink(join(destination, old.replace(/\.dump$/, '.navigation.tar.gz'))).catch(() => {});
}
const legacy = join(root, 'data', 'legacy-backups');
for (const directory of await readdir(legacy).catch(() => [])) {
  if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(directory)) continue;
  const path = join(legacy, directory),
    s = await stat(path);
  if (Date.now() - s.mtimeMs > 30 * 86400000) {
    const { rm } = await import('node:fs/promises');
    await rm(path, { recursive: true });
  }
}
console.log(`Backup complete: ${base}.dump (${(await stat(`${base}.dump`)).size} bytes)`);
