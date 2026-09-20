import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { distanceMetres, type VesselHistoryPoint } from '@seapro/shared';
import { DAY, cutoff, historyConfig, dataDirectory } from './config.js';
import { ensurePartitions } from './migrate.js';
import { decodeBlock, encodeBlock, pointFromRow, splitTrack } from '../ais/history.js';

interface TrafficPart {
  points: VesselHistoryPoint[];
  distance: number;
  movingSeconds: number;
  stationarySeconds: number;
}
/** Simplify the line only, retaining timestamps on the selected vertices. */
export function simplifyTraffic(points: VesselHistoryPoint[], tolerance = 25): VesselHistoryPoint[] {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]),
    stack: [[number, number]] | Array<[number, number]> = [[0, points.length - 1]];
  const latitude = (points[0]!.lat * Math.PI) / 180,
    sx = 111320 * Math.cos(latitude),
    sy = 111320;
  while (stack.length) {
    const [a, b] = stack.pop()!,
      first = points[a]!,
      last = points[b]!;
    const dx = (last.lon - first.lon) * sx,
      dy = (last.lat - first.lat) * sy,
      denom = dx * dx + dy * dy;
    let maximum = tolerance * tolerance,
      index = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i]!,
        x = (p.lon - first.lon) * sx,
        y = (p.lat - first.lat) * sy;
      const t = denom ? Math.max(0, Math.min(1, (x * dx + y * dy) / denom)) : 0;
      const d = (x - t * dx) ** 2 + (y - t * dy) ** 2;
      if (d > maximum) {
        maximum = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep.add(index);
      stack.push([a, index], [index, b]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]!);
}

/** Keep the final real report from each UTC archive interval. */
export function thinArchivePoints(
  points: VesselHistoryPoint[],
  intervalSeconds = historyConfig.archiveSeconds,
): VesselHistoryPoint[] {
  const interval = intervalSeconds * 1000;
  const buckets = new Map<number, VesselHistoryPoint>();
  for (const point of points) {
    const time = Date.parse(point.timestamp);
    if (!Number.isFinite(time)) continue;
    const bucket = Math.floor(time / interval);
    const previous = buckets.get(bucket);
    if (!previous || Date.parse(previous.timestamp) <= time) buckets.set(bucket, point);
  }
  return [...buckets.values()].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}
export function trafficParts(points: VesselHistoryPoint[], day: string): TrafficPart[] {
  const start = Date.parse(day),
    end = start + DAY,
    parts: TrafficPart[] = [];
  for (const segment of splitTrack(points))
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1]!,
        b = segment[i]!,
        ta = Date.parse(a.timestamp),
        tb = Date.parse(b.timestamp);
      const lo = Math.max(start, ta),
        hi = Math.min(end, tb);
      if (hi <= lo) continue;
      const interpolate = (time: number): VesselHistoryPoint => ({
        ...a,
        lat: a.lat + ((b.lat - a.lat) * (time - ta)) / (tb - ta),
        lon: a.lon + ((b.lon - a.lon) * (time - ta)) / (tb - ta),
        timestamp: new Date(time).toISOString(),
      });
      const first = interpolate(lo),
        last = interpolate(hi),
        moving = a.moving;
      // Time across missing reports is capped; distance follows valid observed segments.
      const seconds = Math.min((hi - lo) / 1000, (300 * (hi - lo)) / (tb - ta));
      const distance = moving ? distanceMetres(first, last) : 0;
      const previous = parts.at(-1);
      if (
        previous &&
        previous.points.at(-1)!.timestamp === first.timestamp &&
        previous.points[0]!.shipType === first.shipType &&
        previous.points[0]!.moving === moving &&
        Date.parse(last.timestamp) - Date.parse(previous.points[0]!.timestamp) <= 3600000
      ) {
        previous.points.push(last);
        previous.distance += distance;
        previous.movingSeconds += moving ? seconds : 0;
        previous.stationarySeconds += moving ? 0 : seconds;
      } else
        parts.push({
          points: [first, last],
          distance,
          movingSeconds: moving ? seconds : 0,
          stationarySeconds: moving ? 0 : seconds,
        });
    }
  return parts;
}

export async function maintain(
  url = process.env.DATABASE_MAINTENANCE_URL ?? process.env.DATABASE_URL,
  now = Date.now(),
) {
  const pool = new pg.Pool({
      options: '-c timezone=UTC',
      connectionString: url,
      max: 1,
      application_name: 'seapro-maintenance',
    }),
    client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(73521002) AS locked')).rows[0].locked;
    if (!locked) return { skipped: true };
    await ensurePartitions(client, now, 14);
    if (
      (await readdir(join(dataDirectory, 'database-queue')).catch(() => [])).some((f) => f.endsWith('.json'))
    )
      return { skipped: true, reason: 'Kirjutusjärjekord peab enne ajaloo pakkimist tühjenema' };
    const today = new Date(now).toISOString().slice(0, 10);
    const days = await client.query(
      `SELECT p.day::text FROM history_partitions p LEFT JOIN history_jobs j USING(day)
      WHERE p.day < $1 AND (j.aggregated_at IS NULL OR p.day >= $1::date - 2 OR (j.packed_at IS NULL AND p.day < $2::date)) ORDER BY p.day`,
      [today, new Date(now - historyConfig.hotDays * DAY).toISOString().slice(0, 10)],
    );
    for (const { day } of days.rows) {
      const pack = Date.parse(day) + DAY <= now - historyConfig.hotDays * DAY;
      let archivedPointCount = 0;
      await client.query('BEGIN');
      try {
        // The short intake window prevents new points arriving in an archived partition.
        if (pack) await client.query(`LOCK TABLE ais_points_${day.replaceAll('-', '')} IN SHARE MODE`);
        await client.query('DELETE FROM ais_heatmap WHERE day=$1', [day]);
        const ids = await client.query(
          "SELECT DISTINCT mmsi FROM ais_points WHERE day BETWEEN $1::date-1 AND $1::date+1 AND reported_at BETWEEN $1::date::timestamptz-interval '15 minutes' AND $1::date::timestamptz+interval '1 day 15 minutes'",
          [day],
        );
        for (const { mmsi } of ids.rows) {
          const rows = await client.query(
            "SELECT * FROM ais_points WHERE mmsi=$1 AND day BETWEEN $2::date-1 AND $2::date+1 AND reported_at BETWEEN $2::date::timestamptz-interval '15 minutes' AND $2::date::timestamptz+interval '1 day 15 minutes' ORDER BY reported_at",
            [mmsi, day],
          );
          const points = rows.rows.map(pointFromRow);
          const previous = await client.query(
            'SELECT * FROM ais_track_blocks WHERE mmsi=$1 AND day=$2::date-1',
            [mmsi, day],
          );
          if (previous.rowCount)
            points.unshift(
              ...decodeBlock(previous.rows[0]).filter(
                (p) => Date.parse(p.timestamp) >= Date.parse(day) - 900000,
              ),
            );
          let part = 0;
          for (const item of trafficParts(points, day)) {
            const vertices = simplifyTraffic(item.points),
              first = vertices[0]!,
              last = vertices.at(-1)!;
            const wkt = first.moving
              ? `LINESTRING M (${vertices.map((p) => `${p.lon} ${p.lat} ${Date.parse(p.timestamp) / 1000}`).join(',')})`
              : `POINT M (${first.lon} ${first.lat} ${Date.parse(first.timestamp) / 1000})`;
            await client.query(
              `INSERT INTO ais_heatmap VALUES($1,$2,$3,$4,ST_GeomFromText($5,4326),$6,$7,$8,$9,$10)`,
              [
                day,
                mmsi,
                part++,
                first.shipType ?? 0,
                wkt,
                item.distance,
                item.movingSeconds,
                item.stationarySeconds,
                first.timestamp,
                last.timestamp,
              ],
            );
          }
          if (pack) {
            const own = thinArchivePoints(points.filter((p) => p.day === day));
            archivedPointCount += own.length;
            if (own.length) {
              const block = encodeBlock(own);
              decodeBlock({
                version: 1,
                payload: block.payload,
                checksum: block.checksum,
                point_count: block.pointCount,
              });
              await client.query(
                'INSERT INTO ais_track_blocks VALUES($1,$2,1,$3,$4,$5,$6,$7) ON CONFLICT(mmsi,day) DO UPDATE SET point_count=excluded.point_count,checksum=excluded.checksum,payload=excluded.payload,first_at=excluded.first_at,last_at=excluded.last_at',
                [
                  day,
                  mmsi,
                  own.length,
                  block.checksum,
                  block.payload,
                  own[0]!.timestamp,
                  own.at(-1)!.timestamp,
                ],
              );
            }
          }
        }
        await client.query(
          'INSERT INTO history_jobs VALUES($1,now(),$2) ON CONFLICT(day) DO UPDATE SET aggregated_at=now(),packed_at=excluded.packed_at',
          [day, pack ? new Date(now) : null],
        );
        if (pack) {
          const count = await client.query(
            'SELECT (SELECT count(*) FROM ais_points WHERE day=$1) AS hot, (SELECT COALESCE(sum(point_count),0) FROM ais_track_blocks WHERE day=$1) AS cold',
            [day],
          );
          const hot = Number(count.rows[0].hot),
            cold = Number(count.rows[0].cold);
          if (cold !== archivedPointCount || cold > hot)
            throw new Error(
              `Arhiivi punktide arv ei klapi: ${day}, algne ${hot}, oodatud ${archivedPointCount}, arhiiv ${cold}`,
            );
          await client.query(`DROP TABLE ais_points_${day.replaceAll('-', '')}`);
          await client.query('DELETE FROM history_partitions WHERE day=$1', [day]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    if (historyConfig.aisDays) {
      const edge = new Date(cutoff(historyConfig.aisDays, now)).toISOString();
      // Handle short retentions too; coarser partitions never expose expired points.
      await client.query('DELETE FROM ais_points WHERE day <= $1::date AND reported_at<$1', [edge]);
      await client.query('DELETE FROM ais_track_blocks WHERE last_at<$1', [edge]);
      const partial = await client.query(
        'SELECT * FROM ais_track_blocks WHERE first_at<$1 AND last_at >= $1',
        [edge],
      );
      for (const row of partial.rows) {
        const points = decodeBlock(row).filter((p) => Date.parse(p.timestamp) >= Date.parse(edge)),
          b = encodeBlock(points);
        await client.query(
          'UPDATE ais_track_blocks SET point_count=$3,checksum=$4,payload=$5,first_at=$6 WHERE mmsi=$1 AND day=$2',
          [row.mmsi, row.day, points.length, b.checksum, b.payload, points[0]!.timestamp],
        );
      }
      await client.query('DELETE FROM ais_vessels WHERE last_seen<$1', [edge]);
    }
    for (const [table, column, days] of [
      ['weather_observations', 'observed_at', historyConfig.weatherDays],
      ['weather_forecasts', 'valid_at', historyConfig.weatherDays],
      ['usage_hours', 'hour', historyConfig.usageDays],
      ['ais_heatmap', 'ended_at', historyConfig.heatmapDays],
    ] as const) {
      if (days)
        await client.query(`DELETE FROM ${table} WHERE ${column} < $1`, [
          new Date(cutoff(days, now)).toISOString(),
        ]);
    }
    const sizes = await client.query(
      "SELECT pg_database_size(current_database())::text AS bytes, pg_total_relation_size('ais_track_blocks')::text AS packed_bytes",
    );
    await client.query(
      "INSERT INTO app_metadata VALUES('maintenance', $1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [
        JSON.stringify({
          at: new Date(now).toISOString(),
          ...sizes.rows[0],
          settings: historyConfig,
          geometry: 'simplified vessel paths; no grid',
        }),
      ],
    );
    return sizes.rows[0];
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(73521002)');
    client.release();
    await pool.end();
  }
}
