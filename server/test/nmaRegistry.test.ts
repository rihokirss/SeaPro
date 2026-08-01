import { describe, expect, it } from 'vitest';
import { markColoursFromNma, parseNmaAidIndex } from '../src/navigation/nmaRegistry.js';

describe('NMA navigatsioonimärkide avaandmed', () => {
  it('indekseerib registri märgi numbri järgi ja dekodeerib XML-i', () => {
    const xml = `
      <Navimarks>
        <Navimark>
          <Name>Tilgu sadama 1</Name>
          <EstNo>1055.1</EstNo>
          <TypeName>Parema külje tooder</TypeName>
          <Colours>roheline &amp; valge</Colours>
          <Description>Roheline post</Description>
        </Navimark>
      </Navimarks>`;

    expect(parseNmaAidIndex(xml)).toEqual({
      '1055.1': {
        typeName: 'Parema külje tooder',
        colours: 'roheline & valge',
        description: 'Roheline post',
      },
    });
  });

  it('eelistab värvivälja ja leiab selle puudumisel värvid kirjeldusest', () => {
    expect(markColoursFromNma({ typeName: 'Tulepaak', colours: 'valge-punane', description: 'must' }))
      .toEqual(['red', 'white']);
    expect(markColoursFromNma({ typeName: 'Tulepaak', description: 'Roheliseks värvitud teraspost' }))
      .toEqual(['green']);
    expect(markColoursFromNma({ typeName: 'Tulepaak', description: 'Oranž metallsõrestik' }))
      .toEqual(['orange']);
  });
});
