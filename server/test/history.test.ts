import { describe, it, expect, vi, afterEach } from 'vitest';
import { AisRecorder, encodeBlock, decodeBlock, splitTrack } from '../src/ais/history.js';
import { historySettings, cutoff, DAY } from '../src/db/config.js';
import { trafficParts, simplifyTraffic, thinArchivePoints } from '../src/db/maintenance.js';
import type { VesselHistoryPoint } from '@seapro/shared';
import type { WriteEvent } from '../src/db/queue.js';
const point = (time: string, lat = 59, lon = 24): VesselHistoryPoint => ({
  mmsi: 230000001,
  day: time.slice(0, 10),
  bucket: time,
  timestamp: time,
  receivedAt: time,
  lat,
  lon,
  moving: true,
  source: 'digitraffic',
  sources: ['digitraffic'],
  sog: 10,
  shipType: 70,
});
describe('AIS history', () => {
  afterEach(() => vi.useRealTimers());
  it('validates configurable retention and unlimited retention', () => {
    expect(historySettings({}).aisDays).toBe(30);
    expect(historySettings({}).movingSeconds).toBe(60);
    expect(historySettings({}).archiveSeconds).toBe(300);
    expect(historySettings({ AIS_HISTORY_RETENTION_DAYS: '0' }).aisDays).toBe(0);
    expect(() => historySettings({ AIS_HISTORY_HOT_DAYS: '0' })).toThrow();
    expect(() => historySettings({ USAGE_RETENTION_DAYS: '-1' })).toThrow();
    expect(() => historySettings({ AIS_HISTORY_RETENTION_DAYS: '2' })).toThrow();
    expect(() => historySettings({ AIS_HISTORY_MOVING_INTERVAL_SECONDS: '1.2' })).toThrow();
    expect(() => historySettings({ AIS_HISTORY_ARCHIVE_INTERVAL_SECONDS: '0' })).toThrow();
    expect(cutoff(10, 20 * DAY)).toBe(10 * DAY);
    expect(cutoff(0, 20 * DAY)).toBeLessThan(0);
  });
  it('merges source precision differences and keeps last real observation per bucket', () => {
    const events: WriteEvent[] = [],
      r = new AisRecorder((e) => events.push(e));
    const now = Date.parse('2026-09-19T12:00:01Z');
    r.observe(point('2026-09-19T12:00:00.000Z'), now);
    r.observe({ ...point('2026-09-19T12:00:00.694Z'), source: 'transpordiamet' }, now);
    r.observe(point('2026-09-19T12:00:00.000Z'), now);
    r.flush(now + 70000);
    const points = events.filter((e) => e.kind === 'point');
    expect(points).toHaveLength(1);
    expect(points[0]!.data.timestamp).toContain('.694');
    expect(points[0]!.data.sources).toEqual(['digitraffic', 'transpordiamet']);
    events.length = 0;
    r.flush(now + 80000);
    expect(events.filter((e) => e.kind === 'point')).toHaveLength(0);
  });
  it('uses a five minute stationary bucket and rejects invalid positions', () => {
    const events: WriteEvent[] = [],
      r = new AisRecorder((e) => events.push(e));
    const now = Date.parse('2026-09-19T12:04:00Z');
    r.observe({ ...point('2026-09-19T12:00:00Z'), sog: 0 }, now);
    r.observe({ ...point('2026-09-19T12:03:00Z'), sog: 0 }, now);
    r.observe({ ...point('2026-09-19T12:04:00Z'), lat: 91 }, now);
    r.flush(now + 70000);
    expect(events.filter((e) => e.kind === 'point')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'point')!.data.timestamp).toBe('2026-09-19T12:03:00Z');
  });
  it('packs losslessly and detects damaged blocks', () => {
    const points = [point('2026-09-19T12:00:00Z'), point('2026-09-19T12:00:30Z', 59.001)],
      b = encodeBlock(points);
    expect(decodeBlock({ ...b, version: 1, point_count: b.pointCount })).toEqual(points);
    expect(() => decodeBlock({ ...b, version: 1, point_count: 3 })).toThrow();
    expect(() => decodeBlock({ ...b, version: 1, point_count: 2, checksum: 'wrong' })).toThrow();
  });
  it('keeps the last real point from each five minute archive interval', () => {
    const points = [
      point('2026-09-19T12:00:00Z'),
      point('2026-09-19T12:01:00Z', 59.001),
      point('2026-09-19T12:04:59Z', 59.002),
      point('2026-09-19T12:05:00Z', 59.003),
      point('2026-09-19T12:09:59Z', 59.004),
    ];
    expect(thinArchivePoints(points).map((p) => p.timestamp)).toEqual([
      '2026-09-19T12:04:59Z',
      '2026-09-19T12:09:59Z',
    ]);
    expect(thinArchivePoints([...points].reverse())).toEqual(thinArchivePoints(points));
  });
  it('splits missing reports and impossible jumps', () => {
    expect(
      splitTrack([
        point('2026-09-19T12:00:00Z'),
        point('2026-09-19T12:00:30Z', 59.001),
        point('2026-09-19T12:30:00Z', 59.002),
        point('2026-09-19T12:30:30Z', 61),
      ]),
    ).toHaveLength(3);
  });
  it('clips paths at midnight and caps presence through missing reports', () => {
    const points = [point('2026-09-18T23:55:00Z'), point('2026-09-19T00:05:00Z', 59.01)];
    const before = trafficParts(points, '2026-09-18'),
      after = trafficParts(points, '2026-09-19');
    expect(before[0]!.movingSeconds).toBe(150);
    expect(after[0]!.movingSeconds).toBe(150);
    expect(before[0]!.points.at(-1)!.timestamp).toBe('2026-09-19T00:00:00.000Z');
    expect(after[0]!.points[0]!.lat).toBeCloseTo(59.005);
  });
  it('retains bends and timestamped endpoints when simplifying paths', () => {
    const straight = [
      point('2026-09-19T12:00:00Z'),
      point('2026-09-19T12:00:30Z', 59.001),
      point('2026-09-19T12:01:00Z', 59.002),
    ];
    expect(simplifyTraffic(straight)).toEqual([straight[0], straight[2]]);
    straight[1]!.lon = 24.01;
    expect(simplifyTraffic(straight)).toHaveLength(3);
  });
});
