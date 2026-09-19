/** Run only against the dedicated test database, never production. */
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { ensurePartitions } from '../server/src/db/migrate.js';
import { database } from '../server/src/db/pool.js';
import { vesselTrack, encodeBlock, pointFromRow } from '../server/src/ais/history.js';
import { DAY } from '../server/src/db/config.js';
if (!process.env.DATABASE_URL?.endsWith('/seapro_test')) throw new Error('Benchmark requires seapro_test');
const pool = new pg.Pool({
    options: '-c timezone=UTC',
    connectionString: process.env.DATABASE_MAINTENANCE_URL,
  }),
  c = await pool.connect();
try {
  const end = Math.floor(Date.now() / DAY) * DAY,
    from = end - 7 * DAY,
    mmsi = 999000456;
  await ensurePartitions(c, from, 6);
  await c.query('DELETE FROM ais_points WHERE mmsi=$1', [mmsi]);
  const begin = performance.now();
  await c.query(
    `INSERT INTO ais_points SELECT t::date,$1,t,t,t,59+0.1*sin(extract(epoch from t)/10000),24+0.1*cos(extract(epoch from t)/10000),10,90,90,0,70,true,'digitraffic',ARRAY['digitraffic'] FROM generate_series($2::timestamptz,$3::timestamptz-interval '30 seconds',interval '30 seconds') t`,
    [mmsi, new Date(from).toISOString(), new Date(end).toISOString()],
  );
  const insertMs = performance.now() - begin;
  const times = [];
  for (let n = 0; n < 6; n++) {
    const start = performance.now();
    const result = await vesselTrack(mmsi, from, end);
    times.push(Math.round(performance.now() - start));
    if (result.segments.flat().length !== 7 * 2880) throw new Error('Incomplete benchmark track');
  }
  const rows = await c.query('SELECT * FROM ais_points WHERE mmsi=$1 AND day=$2::date ORDER BY reported_at', [
    mmsi,
    new Date(from).toISOString(),
  ]);
  const points = rows.rows.map(pointFromRow),
    block = encodeBlock(points);
  const size = await c.query('SELECT avg(pg_column_size(p)) AS row_bytes FROM ais_points p WHERE mmsi=$1', [
    mmsi,
  ]);
  console.log(
    JSON.stringify(
      {
        points: 7 * 2880,
        insertMs: Math.round(insertMs),
        queryMs: times,
        rawRowBytes: Number(size.rows[0].row_bytes),
        packedBytesPerPoint: Math.round((block.payload.length / points.length) * 10) / 10,
        packedDayBytes: block.payload.length,
      },
      null,
      2,
    ),
  );
  await c.query('DELETE FROM ais_points WHERE mmsi=$1', [mmsi]);
} finally {
  c.release();
  await pool.end();
  await database.end();
}
