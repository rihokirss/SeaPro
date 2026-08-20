import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { registerApiRoutes } from '../src/routes/api.js';

describe('mudelitäpsuse API', () => {
  const original = config.modelSkillEnabled;

  afterEach(() => {
    config.modelSkillEnabled = original;
  });

  it('lükkab tundmatu kontrollpunkti tagasi', async () => {
    config.modelSkillEnabled = true;
    const app = Fastify();
    await registerApiRoutes(app);
    const summary = await app.inject({ method: 'GET', url: '/api/model-skill?pointId=meri' });
    const series = await app.inject({ method: 'GET', url: '/api/model-skill/series?pointId=meri' });
    expect(summary.statusCode).toBe(400);
    expect(series.statusCode).toBe(400);
    await app.close();
  });

  it('peidab mõlemad otspunktid kui funktsioon on välja lülitatud', async () => {
    config.modelSkillEnabled = false;
    const app = Fastify();
    await registerApiRoutes(app);
    expect((await app.inject({ method: 'GET', url: '/api/model-skill' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/model-skill/series?pointId=tilgu' })).statusCode).toBe(404);
    await app.close();
  });
});
