import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parsePhotonResults, parsePhotonReverse } from '../src/search/photon.js';
import { registerApiRoutes } from '../src/routes/api.js';

describe('Photoni otsing', () => {
  it('normaliseerib sadama, alapealkirja ja piirdekasti', () => {
    const results = parsePhotonResults({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          osm_type: 'W', osm_id: 345, osm_key: 'leisure', osm_value: 'marina',
          name: 'Pirita sadam', district: 'Pirita', city: 'Tallinn', country: 'Eesti',
          extent: [24.81, 59.47, 24.83, 59.46],
        },
        geometry: { type: 'Point', coordinates: [24.8214, 59.4672] },
      }],
    }, 'Pirita');

    expect(results).toEqual([
      expect.objectContaining({
        id: 'W345',
        name: 'Pirita sadam',
        subtitle: 'Pirita, Tallinn, Eesti',
        kind: 'harbour',
        lat: 59.4672,
        lon: 24.8214,
        bbox: [59.46, 24.81, 59.47, 24.83],
        zoom: 14,
      }),
    ]);
  });

  it('jätab vigaste koordinaatidega kirjed välja', () => {
    expect(parsePhotonResults({ type: 'FeatureCollection', features: [
      { properties: { name: 'Katki' }, geometry: { coordinates: ['x', 24] } },
    ] }, 'Katki')).toEqual([]);
  });

  it('viskab arusaadava vea tundmatu vastusekuju korral', () => {
    expect(() => parsePhotonResults({ results: [] }, 'test')).toThrow(/kuju muutus/i);
  });

  it('tõstab sadama sama prefiksiga muude kohtade ette', () => {
    const feature = (name: string, value: string, id: number) => ({
      properties: { name, osm_type: 'W', osm_id: id, osm_key: 'place', osm_value: value },
      geometry: { coordinates: [24.48, 59.45] },
    });
    const results = parsePhotonResults({ type: 'FeatureCollection', features: [
      feature('Tilgu supelrand', 'beach', 1),
      feature('Tilgu sadam', 'marina', 2),
    ] }, 'Tilgu');
    expect(results.map((result) => result.name)).toEqual(['Tilgu sadam', 'Tilgu supelrand']);
  });
});

describe('Photoni pöördotsing', () => {
  const feature = (properties: Record<string, unknown>, lon: number, lat: number) => ({
    properties,
    geometry: { coordinates: [lon, lat] },
  });

  it('eelistab lähedal asuvat sadamat juhuslikule objektile', () => {
    const result = parsePhotonReverse({ features: [
      feature({ name: 'Olümpiaembleem', osm_key: 'tourism', osm_value: 'artwork', locality: 'Pirita' }, 24.8235, 59.4692),
      feature({ name: 'Pirita sadam', osm_type: 'W', osm_id: 7, osm_key: 'leisure', osm_value: 'marina', city: 'Tallinn' }, 24.8216, 59.4683),
    ] }, 59.4689, 24.8248);

    expect(result).toEqual(expect.objectContaining({ name: 'Pirita sadam', kind: 'harbour' }));
  });

  it('kasutab sadama puudumisel kõige täpsemat asukohanime', () => {
    const result = parsePhotonReverse({ features: [
      feature({ name: 'Nimetu maja', osm_key: 'building', osm_value: 'yes', locality: 'Pirita', city: 'Tallinn' }, 24.824, 59.469),
    ] }, 59.4689, 24.8248);

    expect(result).toEqual(expect.objectContaining({ name: 'Pirita', kind: 'location' }));
  });

  it('ei eelista kauget sadamat lähedasele asulale', () => {
    const result = parsePhotonReverse({ features: [
      feature({ name: 'Naissaar', osm_key: 'place', osm_value: 'island' }, 24.516, 59.56),
      feature({ name: 'Kauge sadam', osm_key: 'leisure', osm_value: 'marina' }, 24.7, 59.7),
    ] }, 59.56, 24.516);

    expect(result).toEqual(expect.objectContaining({ name: 'Naissaar', kind: 'location' }));
  });
});

describe('/api/search valideerimine', () => {
  it('ei saada liiga lühikest päringut välisteenusele', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/api/search?q=a' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('lükkab tagurpidi piirdekasti tagasi', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=Pirita&bbox=60,25,59,24',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('lükkab vigased pöördotsingu koordinaadid tagasi', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/api/reverse-place?lat=91&lon=24' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
