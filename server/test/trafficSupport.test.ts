import { describe, expect, it } from 'vitest';
import { trafficSchemesToRoutingVectors } from '../src/routing/trafficSupport.js';

const stamp = {
  source: 'openstreetmap-overpass' as const,
  fetchedAt: '2026-08-10T18:00:00.000Z',
  stale: false,
};

describe('staatiline liiklusskeemi routingutugi', () => {
  it('tuletab ühesuunalise raja suuna samast joonejärjekorrast nagu kaardinool', () => {
    const result = trafficSchemesToRoutingVectors([{
      id: 'way/1',
      kind: 'separation_lane',
      geometry: { type: 'LineString', coordinates: [[24, 59], [25, 59]] },
    }], stamp);

    expect(result.corridors).toEqual([expect.objectContaining({
      kind: 'traffic_lane',
      direction: 'one_way',
      directionDegrees: expect.closeTo(90, 5),
      category: 'separation_lane',
    })]);
  });

  it('hoiab päris eraldusala piiranguna ja jätab sihtjoone routingutoest välja', () => {
    const result = trafficSchemesToRoutingVectors([
      {
        id: 'relation/2',
        kind: 'separation_zone',
        geometry: { type: 'Polygon', coordinates: [[
          [24, 59], [25, 59], [25, 60], [24, 59],
        ]] },
      },
      {
        id: 'way/3',
        kind: 'navigation_line',
        geometry: { type: 'LineString', coordinates: [[24, 59], [25, 60]] },
      },
    ], stamp);

    expect(result.corridors).toEqual([]);
    expect(result.restrictions).toEqual([expect.objectContaining({
      kind: 'separation_zone',
      category: 'separation_zone',
    })]);
  });

  it('jagab mitmeosalise raja osadeks, et mõlema suund säiliks', () => {
    const result = trafficSchemesToRoutingVectors([{
      id: 'relation/4',
      kind: 'traffic_lane',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [[24, 59], [25, 59]],
          [[25, 60], [24, 60]],
        ],
      },
    }], stamp);

    expect(result.corridors).toHaveLength(2);
    expect(result.corridors.map((corridor) => Math.round(corridor.directionDegrees!)))
      .toEqual([90, 270]);
  });
});
