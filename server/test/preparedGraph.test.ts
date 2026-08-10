import { describe, expect, it } from 'vitest';
import type { BBox } from '@seapro/shared';
import {
  buildPreparedRoutingGraph,
  preparedGraphGeoJson,
} from '../src/routing/preparedGraph.js';
import type {
  Position,
  RoutingCorridor,
  RoutingHarbour,
} from '../src/routing/sourceTypes.js';

const BBOX: BBox = [58.9, 23.9, 59.2, 24.3];
const FETCHED_AT = '2026-08-09T12:00:00.000Z';

describe('prepared routing graph', () => {
  it('stores the compact harbour endpoint support beside the route graph', () => {
    const harbour: RoutingHarbour = {
      id: 'test-harbour',
      kind: 'harbour',
      geometry: { type: 'Point', coordinates: [24, 59] },
      official: true,
      source: 'transpordiamet-his',
      fetchedAt: FETCHED_AT,
      stale: false,
    };
    const harbourAccessSupport = { harbours: [harbour], hazards: [], corridors: [] };
    const graph = buildPreparedRoutingGraph([], BBOX, FETCHED_AT, { harbourAccessSupport });

    expect(graph.harbourAccessSupport).toEqual(harbourAccessSupport);
  });

  it('preserves source turns and splits real intersections into one shared node', () => {
    const turn: Position = [24.1, 59.05];
    const crossing: Position = [24.15, 59.075];
    const graph = buildPreparedRoutingGraph([
      corridor('dogleg', [[24, 59], turn, [24.2, 59.1]], true),
      corridor('crossing', [[24.15, 59], [24.15, 59.15]], false),
    ], BBOX, FETCHED_AT, { maxEdgeLengthM: Number.POSITIVE_INFINITY });

    expect(graph.nodes.some((node) => samePosition(node.position, turn))).toBe(true);
    const crossingNode = graph.nodes.find((node) => samePosition(node.position, crossing));
    expect(crossingNode).toBeDefined();
    expect(graph.edges.filter((edge) => edge.from === crossingNode!.id || edge.to === crossingNode!.id))
      .toHaveLength(4);
    expect(graph.stats.intersections).toBe(1);
  });

  it('snaps coincident endpoints but keeps unrelated nearby geometry separate', () => {
    const graph = buildPreparedRoutingGraph([
      corridor('first', [[24, 59], [24.1, 59]], true),
      corridor('joined', [[24.10004, 59], [24.2, 59]], false),
      corridor('separate', [[24.1002, 59.0001], [24.2, 59.1]], false),
    ], BBOX, FETCHED_AT, { maxEdgeLengthM: Number.POSITIVE_INFINITY });

    const officialEnd = graph.nodes.find((node) => samePosition(node.position, [24.1, 59]));
    expect(officialEnd).toBeDefined();
    expect(graph.edges.filter((edge) => edge.from === officialEnd!.id || edge.to === officialEnd!.id))
      .toHaveLength(2);
    expect(graph.stats.snappedEndpoints).toBe(1);
  });

  it('removes duplicate, area, leading-line and loop input from the runtime graph', () => {
    const valid = corridor('valid', [[24, 59], [24.1, 59], [24.2, 59]], true);
    const duplicate = corridor('duplicate', [[24.2, 59], [24.1, 59], [24, 59]], false);
    const loop = corridor('loop', [[24, 59.05], [24.1, 59.05], [24, 59.05]], false);
    const area: RoutingCorridor = {
      ...corridor('area', [[24, 59.1], [24.1, 59.1]], true),
      geometryRole: 'area',
    };
    const leading = {
      ...corridor('leading', [[24, 59.15], [24.1, 59.15]], false),
      category: 'navigation_line',
    };
    const graph = buildPreparedRoutingGraph(
      [valid, duplicate, loop, area, leading],
      BBOX,
      FETCHED_AT,
      { maxEdgeLengthM: Number.POSITIVE_INFINITY },
    );

    expect(graph.edges).toHaveLength(2);
    expect(graph.stats.duplicateLines).toBe(1);
    expect(graph.stats.rejectedLines).toBe(1);
    expect(graph.edges.flatMap((edge) => edge.sourceFeatureIds)).toEqual(['valid', 'valid']);
  });

  it('returns only view-intersecting edges for the comparison layer', () => {
    const graph = buildPreparedRoutingGraph([
      corridor('west', [[24, 59], [24.05, 59]], true),
      corridor('east', [[24.2, 59.1], [24.25, 59.1]], false),
    ], BBOX, FETCHED_AT, { maxEdgeLengthM: Number.POSITIVE_INFINITY });
    const view = preparedGraphGeoJson(graph, [58.99, 23.99, 59.01, 24.06]);

    expect(view.features).toHaveLength(1);
    expect(view.features[0]!.properties).toMatchObject({ kind: 'official', official: true });
  });
});

function corridor(
  id: string,
  coordinates: Position[],
  official: boolean,
): RoutingCorridor {
  return {
    id,
    kind: official ? 'fairway' : 'recommended',
    geometryRole: 'centreline',
    geometry: { type: 'LineString', coordinates },
    official,
    source: official ? 'vaylavirasto-wfs' : 'openstreetmap-overpass',
    fetchedAt: FETCHED_AT,
    stale: false,
  };
}

function samePosition(left: Position, right: Position): boolean {
  return Math.abs(left[0] - right[0]) < 1e-8 && Math.abs(left[1] - right[1]) < 1e-8;
}
