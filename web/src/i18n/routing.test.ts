import { describe, expect, it } from 'vitest';
import en from './en.json';
import et from './et.json';
import fi from './fi.json';

const noRouteCodes = [
  'endpoints_not_navigable',
  'start_not_navigable',
  'end_not_navigable',
  'route_geometry_too_complex',
  'route_waypoint_limit',
] as const;

const dictionaries = { en, et, fi };

describe('translation dictionaries', () => {
  it('has the same keys and interpolation variables in every language', () => {
    const englishKeys = Object.keys(en).sort();
    const variables = (text: string) => [...text.matchAll(/\{([^}]+)\}/g)]
      .map((match) => match[1])
      .sort();

    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(variables(dictionary[key as keyof typeof dictionary])).toEqual(
          variables(en[key as keyof typeof en]),
        );
      }
    }
  });
});

describe('automatic route translations', () => {
  it('has localized messages for every endpoint and complexity failure', () => {
    for (const code of noRouteCodes) {
      expect(en[`route.auto.issueCode.${code}`]).toBeTruthy();
      expect(et[`route.auto.issueCode.${code}`]).toBeTruthy();
      expect(fi[`route.auto.issueCode.${code}`]).toBeTruthy();
    }
  });

  it('describes a clear result without implying certification', () => {
    expect(en['route.auto.status.route']).not.toMatch(/checked|certified/i);
    expect(et['route.auto.status.route']).not.toMatch(/kontrollitud|sertifitseeritud/i);
    expect(fi['route.auto.status.route']).not.toMatch(/tarkistettu|sertifioitu/i);
  });

  it('always has an official-chart disclaimer in every language', () => {
    expect(en['route.auto.disclaimer']).toMatch(/official nautical charts/i);
    expect(et['route.auto.disclaimer']).toMatch(/ametlikelt merekaartidelt/i);
    expect(fi['route.auto.disclaimer']).toMatch(/virallisista merikartoista/i);
  });
});
