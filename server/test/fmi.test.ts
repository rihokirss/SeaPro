import { describe, expect, it } from 'vitest';
import { parseMultiPointCoverage } from '../src/providers/fmi.js';

/**
 * FMI `multipointcoverage` parseri testid.
 *
 * Vorming on kolm paralleelset loendit (jaamad, positsioonid+aeg, väärtused)
 * ja kõik vead siin on VAIKSED: vale seos annab õige kujuga vastuse, milles
 * on lihtsalt teise jaama numbrid. Fixture on lühendatud päris vastusest.
 */

const WEATHER_QUERY = {
  storedQuery: 'x',
  fields: { ws_10min: 'wind_speed', t2m: 'air_temp' } as const,
  kind: 'coastal' as const,
};

const MAREO_QUERY = {
  storedQuery: 'x',
  fields: { WATLEV: 'sea_level' } as const,
  kind: 'coastal' as const,
};

/** Kaks jaama, kaks ajahetke, tahtlikult "vales" järjekorras loetletud. */
function xml(fields: string[], positions: string, tuples: string): string {
  return `<wfs:FeatureCollection>
  ${fields.map((f) => `<swe:field name="${f}" definition="d"/>`).join('\n')}
  <gmlcov:positions>
${positions}
  </gmlcov:positions>
  <gml:doubleOrNilReasonTupleList>
${tuples}
  </gml:doubleOrNilReasonTupleList>
  <gml:Point gml:id="point-100908" srsName="s" srsDimension="2">
    <gml:name>Parainen Utö</gml:name>
    <gml:pos>59.77909 21.37479 </gml:pos>
  </gml:Point>
  <gml:Point gml:id="point-100683" srsName="s" srsDimension="2">
    <gml:name>Porvoo Kilpilahti satama</gml:name>
    <gml:pos>60.30373 25.54916 </gml:pos>
  </gml:Point>
</wfs:FeatureCollection>`;
}

describe('parseMultiPointCoverage', () => {
  it('seob väärtused jaamaga koordinaadi, mitte järjekorra järgi', () => {
    const doc = xml(
      ['ws_10min', 't2m'],
      // Kilpilahti tuleb ridades ENNE Utöd, jaamade loendis aga pärast.
      `    60.30373 25.54916 1785000000
    59.77909 21.37479 1785000000`,
      `    3.1 21.0
    9.9 16.3`,
    );
    const out = parseMultiPointCoverage(doc, WEATHER_QUERY as never);

    const uto = out.find((s) => s.name === 'Parainen Utö');
    const kilpi = out.find((s) => s.name === 'Porvoo Kilpilahti satama');
    expect(uto?.values.wind_speed).toBe(9.9);
    expect(uto?.values.air_temp).toBe(16.3);
    expect(kilpi?.values.wind_speed).toBe(3.1);
  });

  it('võtab iga välja jaoks eraldi viimase mitte-NaN väärtuse', () => {
    // Tuul raporteerib iga 10 min, temperatuur harvemini — viimases reas on
    // ainult tuul. Ühe "viimase rea" võtmine kaotaks temperatuuri sootuks.
    const doc = xml(
      ['ws_10min', 't2m'],
      `    59.77909 21.37479 1785000000
    59.77909 21.37479 1785000600`,
      `    5.0 16.3
    6.2 NaN`,
    );
    const out = parseMultiPointCoverage(doc, WEATHER_QUERY as never);
    expect(out[0]?.values.wind_speed).toBe(6.2);
    expect(out[0]?.values.air_temp).toBe(16.3);
    // Ajatempel tuleb uusimast väärtusest, mis üldse olemas on.
    expect(out[0]?.observedAt).toBe(new Date(1785000600 * 1000).toISOString());
  });

  it('teisendab veetaseme millimeetritest meetriteks', () => {
    // FMI annab 199 mm. Ilma teisenduseta näitaks kaart 199 meetrit.
    const doc = xml(['WATLEV'], `    59.77909 21.37479 1785000000`, `    199.0`);
    const out = parseMultiPointCoverage(doc, MAREO_QUERY as never);
    expect(out[0]?.values.sea_level).toBe(0.199);
  });

  it('jätab vahele jaama, millel pole ühtki väärtust', () => {
    const doc = xml(
      ['ws_10min', 't2m'],
      `    59.77909 21.37479 1785000000`,
      `    NaN NaN`,
    );
    expect(parseMultiPointCoverage(doc, WEATHER_QUERY as never)).toHaveLength(0);
  });

  it('tunneb lainepoi nime järgi ära', () => {
    const doc = `<wfs:FeatureCollection>
  <swe:field name="WATLEV" definition="d"/>
  <gmlcov:positions>
    59.96667 25.23333 1785000000
  </gmlcov:positions>
  <gml:doubleOrNilReasonTupleList>
    100.0
  </gml:doubleOrNilReasonTupleList>
  <gml:Point gml:id="point-1" srsName="s" srsDimension="2">
    <gml:name>Suomenlahti aaltopoiju</gml:name>
    <gml:pos>59.96667 25.23333 </gml:pos>
  </gml:Point>
</wfs:FeatureCollection>`;
    const out = parseMultiPointCoverage(doc, MAREO_QUERY as never);
    expect(out[0]?.kind).toBe('buoy');
  });

  it('ei viska erindit, kui loendite pikkused ei klapi', () => {
    const doc = xml(['ws_10min'], `    59.77909 21.37479 1785000000`, `    5.0\n    6.0`);
    expect(parseMultiPointCoverage(doc, WEATHER_QUERY as never)).toEqual([]);
  });
});
