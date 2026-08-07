import { describe, expect, it } from 'vitest';
import { parseTrafficSchemes } from '../src/navigation/osmTraffic.js';

describe('OSM-i liiklusskeemid', () => {
  it('jätab navimärgid välja ning teisendab suletud liiklusala polügooniks', () => {
    const schemes = parseTrafficSchemes({
      elements: [
        {
          type: 'way',
          id: 10,
          tags: { 'seamark:type': 'separation_zone', 'seamark:name': 'Tallinn TSS' },
          geometry: [
            { lat: 59, lon: 24 },
            { lat: 59, lon: 25 },
            { lat: 60, lon: 25 },
            { lat: 59, lon: 24 },
          ],
        },
        {
          type: 'way',
          id: 11,
          tags: { 'seamark:type': 'buoy_lateral' },
          geometry: [{ lat: 59, lon: 24 }, { lat: 59.1, lon: 24.1 }],
        },
      ],
    });

    expect(schemes).toEqual([expect.objectContaining({
      id: 'way/10',
      kind: 'separation_zone',
      name: 'Tallinn TSS',
      geometry: {
        type: 'Polygon',
        coordinates: [[[24, 59], [25, 59], [25, 60], [24, 59]]],
      },
    })]);
  });

  it('ühendab relationi järjestamata välisservad üheks alaks', () => {
    const schemes = parseTrafficSchemes({
      elements: [{
        type: 'relation',
        id: 20,
        tags: { 'seamark:type': 'precautionary_area' },
        members: [
          { type: 'way', ref: 2, role: 'outer', geometry: [
            { lat: 60, lon: 25 }, { lat: 59, lon: 24 },
          ] },
          { type: 'way', ref: 1, role: 'outer', geometry: [
            { lat: 59, lon: 24 }, { lat: 59, lon: 25 }, { lat: 60, lon: 25 },
          ] },
        ],
      }],
    });

    expect(schemes[0]?.geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [[[[25, 60], [24, 59], [25, 59], [25, 60]]]],
    });
  });
});
