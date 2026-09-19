import { mkdir, open, readdir, readFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { database, databaseStatus } from './pool.js';
import { dataDirectory, historyConfig } from './config.js';
import type pg from 'pg';

export interface WriteEvent {
  kind: 'observation' | 'forecast' | 'usage' | 'vessel' | 'point' | 'metadata' | 'gap';
  data: any;
}
export async function applyEvents(client: pg.PoolClient, events: WriteEvent[]) {
  for (const { kind, data: d } of events) {
    if (kind === 'observation')
      await client.query(
        `INSERT INTO weather_observations VALUES($1,$2,$3) ON CONFLICT(point_id,observed_at) DO UPDATE SET data=excluded.data`,
        [d.pointId, d.observedAt, d],
      );
    else if (kind === 'forecast')
      await client.query(
        `INSERT INTO weather_forecasts VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(point_id,source_id,captured_at,lead_hours) DO UPDATE SET valid_at=excluded.valid_at,data=excluded.data`,
        [d.pointId, d.sourceId, d.capturedAt, d.validAt, d.leadHours, d],
      );
    else if (kind === 'usage')
      await client.query(
        `INSERT INTO usage_hours VALUES($1,$2) ON CONFLICT(hour) DO UPDATE SET data=excluded.data`,
        [`${d.hour}:00:00Z`, d],
      );
    else if (kind === 'metadata')
      await client.query(`INSERT INTO app_metadata VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, [
        d.key,
        JSON.stringify(d.value),
      ]);
    else if (kind === 'gap')
      await client.query(
        `INSERT INTO history_gaps VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at`,
        [d.id, d.startedAt, d.endedAt, d.reason],
      );
    else if (kind === 'vessel')
      await client.query(
        `INSERT INTO ais_vessels VALUES($1,$2,$2,$3) ON CONFLICT(mmsi) DO UPDATE SET last_seen=GREATEST(ais_vessels.last_seen,excluded.last_seen),data=CASE WHEN excluded.last_seen >= ais_vessels.last_seen THEN ais_vessels.data || excluded.data ELSE excluded.data || ais_vessels.data END`,
        [d.mmsi, d.timestamp, d],
      );
    else if (kind === 'point')
      await client.query(
        `INSERT INTO ais_points VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(day,mmsi,bucket) DO UPDATE SET
      sources=ARRAY(SELECT DISTINCT unnest(ais_points.sources || excluded.sources)),
      reported_at=GREATEST(ais_points.reported_at,excluded.reported_at),
      received_at=GREATEST(ais_points.received_at,excluded.received_at),
      lat=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.lat ELSE ais_points.lat END,
      lon=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.lon ELSE ais_points.lon END,
      sog=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.sog ELSE ais_points.sog END,
      cog=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.cog ELSE ais_points.cog END,
      heading=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.heading ELSE ais_points.heading END,
      nav_stat=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.nav_stat ELSE ais_points.nav_stat END,
      ship_type=COALESCE(excluded.ship_type,ais_points.ship_type),
      moving=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.moving ELSE ais_points.moving END,
      source=CASE WHEN excluded.reported_at>=ais_points.reported_at THEN excluded.source ELSE ais_points.source END`,
        [
          d.day,
          d.mmsi,
          d.bucket,
          d.timestamp,
          d.receivedAt,
          d.lat,
          d.lon,
          d.sog,
          d.cog,
          d.heading,
          d.navStat,
          d.shipType,
          d.moving,
          d.source,
          d.sources,
        ],
      );
  }
}

export class DurableQueue {
  private pending: WriteEvent[] = [];
  private active: Promise<void> | null = null;
  private serial = 0;
  private timer?: NodeJS.Timeout;
  private gap: { id: string; startedAt: string; endedAt: string | null; reason: string } | null = null;
  readonly status = {
    bytes: 0,
    pending: 0,
    lastWriteAt: null as string | null,
    error: null as string | null,
    dropped: 0,
  };
  constructor(
    readonly directory = join(dataDirectory, 'database-queue'),
    readonly maxBytes = historyConfig.queueBytes,
    private readonly pool = database,
  ) {}
  enqueue(event: WriteEvent) {
    // Bound memory as well as disk when storage is unavailable.
    if (this.pending.length >= 10000) {
      this.status.dropped++;
      this.markGap('Kirjutusjärjekord täitus');
      return;
    }
    this.pending.push(event);
    this.status.pending = this.pending.length;
    if (this.pending.length >= 1000) void this.flush();
  }
  markGap(reason: string) {
    this.status.error = reason;
    this.gap ??= { id: randomUUID(), startedAt: new Date().toISOString(), endedAt: null, reason };
  }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory)).filter((n) => n.endsWith('.json.tmp'))) {
      const path = join(this.directory, name);
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('invalid');
        await rename(path, path.slice(0, -4));
      } catch {
        this.markGap('Katkestatud kirjutusest jäi poolik järjekorrafail');
        await unlink(path).catch(() => {});
      }
    }
    await this.flush();
    if (this.status.error) throw new Error('Ajaloo kirjutusjärjekorda ei saanud taastada');
    this.timer = setInterval(() => void this.flush(), 5000);
    this.timer.unref();
  }
  private async syncDirectory() {
    const dir = await open(this.directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  flush(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.drain()
      .catch(() => {
        this.markGap('Ajaloo kirjutamine ebaõnnestus');
      })
      .finally(() => {
        this.status.pending = this.pending.length;
        this.active = null;
      });
    return this.active;
  }
  private async drain() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let files = (await readdir(this.directory)).filter((n) => n.endsWith('.json')).sort();
    this.status.bytes = (
      await Promise.all(files.map(async (n) => (await stat(join(this.directory, n))).size))
    ).reduce((a, b) => a + b, 0);
    const batch = this.pending.splice(0, 1000);
    if (this.gap) batch.unshift({ kind: 'gap', data: { ...this.gap, endedAt: new Date().toISOString() } });
    if (batch.length) {
      const body = JSON.stringify(batch),
        size = Buffer.byteLength(body);
      if (this.status.bytes + size > this.maxBytes) {
        this.pending.unshift(...batch.filter((e) => e.kind !== 'gap'));
        this.markGap('Ajaloo kettajärjekord täitus');
      } else {
        this.serial = Math.max(Date.now(), this.serial + 1, ...files.map((n) => Number(n.split('-')[0]) + 1));
        const name = `${this.serial}-${randomUUID()}.json`,
          tmp = join(this.directory, `${name}.tmp`);
        try {
          const f = await open(tmp, 'w', 0o600);
          try {
            await f.writeFile(body);
            await f.sync();
          } finally {
            await f.close();
          }
          await rename(tmp, join(this.directory, name));
          await this.syncDirectory();
          this.status.bytes += size;
          files.push(name);
        } catch (error) {
          this.pending.unshift(...batch.filter((e) => e.kind !== 'gap'));
          throw error;
        }
      }
    }
    for (const name of files.sort()) {
      let client: pg.PoolClient | undefined;
      try {
        const body = await readFile(join(this.directory, name), 'utf8');
        client = await this.pool.connect();
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock_shared(73521002)');
        await applyEvents(client, JSON.parse(body));
        await client.query('COMMIT');
        await unlink(join(this.directory, name));
        await this.syncDirectory();
        this.status.bytes -= Buffer.byteLength(body);
        this.status.lastWriteAt = new Date().toISOString();
        databaseStatus.connected = true;
        databaseStatus.error = null;
        this.gap = null;
        this.status.error = null;
      } catch {
        if (client) await client.query('ROLLBACK').catch(() => {});
        databaseStatus.connected = false;
        this.markGap('Andmebaasi kirjutamine ebaõnnestus; järjekord ootab');
        break;
      } finally {
        client?.release();
      }
    }
  }
  async stop() {
    clearInterval(this.timer);
    await this.active;
    while (this.pending.length) {
      const before = this.pending.length;
      await this.flush();
      if (this.pending.length >= before) break;
    }
    await this.flush();
  }
}
export const writeQueue = new DurableQueue();
