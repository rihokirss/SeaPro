import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parseNominatimResults } from '../src/search/nominatim.js';
import { registerApiRoutes } from '../src/routes/api.js';

describe('Nominatimi otsing', () => {
  it('normaliseerib sadama, alapealkirja ja piirdekasti', () => {
    const results = parseNominatimResults([
      {
        place_id: 12,
        osm_type: 'way',
        osm_id: 345,
        lat: '59.4672',
        lon: '24.8214',
        name: 'Pirita sadam',
        display_name: 'Pirita sadam, Pirita, Tallinn, Eesti',
        category: 'leisure',
        type: 'marina',
        boundingbox: ['59.4600', '59.4700', '24.8100', '24.8300'],
      },
    ]);

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
    expect(parseNominatimResults([{ display_name: 'Katki', lat: 'NaN', lon: '24' }])).toEqual([]);
  });

  it('viskab arusaadava vea tundmatu vastusekuju korral', () => {
    expect(() => parseNominatimResults({ results: [] })).toThrow(/kuju muutus/i);
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
