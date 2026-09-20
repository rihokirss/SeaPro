import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate, ensurePartitions } from '../src/db/migrate.js';
import { maintain } from '../src/db/maintenance.js';
import { database } from '../src/db/pool.js';
import { applyEvents, DurableQueue } from '../src/db/queue.js';
import { vesselTrack, decodeBlock } from '../src/ais/history.js';
import { ModelVerificationStore, modelVerification } from '../src/modelVerification.js';
import { DAY, historyConfig } from '../src/db/config.js';
import type { VesselHistoryPoint } from '@seapro/shared';

const enabled = process.env.SEAPRO_DB_TEST === '1';
describe.skipIf(!enabled)('PostgreSQL history integration', () => {
  const admin = new pg.Pool({
    options: '-c timezone=UTC',
    connectionString: process.env.DATABASE_MAINTENANCE_URL,
  });
  const mmsi = 999000123,
    now = Date.now(),
    day = new Date(now - 10 * DAY).toISOString().slice(0, 10);
  let queueDirectory: string;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.endsWith('/seapro_test'))
      throw new Error('Integration requires dedicated seapro_test database');
    await migrate();
    const c = await admin.connect();
    try {
      await c.query('DELETE FROM history_jobs WHERE day=$1', [day]);
      await c.query('DELETE FROM ais_heatmap WHERE mmsi=$1', [mmsi]);
      await ensurePartitions(c, Date.parse(day), 1);
    } finally {
      c.release();
    }
    queueDirectory = await mkdtemp(join(tmpdir(), 'seapro-queue-'));
  });
  afterAll(async () => {
    await rm(queueDirectory, { recursive: true, force: true });
    await database.end();
    await admin.end();
  });
  it('replays durable events idempotently, thins the archive and preserves detailed M path geometry', async () => {
    const points: VesselHistoryPoint[] = [0, 30, 60, 300, 330].map((s, i) => ({
      mmsi,
      day,
      bucket: `${day}T12:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.000Z`,
      timestamp: `${day}T12:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.000Z`,
      receivedAt: new Date(now).toISOString(),
      lat: 59 + i * 0.001,
      lon: 24,
      moving: true,
      shipType: 70,
      sog: 7,
      source: 'digitraffic',
      sources: ['digitraffic'],
    }));
    const c = await database.connect();
    try {
      await c.query('BEGIN');
      await applyEvents(
        c,
        points.map((data) => ({ kind: 'point', data })),
      );
      await applyEvents(
        c,
        points.map((data) => ({ kind: 'point', data })),
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(
      (await vesselTrack(mmsi, Date.parse(day), Date.parse(day) + DAY, now)).segments.flat(),
    ).toHaveLength(5);
    await maintain(process.env.DATABASE_MAINTENANCE_URL, now);
    const blocks = await database.query('SELECT * FROM ais_track_blocks WHERE mmsi=$1 AND day=$2', [
      mmsi,
      day,
    ]);
    expect(blocks.rows).toHaveLength(1);
    const unpacked = decodeBlock(blocks.rows[0]);
    expect(unpacked.map((p) => p.timestamp)).toEqual([
      points[2]!.timestamp,
      points[4]!.timestamp,
    ]);
    expect((await vesselTrack(mmsi, Date.parse(day), Date.parse(day) + DAY, now)).segments.flat()).toEqual(
      unpacked,
    );
    const heat = await database.query(
      'SELECT ST_GeometryType(path) AS type,ST_M(ST_StartPoint(path)) AS time,distance_m FROM ais_heatmap WHERE mmsi=$1 AND day=$2',
      [mmsi, day],
    );
    expect(heat.rows[0].type).toBe('ST_LineString');
    expect(heat.rows[0].time).toBe(Date.parse(points[0]!.timestamp) / 1000);
    expect(heat.rows[0].distance_m).toBeGreaterThan(200);
    await maintain(process.env.DATABASE_MAINTENANCE_URL, now);
    expect(
      (await database.query('SELECT count(*) FROM ais_heatmap WHERE mmsi=$1', [mmsi])).rows[0].count,
    ).toBe('1');
    const queue = new DurableQueue(queueDirectory);
    const id = randomUUID();
    queue.enqueue({ kind: 'metadata', data: { key: id, value: 'durable' } });
    await queue.flush();
    expect((await readdir(queueDirectory)).filter((x) => x.endsWith('.json'))).toHaveLength(0);
    expect((await database.query('SELECT value FROM app_metadata WHERE key=$1', [id])).rows[0].value).toBe(
      'durable',
    );
    const retention = historyConfig.aisDays;
    historyConfig.aisDays = 1;
    try {
      expect((await vesselTrack(mmsi, Date.parse(day), Date.parse(day) + DAY, now)).segments).toHaveLength(0);
      await maintain(process.env.DATABASE_MAINTENANCE_URL, now);
      expect(
        (await database.query('SELECT count(*) FROM ais_track_blocks WHERE mmsi=$1', [mmsi])).rows[0].count,
      ).toBe('0');
      expect(
        (await database.query('SELECT count(*) FROM ais_heatmap WHERE mmsi=$1', [mmsi])).rows[0].count,
      ).toBe('1');
    } finally {
      historyConfig.aisDays = retention;
    }
  }, 120000);
  it('keeps writes on disk during an outage and replays them after restart', async () => {
    const offline = new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 100 });
    const id = randomUUID();
    const failed = new DurableQueue(queueDirectory, 512 * 1024 * 1024, offline);
    failed.enqueue({ kind: 'metadata', data: { key: id, value: 'survives restart' } });
    await failed.flush();
    expect(failed.status.error).not.toBeNull();
    expect((await readdir(queueDirectory)).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    await offline.end();
    const recovered = new DurableQueue(queueDirectory);
    await recovered.start();
    await recovered.stop();
    expect((await database.query('SELECT value FROM app_metadata WHERE key=$1', [id])).rows[0].value).toBe(
      'survives restart',
    );
    expect((await readdir(queueDirectory)).filter((n) => n.endsWith('.json'))).toHaveLength(0);
  });

  it('preserves SQL report semantics and enforces weather retention before cleanup', async () => {
    const instant = Date.now(),
      at = new Date(instant - 3 * DAY).toISOString();
    const observation = {
      pointId: 'naissaare',
      observedAt: at,
      windSpeed: 10,
      windGust: 12,
      windDirection: 350,
    };
    const forecast = {
      pointId: 'naissaare',
      sourceId: 'open-meteo:gfs_seamless',
      sourceLabel: 'GFS',
      capturedAt: at,
      validAt: at,
      leadHours: 0,
      windSpeed: 11,
      windGust: 13,
      windDirection: 10,
      locationDistanceKm: 0,
    };
    const c = await database.connect();
    try {
      await applyEvents(c, [
        { kind: 'observation', data: observation },
        { kind: 'forecast', data: forecast },
      ]);
    } finally {
      c.release();
    }
    const [obs, forecasts, meta] = await Promise.all([
      database.query('SELECT data FROM weather_observations'),
      database.query('SELECT data FROM weather_forecasts'),
      database.query("SELECT value FROM app_metadata WHERE key='verificationStartedAt'"),
    ]);
    const state = {
      version: 1 as const,
      collectionStartedAt: meta.rows[0]?.value ?? new Date(instant).toISOString(),
      observations: obs.rows.map((r) => r.data),
      forecasts: forecasts.rows.map((r) => r.data),
    };
    const calculator = new ModelVerificationStore(state);
    for (const days of [7, 30] as const)
      for (const lead of [0, 24] as const) {
        expect(await modelVerification.report(days, lead, instant)).toEqual(
          calculator.report(days, lead, instant),
        );
        expect(await modelVerification.windReport(days, lead, instant, 'naissaare')).toEqual(
          calculator.windReport(days, lead, instant, 'naissaare'),
        );
        expect(await modelVerification.series(days, lead, 'naissaare', instant)).toEqual(
          calculator.series(days, lead, 'naissaare', instant),
        );
      }
    const days = historyConfig.weatherDays;
    historyConfig.weatherDays = 1;
    try {
      const result = await modelVerification.series(7, 0, 'naissaare', instant + 60001);
      expect(
        result.sources.every((s: any) =>
          s.entries.every((e: any) => Date.parse(e.validAt) >= instant + 60001 - DAY),
        ),
      ).toBe(true);
      expect(
        (
          await database.query('SELECT 1 FROM weather_observations WHERE point_id=$1 AND observed_at=$2', [
            'naissaare',
            at,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      historyConfig.weatherDays = days;
    }
  });
});
