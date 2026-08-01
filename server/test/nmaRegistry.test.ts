import { describe, expect, it } from 'vitest';
import { parseNmaAidIndex } from '../src/navigation/nmaRegistry.js';

describe('NMA navigatsioonimärkide avaandmed', () => {
  it('indekseerib registri märgi numbri järgi ja dekodeerib XML-i', () => {
    const xml = `
      <Navimarks>
        <Navimark>
          <Name>Tilgu sadama 1</Name>
          <EstNo>1055.1</EstNo>
          <TypeName>Parema külje tooder</TypeName>
          <Colours>roheline &amp; valge</Colours>
        </Navimark>
      </Navimarks>`;

    expect(parseNmaAidIndex(xml)).toEqual({
      '1055.1': { typeName: 'Parema külje tooder', colours: 'roheline & valge' },
    });
  });
});
