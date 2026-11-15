import { getTimes } from 'suncalc';

const DAY_MS = 86_400_000;

/** Absolute UTC intervals; independent of the browser's time zone and DST. */
export type NightPeriod = readonly [start: number, end: number];

/** Sunset to sunrise at sea level, including polar day/night and UTC day boundaries. */
export function nightPeriods(from: number, to: number, lat: number, lon: number): NightPeriod[] {
  const periods: NightPeriod[] = [];
  const longitude = ((lon + 180) % 360 + 360) % 360 - 180;
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) {
    const { sunrise, sunset, alwaysUp } = getTimes(new Date(day), lat, longitude, 0, 0);
    const events = [
      ...(sunrise ? [{ time: sunrise.getTime(), night: false }] : []),
      ...(sunset ? [{ time: sunset.getTime(), night: true }] : []),
    ].sort((a, b) => a.time - b.time);
    // The first event reverses the state at midnight. With no events, use the polar flag.
    let night = events.length ? !events[0]!.night : !alwaysUp;
    let start = day;
    for (const event of [...events, { time: day + DAY_MS, night: false }]) {
      const lo = Math.max(start, from);
      const hi = Math.min(event.time, to);
      if (night && hi > lo) periods.push([lo, hi]);
      start = event.time;
      night = event.night;
    }
  }
  return periods;
}
