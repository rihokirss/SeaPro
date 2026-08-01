import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parsePhotonResults } from '../src/search/photon.js';
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
});
