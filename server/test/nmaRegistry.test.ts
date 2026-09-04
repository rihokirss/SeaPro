import { describe, expect, it } from 'vitest';
import { markColoursFromNma, parseNmaAidIndex, parseNmaNavigationAids } from '../src/navigation/nmaRegistry.js';

describe('NMA navigatsioonimärkide avaandmed', () => {
  it('teisendab NMA kaareminutid kraadideks ja säilitab märgi liigi', () => {
    const aids = parseNmaNavigationAids(`<Navimarks>
      <Navimark><Name>Narva-Jõesuu tuletorn</Name><EstNo>001</EstNo>
        <TypeName>Tuletorn</TypeName><Latitude>3568086370</Latitude><Longitude>1682421960</Longitude>
        <Colours>valge-punane</Colours><LightActive>1</LightActive><LightChar>LFl(2) W 12s</LightChar>
      </Navimark>
      <Navimark><Name>Testi põhjapoi</Name><EstNo>002</EstNo><TypeName>Põhjapoi</TypeName>
        <Latitude>3540000000</Latitude><Longitude>1440000000</Longitude><Season>01.05-31.10</Season>
      </Navimark>
      <Navimark><Name>Puuduvad koordinaadid</Name><EstNo>003</EstNo><TypeName>Tulepaak</TypeName></Navimark>
      <Navimark><Name>Vigased koordinaadid</Name><EstNo>004</EstNo><TypeName>Tulepaak</TypeName>
        <Latitude>99999999999</Latitude><Longitude>0</Longitude></Navimark>
      </Navimarks>`);
    expect(aids).toHaveLength(2);
    expect(aids[0]).toMatchObject({ id: 'aton:nma:001', kind: 'fixed', category: 'lighthouse',
      markColours: ['red', 'white'], lightActive: true, lightDetails: 'LFl(2) W 12s', sources: ['registry'] });
    expect(aids[0]!.lat).toBeCloseTo(59.46810617, 7);
    expect(aids[0]!.lon).toBeCloseTo(28.040366, 7);
    expect(aids[1]).toMatchObject({ lat: 59, lon: 24, kind: 'seasonal', category: 'cardinal-north' });
  });

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
