import { describe, expect, it } from 'vitest';
import en from './en.json';
import et from './et.json';

const noRouteCodes = [
  'endpoints_not_navigable',
  'start_not_navigable',
  'end_not_navigable',
  'route_geometry_too_complex',
  'route_waypoint_limit',
] as const;

describe('automatic route translations', () => {
  it('has localized messages for every endpoint and complexity failure', () => {
    for (const code of noRouteCodes) {
      expect(en[`route.auto.issueCode.${code}`]).toBeTruthy();
      expect(et[`route.auto.issueCode.${code}`]).toBeTruthy();
    }
  });

  it('describes a clear result without implying certification', () => {
    expect(en['route.auto.status.route']).not.toMatch(/checked|certified/i);
    expect(et['route.auto.status.route']).not.toMatch(/kontrollitud|sertifitseeritud/i);
  });

  it('always has an official-chart disclaimer in both languages', () => {
    expect(en['route.auto.disclaimer']).toMatch(/official nautical charts/i);
    expect(et['route.auto.disclaimer']).toMatch(/ametlikelt merekaartidelt/i);
  });
});
