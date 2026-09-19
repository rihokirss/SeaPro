import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { distanceMetres, type Vessel, type VesselHistoryPoint, type VesselTrack } from '@seapro/shared';
import { database } from '../db/pool.js';
import { cutoff, historyConfig, DAY } from '../db/config.js';
import { writeQueue, type WriteEvent } from '../db/queue.js';

export function validPosition(v: Vessel, now = Date.now()): boolean {
  const time = Date.parse(v.timestamp);
  return (
    Number.isInteger(v.mmsi) &&
    v.mmsi > 0 &&
    v.mmsi <= 999999999 &&
    Number.isFinite(v.lat) &&
    Number.isFinite(v.lon) &&
    Math.abs(v.lat) <= 90 &&
    Math.abs(v.lon) <= 180 &&
    Number.isFinite(time) &&
    time <= now + 300000
  );
}
export function splitTrack(points: VesselHistoryPoint[]): VesselHistoryPoint[][] {
  const segments: VesselHistoryPoint[][] = [];
  for (const p of points) {
    const current = segments.at(-1),
      previous = current?.at(-1);
    const seconds = previous ? (Date.parse(p.timestamp) - Date.parse(previous.timestamp)) / 1000 : 0;
    if (
      !previous ||
      seconds <= 0 ||
      seconds > 900 ||
      distanceMetres(previous, p) / seconds > (100 * 1852) / 3600
    )
      segments.push([p]);
    else current!.push(p);
  }
  return segments;
}
export function encodeBlock(points: VesselHistoryPoint[]) {
  const raw = JSON.stringify(points);
  return {
    payload: gzipSync(raw),
    checksum: createHash('sha256').update(raw).digest('hex'),
    pointCount: points.length,
  };
}
export function decodeBlock(block: {
  version: number;
  payload: Buffer;
  checksum: string;
  point_count: number;
}): VesselHistoryPoint[] {
  if (block.version !== 1) throw new Error('Tundmatu rajaploki versioon');
  const raw = gunzipSync(block.payload);
  if (createHash('sha256').update(raw).digest('hex') !== block.checksum)
    throw new Error('Rajaploki kontrollsumma ei klapi');
  const points = JSON.parse(raw.toString());
  if (!Array.isArray(points) || points.length !== block.point_count)
    throw new Error('Rajaploki punktide arv ei klapi');
  return points;
}
export function pointFromRow(r: any): VesselHistoryPoint {
  return {
    day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
    mmsi: r.mmsi,
    bucket: r.bucket.toISOString(),
    timestamp: r.reported_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
    lat: r.lat,
    lon: r.lon,
    sog: r.sog ?? undefined,
    cog: r.cog ?? undefined,
    heading: r.heading ?? undefined,
    navStat: r.nav_stat ?? undefined,
    shipType: r.ship_type ?? undefined,
    moving: r.moving,
    source: r.source,
    sources: r.sources,
  };
}

export class AisRecorder {
  private buckets = new Map<string, VesselHistoryPoint>();
  private previous = new Map<number, VesselHistoryPoint>();
  private dirtyVessels = new Map<number, Vessel>();
  private timer?: NodeJS.Timeout;
  private enabled = false;
  constructor(
    private emit: (event: WriteEvent) => void = (e) => writeQueue.enqueue(e),
    private gated = false,
  ) {}
  observe(v: Vessel, now = Date.now()) {
    if (this.gated && !this.enabled) return;
    if (
      !validPosition(v, now) ||
      Date.parse(v.timestamp) <
        Math.max(cutoff(historyConfig.aisDays, now), now - Math.min(2, historyConfig.hotDays) * DAY)
    )
      return;
    const finiteRange = (value: number | undefined, min: number, max: number) =>
      value !== undefined && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
    v = {
      ...v,
      sog: finiteRange(v.sog, 0, 102.2),
      cog: finiteRange(v.cog, 0, 359.999),
      heading: finiteRange(v.heading, 0, 359),
      navStat: Number.isInteger(v.navStat) ? finiteRange(v.navStat, 0, 15) : undefined,
      shipType: Number.isInteger(v.shipType) ? finiteRange(v.shipType, 0, 99) : undefined,
    };
    const old = this.previous.get(v.mmsi),
      time = Date.parse(v.timestamp);
    const seconds = old ? (time - Date.parse(old.timestamp)) / 1000 : 0;
    const inferred = old && seconds > 0 ? distanceMetres(old, v) / seconds / 0.514444 : 0;
    const moving = v.sog !== undefined ? v.sog >= 0.5 : inferred >= 0.5;
    const interval = (moving ? historyConfig.movingSeconds : historyConfig.stationarySeconds) * 1000;
    const dayStart = Math.floor(time / DAY) * DAY;
    const bucket = new Date(dayStart + Math.floor((time - dayStart) / interval) * interval).toISOString();
    // One slot per MMSI/time bucket; providers cannot create separate tracks.
    const key = `${v.mmsi}|${bucket}`,
      existing = this.buckets.get(key);
    const sources = [...new Set([...(existing?.sources ?? []), v.source])].sort() as Vessel['source'][];
    if (existing && time < Date.parse(existing.timestamp)) {
      existing.sources = sources;
      return;
    }
    const point: VesselHistoryPoint = {
      day: bucket.slice(0, 10),
      mmsi: v.mmsi,
      bucket,
      timestamp: v.timestamp,
      receivedAt: new Date(now).toISOString(),
      lat: v.lat,
      lon: v.lon,
      sog: v.sog,
      cog: v.cog,
      heading: v.heading,
      navStat: v.navStat,
      shipType: v.shipType,
      moving,
      source: v.source,
      sources,
    };
    this.buckets.set(key, point);
    if (!old || time >= Date.parse(old.timestamp)) {
      this.previous.set(v.mmsi, point);
      this.dirtyVessels.set(v.mmsi, v);
    }
    if (this.buckets.size >= 10000) this.flush(now);
  }
  metadata(mmsi: number, meta: Partial<Vessel>) {
    for (const point of this.buckets.values())
      if (point.mmsi === mmsi && point.shipType === undefined) point.shipType = meta.shipType;
    const latest = this.dirtyVessels.get(mmsi);
    if (latest) this.dirtyVessels.set(mmsi, { ...latest, ...meta });
  }
  flush(now = Date.now(), all = false) {
    for (const [key, p] of this.buckets) {
      const end =
        Date.parse(p.bucket) +
        (p.moving ? historyConfig.movingSeconds : historyConfig.stationarySeconds) * 1000;
      if (all || end + 5000 <= now) {
        this.emit({ kind: 'point', data: p });
        this.buckets.delete(key);
      }
    }
    for (const v of this.dirtyVessels.values()) this.emit({ kind: 'vessel', data: v });
    this.dirtyVessels.clear();
    for (const [mmsi, p] of this.previous)
      if (Date.parse(p.receivedAt) < now - DAY) this.previous.delete(mmsi);
  }
  start() {
    this.enabled = true;
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
  }
  stop() {
    this.enabled = false;
    clearInterval(this.timer);
    this.flush(Date.now(), true);
  }
}
export const aisRecorder = new AisRecorder(undefined, true);

export async function vesselTrack(
  mmsi: number,
  from: number,
  to: number,
  now = Date.now(),
): Promise<VesselTrack> {
  const lower = Math.max(from, cutoff(historyConfig.aisDays, now));
  const retention = new Date(cutoff(historyConfig.aisDays, now)).toISOString();
  // A single repeatable snapshot prevents a compaction racing between the two reads.
  const client = await database.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const points: VesselHistoryPoint[] = [];
    if (lower <= to) {
      const hot = await client.query(
        "SELECT * FROM ais_points WHERE mmsi=$1 AND day BETWEEN ($2::timestamptz AT TIME ZONE 'UTC')::date AND ($3::timestamptz AT TIME ZONE 'UTC')::date AND reported_at BETWEEN $2 AND $3 ORDER BY reported_at LIMIT 100001",
        [mmsi, new Date(lower).toISOString(), new Date(to).toISOString()],
      );
      if (hot.rows.length > 100000) throw new RangeError('Vali lühem ajavahemik');
      points.push(...hot.rows.map(pointFromRow));
      const cold = await client.query(
        "SELECT * FROM ais_track_blocks WHERE mmsi=$1 AND day BETWEEN ($2::timestamptz AT TIME ZONE 'UTC')::date AND ($3::timestamptz AT TIME ZONE 'UTC')::date",
        [mmsi, new Date(lower).toISOString(), new Date(to).toISOString()],
      );
      if (points.length + cold.rows.reduce((n, b) => n + b.point_count, 0) > 100000)
        throw new RangeError('Vali lühem ajavahemik');
      for (const b of cold.rows)
        points.push(
          ...decodeBlock(b).filter((p) => Date.parse(p.timestamp) >= lower && Date.parse(p.timestamp) <= to),
        );
    }
    const bounds = await client.query(
      `SELECT min(first_at) AS first,max(last_at) AS last FROM (
      SELECT min(reported_at) AS first_at,max(reported_at) AS last_at FROM ais_points WHERE mmsi=$1 AND reported_at >= $2
      UNION ALL SELECT GREATEST(first_at,$2::timestamptz),last_at FROM ais_track_blocks WHERE mmsi=$1 AND last_at >= $2) b`,
      [mmsi, retention],
    );
    let availableFrom = bounds.rows[0].first?.toISOString() ?? null;
    if (availableFrom === retention) {
      const edge = await client.query('SELECT * FROM ais_track_blocks WHERE mmsi=$1 AND first_at<$2 AND last_at>=$2 ORDER BY first_at LIMIT 1', [mmsi,retention]);
      if (edge.rows[0]) availableFrom = decodeBlock(edge.rows[0]).find(p=>Date.parse(p.timestamp)>=Date.parse(retention))?.timestamp ?? availableFrom;
    }
    const gaps = await client.query(
      'SELECT started_at AS "startedAt",ended_at AS "endedAt",reason FROM history_gaps WHERE started_at <= $2 AND COALESCE(ended_at,now()) >= $1',
      [new Date(Math.min(lower, to)).toISOString(), new Date(to).toISOString()],
    );
    await client.query('COMMIT');
    const unique = [
      ...new Map(
        points
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
          .map((p) => [`${p.mmsi}|${p.bucket}`, p]),
      ).values(),
    ];
    return {
      mmsi,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      availableFrom,
      availableTo: bounds.rows[0].last?.toISOString() ?? null,
      segments: splitTrack(unique),
      gaps: gaps.rows,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
