import { describe, expect, it } from 'vitest';
import { parseFinnishNavigationAids } from '../src/navigation/vaylavirasto.js';

describe('Väylävirasto navigatsioonimärgid', () => {
  it('normaliseerib WFS MultiPoint objekti olemasolevasse NavigationAid mudelisse', () => {
    const aids = parseFinnishNavigationAids({
      features: [{
        id: 'turvalaitteet_uusi.805',
        geometry: { type: 'MultiPoint', coordinates: [[24.98343627, 60.11528178]] },
        properties: {
          id: 805,
          turvalaitenumero: '12996',
          nimifi: 'Lågharun',
          turvalaitetyyppifi: 'Poiju',
          alityyppi: 'KELLUVA',
          valaistu: 'K',
          navigointilajikoodi: 5,
          toimintatilakoodi: 1,
          paivitypaivamaara: '2025-08-14T12:20:59Z',
          paivatunnusten_tiedot: 'Väri: Keltainen/musta/keltainen, Väritys: Vaakavyöt',
          loistojen_tiedot: 'Loiston laji: Yövalo, Korkeus vedestä: 3.3',
          valosektorien_tiedot: 'Alkukulma: 0, Loppukulma: 360, Väri: v',
          vaylan_nimi: '[4865: Etelä-Suomen talviväylä I ](vaylat:jnro=4865)',
          omistajafi: 'Väylävirasto',
          sijaintifi: 'Helsingin edustalla.',
        },
      }],
    });

    expect(aids).toHaveLength(1);
    expect(aids[0]).toMatchObject({
      id: 'aton:vaylavirasto:805',
      name: 'Lågharun',
      lat: 60.11528178,
      lon: 24.98343627,
      kind: 'floating',
      category: 'cardinal-west',
      atonCode: '12996',
      registryType: 'Poiju',
      markColours: ['yellow', 'black'],
      lightActive: true,
      status: 1,
      owner: 'Väylävirasto',
      location: 'Helsingin edustalla.',
      fairwayName: 'Etelä-Suomen talviväylä I',
      sources: ['vaylavirasto'],
    });
  });

  it('jätab vigase geomeetriaga kirje vahele', () => {
    expect(parseFinnishNavigationAids({
      features: [{ geometry: { type: 'MultiPoint', coordinates: [] }, properties: {} }],
    })).toEqual([]);
  });

  it('eristab sihimärgi alumise ja ülemise märgi nime järgi', () => {
    const aids = parseFinnishNavigationAids({
      features: [
        {
          geometry: { type: 'MultiPoint', coordinates: [[24.2, 60.0]] },
          properties: { id: 1, nimifi: 'Flatgrund alempi', turvalaitetyyppifi: 'Linjamerkki' },
        },
        {
          geometry: { type: 'MultiPoint', coordinates: [[24.3, 60.1]] },
          properties: { id: 2, nimifi: 'Stora Halsö ylempi', turvalaitetyyppifi: 'Linjamerkki' },
        },
      ],
    });

    expect(aids.map((aid) => aid.category)).toEqual(['leading-front', 'leading-rear']);
  });
});
