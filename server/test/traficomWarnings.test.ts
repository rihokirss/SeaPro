import { describe, expect, it } from 'vitest';
import {
  parseTraficomNavigationWarnings,
  type TraficomWarningCollection,
} from '../src/navigation/traficomWarnings.js';

describe('Traficomi navigatsioonihoiatused', () => {
  it('normaliseerib punktid, jooned ja alad samasse SeaPro hoiatusmudelisse', () => {
    const collections: TraficomWarningCollection[] = [
      {
        features: [{
          id: 'navigational_warnings_p.421',
          geometry: { type: 'MultiPoint', coordinates: [[29.415, 62.19], [29.42, 62.2]] },
          properties: {
            MESSAGESERIESIDENTIFIERINTEROPERABILITYIDENTIFIER: 'urn:mrn:fin:navwarn:FI05:VV:2026:86',
            MESSAGESERIESIDENTIFIERWARNINGNUMBER: 86,
            WARNINGINFORMATIONNAVWARNTYPEDETAILS_FI: 'Vedenalainen esine',
            WARNINGINFORMATIONNAVWARNTYPEDETAILS_EN: 'Submerged object',
            WARNINGINFORMATION_FI: 'VEDENALAINEN PUNAINEN VIITTA.',
            WARNINGINFORMATION_EN: 'UNDERWATER RED SPAR BUOY.',
            LOCALITYLOCATIONNAME_FI: 'ORIVESI HAUKIVESI-JOENSUU VÄYLÄ',
            GENERALAREALOCATIONNAME_FI: 'Vuoksen vesistö',
            LOCALITYLOCATIONNAME_EN: 'ORIVESI HAUKIVESI-JOENSUU FAIRWAY',
            GENERALAREALOCATIONNAME_EN: 'Vuoksi watercourse',
            PUBLICATIONTIME: '2026-08-09T09:39:45Z',
          },
        }],
      },
      {
        features: [{
          id: 'navigational_warnings_l.245',
          geometry: { type: 'MultiLineString', coordinates: [[[22.34, 60.39], [22.35, 60.38]]] },
          properties: {
            MESSAGESERIESIDENTIFIERWARNINGNUMBER: 17,
            NAVWARNTYPEGENERAL_FI: 'Muut vaarat',
            NAVWARNTYPEGENERAL_EN: 'Other hazards',
          },
        }],
      },
      {
        features: [{
          id: 'navigational_warnings_a.407',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[[[22.1, 60.4], [22.2, 60.4], [22.2, 60.5], [22.1, 60.4]]]],
          },
          properties: {
            MESSAGESERIESIDENTIFIERWARNINGNUMBER: 81,
            WARNINGINFORMATIONNAVWARNTYPEDETAILS_EN: 'Regatta or race',
          },
        }],
      },
    ];

    const warnings = parseTraficomNavigationWarnings(collections);

    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toMatchObject({
      id: 'traficom-warning:urn:mrn:fin:navwarn:FI05:VV:2026:86:point:1',
      geometry: { type: 'Point', coordinates: [29.415, 62.19] },
      number: 86,
      source: 'traficom',
      titleFi: 'Vedenalainen esine',
      titleEn: 'Submerged object',
      textFi: 'VEDENALAINEN PUNAINEN VIITTA.',
      textEn: 'UNDERWATER RED SPAR BUOY.',
      areaFi: 'ORIVESI HAUKIVESI-JOENSUU VÄYLÄ · Vuoksen vesistö',
      areaEn: 'ORIVESI HAUKIVESI-JOENSUU FAIRWAY · Vuoksi watercourse',
      publishedAt: '2026-08-09T09:39:45.000Z',
    });
    expect(warnings[2]).toMatchObject({
      geometry: { type: 'MultiLineString' },
      titleFi: 'Muut vaarat',
      titleEn: 'Other hazards',
    });
    expect(warnings[3]?.geometry.type).toBe('MultiPolygon');
  });

  it('jätab vigase või toetamata geomeetria vahele', () => {
    expect(parseTraficomNavigationWarnings([{ features: [
      { geometry: { type: 'MultiPoint', coordinates: [] }, properties: {} },
      { geometry: { type: 'GeometryCollection', coordinates: [] }, properties: {} },
      { geometry: { type: 'LineString', coordinates: [[24, 60]] }, properties: {} },
    ] }])).toEqual([]);
  });
});
