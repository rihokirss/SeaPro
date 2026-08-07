import { describe, expect, it } from 'vitest';
import {
  categoryFromAtonType,
  categoryFromFinnishNavigationCode,
  categoryFromRegistry,
} from '../src/navigation/categories.js';

describe('navigatsioonimärkide liigitus', () => {
  it('tõlgib AIS Message 21 standardtüübid', () => {
    expect(categoryFromAtonType(20)).toBe('cardinal-north');
    expect(categoryFromAtonType(23)).toBe('cardinal-west');
    expect(categoryFromAtonType(24)).toBe('lateral-port');
    expect(categoryFromAtonType(25)).toBe('lateral-starboard');
    expect(categoryFromAtonType(26)).toBe('preferred-port');
    expect(categoryFromAtonType(27)).toBe('preferred-starboard');
    expect(categoryFromAtonType(29)).toBe('safe-water');
    expect(categoryFromAtonType(7)).toBe('leading-front');
    expect(categoryFromAtonType(8)).toBe('leading-rear');
    expect(categoryFromAtonType(4)).toBeUndefined();
    expect(categoryFromAtonType(31)).toBeUndefined();
  });

  it('tõlgib Väylävirasto IALA navigatsiooniliigi koodid', () => {
    expect(categoryFromFinnishNavigationCode(1)).toBe('lateral-port');
    expect(categoryFromFinnishNavigationCode(2)).toBe('lateral-starboard');
    expect(categoryFromFinnishNavigationCode(3)).toBe('cardinal-north');
    expect(categoryFromFinnishNavigationCode(4)).toBe('cardinal-south');
    expect(categoryFromFinnishNavigationCode(5)).toBe('cardinal-west');
    expect(categoryFromFinnishNavigationCode(6)).toBe('cardinal-east');
    expect(categoryFromFinnishNavigationCode(7)).toBe('isolated-danger');
    expect(categoryFromFinnishNavigationCode(8)).toBe('safe-water');
    expect(categoryFromFinnishNavigationCode(9)).toBe('special');
    expect(categoryFromFinnishNavigationCode(99)).toBeUndefined();
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
    expect(categoryFromRegistry('Tilgu sadama 1', 'seasonal', undefined, 'Parema külje tooder'))
      .toBe('lateral-starboard');
    expect(categoryFromRegistry('Suurupi sihi alumine tuletorn', 'fixed', 'valge', 'Tuletorn, sihi alumine'))
      .toBe('leading-front');
    expect(categoryFromRegistry('Suurupi tuletorn', 'fixed', 'valge', 'Tuletorn, sihi ülemine'))
      .toBe('leading-rear');
    expect(categoryFromRegistry(
      'Lohusalu vraki eraldiasuva ohu tooder',
      'seasonal',
      undefined,
      'Eraldiasuva ohu tooder',
    )).toBe('isolated-danger');
  });
});
