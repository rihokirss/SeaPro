import { describe, expect, it } from 'vitest';
import { markColoursFromNma, parseNmaAidIndex, parseNmaLeadingLines, parseNmaNavigationAids } from '../src/navigation/nmaRegistry.js';

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

  it('koostab korduvast XML-i liitsihist ühe joone läbi mõlema märgi ja töötsooni', () => {
    const line = `<LeadingLines><LeadingLine><LineName>Suurupi siht</LineName>
      <Bearing>246.5</Bearing><FrontFwBegin>7826</FrontFwBegin><FrontFwEnd>18860</FrontFwEnd>
      <LeadingLineAtoNs>
        <LeadingLineAton><LdgLnAtonEstNo>374</LdgLnAtonEstNo><LdgLnAtonOrderNo>1</LdgLnAtonOrderNo></LeadingLineAton>
        <LeadingLineAton><LdgLnAtonEstNo>375</LdgLnAtonEstNo><LdgLnAtonOrderNo>2</LdgLnAtonOrderNo></LeadingLineAton>
      </LeadingLineAtoNs></LeadingLine></LeadingLines>`;
    const xml = `<Navimarks>
      <Navimark><Name>Suurupi sihi alumine tuletorn</Name><EstNo>374</EstNo><TypeName>Tuletorn, sihi alumine</TypeName>
        <Latitude>3568300960</Latitude><Longitude>1464997640</Longitude>${line}</Navimark>
      <Navimark><Name>Suurupi tuletorn</Name><EstNo>375</EstNo><TypeName>Tuletorn, sihi ülemine</TypeName>
        <Latitude>3567814620</Latitude><Longitude>1462815320</Longitude>${line}</Navimark>
      </Navimarks>`;
    const lines = parseNmaLeadingLines(xml);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: 'leading-line:nma:374:375', name: 'Suurupi siht', type: 'leading-line',
      bearingDegrees: 246.5, workingRangeStartM: 7826, workingRangeEndM: 18860,
      geometry: { type: 'LineString' },
    });
    const coordinates = lines[0]!.geometry.type === 'LineString' ? lines[0]!.geometry.coordinates : [];
    expect(coordinates).toHaveLength(3);
    expect(coordinates[0]).toEqual([1462815320 / 60_000_000, 3567814620 / 60_000_000]);
    expect(coordinates[1]).toEqual([1464997640 / 60_000_000, 3568300960 / 60_000_000]);
    // 246,5° on merelt märkide poole; töötsoon kulgeb vastupeilingul 66,5°.
    expect(coordinates[2]![0]).toBeGreaterThan(coordinates[1]![0]);
    expect(coordinates[2]![1]).toBeGreaterThan(coordinates[1]![1]);
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
