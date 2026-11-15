import { describe, expect, it } from 'vitest';
import { nightPeriods } from './daylight';

const DAY = 86_400_000;
const date = (iso: string) => Date.parse(iso);

describe('nightPeriods', () => {
  it('uses Tallinn summer and winter sunrise/sunset, with minute precision', () => {
    for (const [day, riseHour, setHour] of [
      ['2026-06-21', 1, 19], ['2026-12-21', 7, 13],
    ] as const) {
      const start = date(`${day}T00:00:00Z`);
      const periods = nightPeriods(start, start + DAY, 59.44, 24.75);
      expect(periods).toHaveLength(2);
      expect(periods[0]![0]).toBe(start);
      expect(new Date(periods[0]![1]).getUTCHours()).toBe(riseHour);
      expect(new Date(periods[1]![0]).getUTCHours()).toBe(setHour);
      expect(periods[0]![1] % 3_600_000).not.toBe(0);
      expect(periods[1]![1]).toBe(start + DAY);
    }
  });

  it('handles polar day and night', () => {
    const summer = date('2026-06-21T00:00:00Z');
    const winter = date('2026-12-21T00:00:00Z');
    expect(nightPeriods(summer, summer + DAY, 69.65, 18.95)).toEqual([]);
    expect(nightPeriods(winter, winter + DAY, 69.65, 18.95)).toEqual([[winter, winter + DAY]]);
  });

  it('handles sunset before sunrise within a UTC day near the date line', () => {
    const start = date('2026-03-20T00:00:00Z');
    const periods = nightPeriods(start, start + DAY, 0, 179);
    expect(periods).toHaveLength(1);
    expect(periods[0]![0]).toBeGreaterThan(start + 5 * 3_600_000);
    expect(periods[0]![1]).toBeLessThan(start + 19 * 3_600_000);
  });

  it('clips at range edges across midnight and a daylight-saving change', () => {
    const from = date('2026-10-24T23:40:00+03:00');
    const to = date('2026-10-25T04:20:00+02:00');
    const midnight = date('2026-10-25T00:00:00Z');
    expect(nightPeriods(from, to, 59.44, 24.75)).toEqual([[from, midnight], [midnight, to]]);
  });

  it('normalizes longitude after panning across repeated map worlds', () => {
    const start = date('2026-11-15T00:00:00Z');
    expect(nightPeriods(start, start + DAY, 59.44, 384.75))
      .toEqual(nightPeriods(start, start + DAY, 59.44, 24.75));
  });
});
