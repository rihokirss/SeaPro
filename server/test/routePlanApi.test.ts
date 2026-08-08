import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutePlanRequest } from '@seapro/shared';

const planRouteMock = vi.hoisted(() => vi.fn());

vi.mock('../src/routing/planner.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/routing/planner.js')>();
  return { ...original, planRoute: planRouteMock };
});

import { registerApiRoutes } from '../src/routes/api.js';

const request: RoutePlanRequest = {
  start: { lat: 59.49, lon: 24.66 },
  end: { lat: 59.57, lon: 24.62 },
  departureTime: '2026-08-08T20:00:00+03:00',
  speedKnots: 8,
  draughtM: 1.2,
  underKeelClearanceM: 0.5,
  beamM: 3.5,
  airDraughtM: 4,
};

describe('POST /api/route-plan', () => {
  beforeEach(() => { planRouteMock.mockReset(); });

  it('returns no_route as a normal typed result', async () => {
    planRouteMock.mockResolvedValue({
      status: 'no_route',
      issues: [{ code: 'no_navigable_route', severity: 'critical' }],
      sources: [],
    });
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/route-plan', payload: request });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'no_route' });
    expect(planRouteMock).toHaveBeenCalledOnce();
    expect(planRouteMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await app.close();
  });

  it('keeps planning after a real POST request body has been fully received', async () => {
    planRouteMock.mockImplementation(async (_request, options) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(options?.signal?.aborted).toBe(false);
      return {
        status: 'no_route',
        issues: [{ code: 'no_navigable_route', severity: 'critical' }],
        sources: [],
      };
    });
    const app = Fastify();
    await registerApiRoutes(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address missing');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/route-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'no_route' });
    await app.close();
  });

  it('rejects endpoints outside configured Estonia/Finland coverage', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/route-plan',
      payload: { ...request, end: { lat: 50, lon: 24.62 } },
    });
    expect(response.statusCode).toBe(400);
    expect(planRouteMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects incomplete vessel dimensions before starting expensive work', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/route-plan',
      payload: { ...request, beamM: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(planRouteMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires an explicit departure timezone', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/route-plan',
      payload: { ...request, departureTime: '2026-08-08T20:00:00' },
    });
    expect(response.statusCode).toBe(400);
    expect(planRouteMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a point inside the hard bbox but outside the routing service mask', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/route-plan',
      payload: { ...request, end: { lat: 59.33, lon: 19 } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'outside_routing_coverage' });
    expect(planRouteMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('limits route planning to two concurrent requests', async () => {
    const releases: Array<() => void> = [];
    planRouteMock.mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve({
        status: 'no_route',
        issues: [{ code: 'no_navigable_route', severity: 'critical' }],
        sources: [],
      }));
    }));
    const app = Fastify();
    await registerApiRoutes(app);
    const first = app.inject({ method: 'POST', url: '/api/route-plan', payload: request });
    const second = app.inject({ method: 'POST', url: '/api/route-plan', payload: request });
    await vi.waitFor(() => expect(planRouteMock).toHaveBeenCalledTimes(2));

    const busy = await app.inject({ method: 'POST', url: '/api/route-plan', payload: request });
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.json()).toMatchObject({ error: 'route_plan_busy' });

    releases.forEach((release) => release());
    await Promise.all([first, second]);
    await app.close();
  });

  it('maps the complete planning deadline to a gateway timeout', async () => {
    planRouteMock.mockRejectedValue(Object.assign(new Error('timeout'), {
      name: 'RoutingPlanTimeoutError',
    }));
    const app = Fastify();
    await registerApiRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/route-plan', payload: request });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: 'route_plan_timeout' });
    await app.close();
  });
});
