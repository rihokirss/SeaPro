import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { intersectBbox, registerApiRoutes } from '../src/routes/api.js';

describe('ilmaandmete piirkonnapiirid', () => {
  it('lõikab osaliselt kattuva grid-ala lubatud bbox-i sisse', () => {
    expect(intersectBbox([52, 8, 54, 10], [53, 9, 66, 31.5])).toEqual([53, 9, 54, 10]);
    expect(intersectBbox([0, 0, 1, 1], [53, 9, 66, 31.5])).toBeNull();
  });

  it('ei luba punktiprognoosi WEATHER_POINT_BBOX alast välja', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/point?lat=67&lon=25&providers=open-meteo',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/WEATHER_POINT_BBOX/);
    await app.close();
  });

  it('ei luba grid-päringut WEATHER_GRID_BBOX alast välja', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/grid?bbox=67,24,68,25&vars=wind_speed',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/WEATHER_GRID_BBOX/);
    await app.close();
  });
});
