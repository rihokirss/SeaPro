import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedRoutingGraph } from '../src/routing/preparedGraph.js';

vi.mock('../src/routing/preparedGraph.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/routing/preparedGraph.js')>();
  return { ...original, loadPreparedRoutingGraph: vi.fn() };
});

import { registerApiRoutes } from '../src/routes/api.js';
import { loadPreparedRoutingGraph } from '../src/routing/preparedGraph.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.resetAllMocks();
});

describe('routing graph comparison API', () => {
  it('returns only edges intersecting the requested view with graph metadata', async () => {
    vi.mocked(loadPreparedRoutingGraph).mockResolvedValue(graphFixture());
    const app = Fastify();
    apps.push(app);
    await registerApiRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/routing-graph?bbox=59,24,59.1,24.1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('max-age=60');
    expect(response.json()).toMatchObject({
      version: 'seapro-routing-graph-v2',
      builtAt: '2026-08-09T12:00:00.000Z',
      graph: {
        type: 'FeatureCollection',
        features: [{ properties: { kind: 'official', sources: 'vaylavirasto-wfs' } }],
      },
    });
  });

  it('rejects an invalid view before reading the graph file', async () => {
    const app = Fastify();
    apps.push(app);
    await registerApiRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/routing-graph?bbox=59,24,58,25',
    });

    expect(response.statusCode).toBe(400);
    expect(loadPreparedRoutingGraph).not.toHaveBeenCalled();
  });
});

function graphFixture(): PreparedRoutingGraph {
  return {
    version: 'seapro-routing-graph-v2',
    builtAt: '2026-08-09T12:00:00.000Z',
    bbox: [59, 24, 60, 25],
    nodes: [
      { id: 0, position: [24.01, 59.01] },
      { id: 1, position: [24.09, 59.09] },
      { id: 2, position: [24.8, 59.8] },
      { id: 3, position: [24.9, 59.9] },
    ],
    edges: [
      {
        id: 'official',
        from: 0,
        to: 1,
        geometry: [[24.01, 59.01], [24.09, 59.09]],
        kind: 'official',
        official: true,
        sourceIds: ['vaylavirasto-wfs'],
        sourceFeatureIds: ['fairway-1'],
      },
      {
        id: 'outside',
        from: 2,
        to: 3,
        geometry: [[24.8, 59.8], [24.9, 59.9]],
        kind: 'recommended',
        official: false,
        sourceIds: ['openstreetmap-overpass'],
        sourceFeatureIds: ['route-2'],
      },
    ],
    routingSupport: {
      bbox: [59, 24, 60, 25],
      hazards: [],
      corridors: [],
      restrictions: [],
      sources: [],
    },
    stats: {
      inputCorridors: 2,
      inputLines: 2,
      rejectedLines: 0,
      duplicateLines: 0,
      intersections: 0,
      snappedEndpoints: 0,
    },
  };
}
