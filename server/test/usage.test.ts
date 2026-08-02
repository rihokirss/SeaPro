import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageMeter } from '../src/usage.js';

describe('UsageMeter', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loendab upstream-kulu, cache-tabamust ja unikaalseid seansse', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    const directory = mkdtempSync(join(tmpdir(), 'seapro-usage-'));
    temporaryDirectories.push(directory);
    const meter = new UsageMeter(join(directory, 'usage.json'));

    meter.recordApiRequest('session-aaaaaaaaaaaaaaaa');
    meter.recordApiRequest('session-aaaaaaaaaaaaaaaa');
    meter.recordApiRequest('session-bbbbbbbbbbbbbbbb');
    meter.recordUpstreamRequest('forecast', 'grid', 16);
    meter.recordUpstreamResult('forecast', 'grid', true);
    meter.recordUpstreamRequest('marine', 'point', 1);
    meter.recordUpstreamResult('marine', 'point', false);
    meter.recordCache('grid', 'fresh');
    meter.recordCache('grid', 'stale');
    meter.recordCache('grid', 'shared');
    meter.recordCache('grid', 'loaded');
    meter.recordCache('grid', 'error');

    vi.advanceTimersByTime(3600_000);
    const snapshot = meter.snapshot(1_000_000);
    expect(snapshot.today.sessions).toBe(2);
    expect(snapshot.today.apiRequests).toBe(3);
    expect(snapshot.today.upstream).toMatchObject({
      requests: 2,
      estimatedUnits: 17,
      successes: 1,
      failures: 1,
    });
    expect(snapshot.today.cache).toMatchObject({
      lookups: 5,
      hits: 3,
      hitRatePercent: 60,
    });
  });

  it('püsib kettal ega salvesta brauseri algset seansi-ID-d', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    const directory = mkdtempSync(join(tmpdir(), 'seapro-usage-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'usage.json');
    const originalSession = 'session-cccccccccccccccc';
    const first = new UsageMeter(file);

    first.recordApiRequest(originalSession);
    first.recordUpstreamRequest('forecast', 'grid', 16);
    first.recordUpstreamResult('forecast', 'grid', true);
    first.flush();

    expect(readFileSync(file, 'utf8')).not.toContain(originalSession);

    const restored = new UsageMeter(file);
    restored.loadFromDisk();
    const snapshot = restored.snapshot(1_000_000);
    expect(snapshot.today.sessions).toBe(1);
    expect(snapshot.today.upstream.estimatedUnits).toBe(16);
  });
});
