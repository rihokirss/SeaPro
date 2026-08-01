import { describe, expect, it } from 'vitest';
import { categoryFromAtonType, categoryFromRegistry } from '../src/navigation/categories.js';

describe('navigatsioonimärkide liigitus', () => {
  it('tõlgib AIS Message 21 standardtüübid', () => {
    expect(categoryFromAtonType(20)).toBe('cardinal-north');
    expect(categoryFromAtonType(23)).toBe('cardinal-west');
    expect(categoryFromAtonType(24)).toBe('lateral-port');
    expect(categoryFromAtonType(25)).toBe('lateral-starboard');
    expect(categoryFromAtonType(29)).toBe('safe-water');
  });

  it('eristab Nutimeri ametliku nime järgi kardinaalid ja lateraalmärgid', () => {
    expect(categoryFromRegistry('Uhtju madala põhjapoi', 'floating', 'valge'))
      .toBe('cardinal-north');
    expect(categoryFromRegistry('Dirhami vasaku külje tooder', 'floating'))
      .toBe('lateral-port');
    expect(categoryFromRegistry('Rohuküla parema külje poi', 'floating', 'roheline'))
      .toBe('lateral-starboard');
    expect(categoryFromRegistry('Ristna tuletorn', 'fixed', 'valge'))
      .toBe('lighthouse');
  });
});
