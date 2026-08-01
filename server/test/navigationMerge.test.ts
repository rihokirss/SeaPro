import { describe, expect, it } from 'vitest';
import type { Harbour, NavigationAid } from '@seapro/shared';
import { mergeHarbours, mergeNavigationAids } from '../src/navigation/merge.js';

describe('Nutimeri andmete ühendamine', () => {
  it('rikastab OSM sadamat ametliku registriga ilma teist markerit tekitamata', () => {
    const osm: Harbour[] = [{
      id: 'node/1',
      kind: 'harbour',
      name: 'Kakumäe sadam',
      lat: 59.4501,
      lon: 24.607,
      locode: 'EEKAK',
      phone: '+372 5555',
    }];
    const official: Harbour[] = [{
      id: 'transpordiamet/42',
      officialId: '42',
      kind: 'harbour',
      name: 'Kakumäe',
      lat: 59.45,
      lon: 24.6072,
      locode: 'EE KAK',
      maxDraught: 2.5,
      registryUrl: 'https://example.test/42',
      sources: ['transpordiamet'],
    }];

    const merged = mergeHarbours(osm, official);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'node/1',
      officialId: '42',
      phone: '+372 5555',
      maxDraught: 2.5,
      sources: ['osm', 'transpordiamet'],
    });
  });

  it('ühendab Ristna eri vormingus LOCODE-id ja säilitab OSM-i rikkamad väljad', () => {
    const merged = mergeHarbours(
      [{
        id: 'way/1163659970',
        kind: 'harbour',
        name: 'Ristna sadam',
        lat: 59.2702668,
        lon: 23.745463,
        locode: 'EERST',
        phone: '+372 5059038',
      }],
      [{
        id: 'transpordiamet/142580',
        officialId: '142580',
        kind: 'harbour',
        name: 'RISTNA SADAM',
        lat: 59.271,
        lon: 23.744833333,
        locode: 'EE RST',
        maxDraught: 1.7,
        sources: ['transpordiamet'],
      }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'way/1163659970',
      officialId: '142580',
      locode: 'EERST',
      phone: '+372 5059038',
      maxDraught: 1.7,
      sources: ['osm', 'transpordiamet'],
    });
  });

  it('liidab füüsilise AIS AToN-i registrimärgiga, kuid jätab virtuaalse eraldi', () => {
    const official: NavigationAid[] = [{
      id: 'aton:registry:1',
      lat: 59.45,
      lon: 24.6,
      name: 'Kakumäe poi',
      kind: 'floating',
      sources: ['registry'],
    }];
    const live: NavigationAid[] = [
      {
        id: 'aton:ais:276001',
        lat: 59.4501,
        lon: 24.6001,
        name: 'KAKUMAE',
        kind: 'ais',
        mmsi: 276001,
        offPosition: false,
        sources: ['ais'],
      },
      {
        id: 'aton:ais:276002',
        lat: 59.45,
        lon: 24.6,
        name: 'VIRTUAL HAZARD',
        kind: 'virtual',
        virtual: true,
        mmsi: 276002,
        sources: ['ais'],
      },
    ];

    const merged = mergeNavigationAids(official, live);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ mmsi: 276001, sources: ['registry', 'ais'] });
    expect(merged[1]).toMatchObject({ kind: 'virtual', mmsi: 276002 });
  });
});
