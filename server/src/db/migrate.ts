import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { dataDirectory, DAY } from './config.js';

export async function ensurePartitions(client: pg.PoolClient, start = Date.now(), days = 14) {
  for (let n = 0; n <= days; n++) {
    const day = new Date(start + n * DAY).toISOString().slice(0, 10);
    const next = new Date(Date.parse(day) + DAY).toISOString().slice(0, 10);
    if (
      (await client.query('SELECT 1 FROM history_jobs WHERE day=$1 AND packed_at IS NOT NULL', [day]))
        .rowCount
    )
      continue;
    const table = `ais_points_${day.replaceAll('-', '')}`;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} PARTITION OF ais_points FOR VALUES FROM ('${day}') TO ('${next}')`,
    );
    await client.query('INSERT INTO history_partitions(day) VALUES($1) ON CONFLICT DO NOTHING', [day]);
  }
}
export async function migrate(url = process.env.DATABASE_MAINTENANCE_URL ?? process.env.DATABASE_URL) {
  const pool = new pg.Pool({ options: '-c timezone=UTC', connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(73521001)');
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = resolve(dataDirectory, '../server/migrations');
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(resolve(directory, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await ensurePartitions(client, Date.now() - 7 * DAY, 21);
  } finally {
    await client.query('SELECT pg_advisory_unlock(73521001)');
    client.release();
    await pool.end();
  }
}
