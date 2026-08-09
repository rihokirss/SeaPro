import { describe, expect, it } from 'vitest';
import type { RouteWaypoint } from '@seapro/shared';
import { isAutomaticRouteName, suggestedRouteName } from './routeName';

const start: RouteWaypoint = { id: 'a', lat: 59.437, lon: 24.7536, name: 'Tallinn' };
const finish: RouteWaypoint = { id: 'b', lat: 60.1699, lon: 24.9384, name: 'Helsingi' };

describe('route name suggestions', () => {
  it('uses endpoint names when they are available', () => {
    expect(suggestedRouteName([start, finish])).toBe('Tallinn – Helsingi');
  });

  it('uses compact coordinates for unnamed map points', () => {
    expect(suggestedRouteName([{ ...start, name: undefined }, finish])).toBe('59.437, 24.754 – Helsingi');
  });

  it('updates only blank, legacy, or previously suggested names', () => {
    expect(isAutomaticRouteName('', [])).toBe(true);
    expect(isAutomaticRouteName('Uus marsruut', [start, finish])).toBe(true);
    expect(isAutomaticRouteName('Tallinn – Helsingi', [start, finish])).toBe(true);
    expect(isAutomaticRouteName('Suvine reis', [start, finish])).toBe(false);
  });
});
