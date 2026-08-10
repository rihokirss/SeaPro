import { describe, expect, it } from 'vitest';
import type { RoutingFeatureSource } from '../src/routing/sourceTypes.js';
import {
  pointInRoutingGeometry,
  routingGeometryBbox,
} from '../src/routing/sourceGeometry.js';
import {
  parseEstonianRoutingData,
  type EstonianRoutingCollections,
} from '../src/routing/sources/estonia.js';
import {
  estonianWarningsSourceMeta,
  parseEstonianNavigationWarnings,
} from '../src/routing/sources/estoniaWarnings.js';
import {
  finnishWarningsSourceMeta,
  parseFinnishNavigationWarnings,
} from '../src/routing/sources/finlandWarnings.js';
import {
  parseFinnishRoutingData,
  type FinnishRoutingCollections,
} from '../src/routing/sources/finland.js';
import {
  parseLengthMetres,
  parseOsmRoutingData,
  validateOverpassRoutingResponse,
  type OverpassRoutingResponse,
} from '../src/routing/sources/osm.js';
import estoniaFixture from './fixtures/routing-estonia.json';
import finlandFixture from './fixtures/routing-finland.json';
import osmFixture from './fixtures/routing-osm.json';

const ESTONIA_STAMP: RoutingFeatureSource = {
  source: 'transpordiamet-his',
  fetchedAt: '2026-08-08T12:00:00.000Z',
  stale: false,
};
const FINLAND_STAMP: RoutingFeatureSource = {
  source: 'vaylavirasto-wfs',
  fetchedAt: '2026-08-08T12:00:00.000Z',
  stale: true,
};
const OSM_STAMP: RoutingFeatureSource = {
  source: 'openstreetmap-overpass',
  fetchedAt: '2026-08-08T12:00:00.000Z',
  stale: false,
};

describe('routing-andmeallikate parserid', () => {
  it('normaliseerib Eesti HIS-i kivid, takistused, vrakid, märgid, laevateed, sadamad ja mõõtealad', () => {
    const result = parseEstonianRoutingData(
      estoniaFixture as EstonianRoutingCollections,
      ESTONIA_STAMP,
    );

    expect(result.hazards).toHaveLength(4);
    expect(result.hazards.find((hazard) => hazard.kind === 'obstruction')).toMatchObject({
      id: 'transpordiamet-his:obstruction:533416',
      depthM: 1.79,
      sizeM: 5.04,
      heightM: 0.69,
      confidence: 'high',
      surveyAreaId: '2567',
      source: 'transpordiamet-his',
      stale: false,
    });
    expect(result.hazards.find((hazard) => hazard.kind === 'wreck')).toMatchObject({
      name: 'Testlaev',
      depthM: 4.2,
      sizeM: 18,
    });
    expect(result.corridors[0]).toMatchObject({
      kind: 'fairway',
      name: 'Kuivarahu',
      depthM: 3.4,
      maxDraughtM: 2.8,
      widthM: 30,
      official: true,
    });
    expect(result.surveyAreas[0]).toMatchObject({
      ihoS44Category: '1',
      surveyedAt: '2011-01-28T00:00:00.000Z',
      statusCode: '5',
    });
    expect(result.harbours[0]).toMatchObject({
      name: 'TILGU SADAM',
      maxLengthM: 11,
      maxBeamM: 3,
      maxDraughtM: 0.7,
      official: true,
    });
  });

  it('normaliseerib Soome faarvaatrid, aktiivsed piirangud, sillad/lüüsid ja AToN rikked', () => {
    const result = parseFinnishRoutingData(
      finlandFixture as FinnishRoutingCollections,
      FINLAND_STAMP,
      '2026-08-08T12:00:00Z',
    );

    expect(result.hazards).toEqual([expect.objectContaining({
      kind: 'physical_aid',
      name: 'Lågharun',
      geometry: { type: 'Point', coordinates: [24.9834, 60.1153] },
      stale: true,
    })]);
    expect(result.corridors[0]).toMatchObject({
      geometryRole: 'area',
      name: 'Ravamatalan väylä',
      maxDraughtM: 4,
      sweptDepthM: 4.8,
      directionDegrees: 83,
      direction: 'two_way',
      fairwayNumber: '5740',
    });
    expect(result.corridors[0]?.depthM).toBeUndefined();
    expect(result.corridors[1]).toMatchObject({
      geometryRole: 'centreline',
      maxDraughtM: 1.8,
      sweptDepthM: 2.7,
    });
    expect(result.corridors[1]?.depthM).toBeUndefined();
    expect(result.restrictions).toHaveLength(4);
    expect(result.restrictions.find((item) => item.kind === 'restricted_area')).toMatchObject({
      name: 'Biskopsö strömmen',
      prohibited: false,
      speedLimitMps: 5,
      validFrom: '2021-06-01T00:00:00.000Z',
    });
    expect(result.restrictions.find((item) => item.kind === 'bridge')).toMatchObject({
      name: 'Mustola',
      maxHeightM: 24.5,
      maxBeamM: 12.6,
      maxLengthM: 82.5,
      maxDraughtM: 4.4,
      opens: true,
    });
    expect(result.restrictions.find((item) => item.id === 'vaylavirasto-wfs:bridge:35822'))
      .toMatchObject({
        kind: 'bridge',
        name: 'Savilahden silta',
        maxHeightM: 8.5,
        operation: 'kaytossa',
        description: 'Vesistösilta',
      });
    expect(result.restrictions.map((item) => item.id))
      .not.toContain('vaylavirasto-wfs:bridge:road-only');
    expect(result.warnings.map((warning) => warning.severity)).toEqual(['caution', 'critical']);
  });

  it('ei käsitle Soome virtuaalset AIS AToN-i füüsilise takistusena', () => {
    const collections = structuredClone(finlandFixture) as FinnishRoutingCollections;
    collections.aids.features![0]!.properties!.turvalaitetyyppikoodi = 1;
    collections.aids.features!.push({
      id: 'turvalaitteet_uusi.virtual-1',
      geometry: { type: 'Point', coordinates: [24.99, 60.12] },
      properties: {
        id: 'virtual-1',
        nimifi: 'Virtuaalinen AIS-turvalaite',
        alityyppi: 'VIRTUAALINEN',
        virtual: true,
      },
    });

    const result = parseFinnishRoutingData(
      collections,
      FINLAND_STAMP,
      '2026-08-08T12:00:00Z',
    );
    expect(result.hazards).toHaveLength(1);
    expect(result.hazards.map((hazard) => hazard.id)).not.toContain(
      'vaylavirasto-wfs:physical-aid:virtual-1',
    );
  });

  it('lisab ainult väljumishetkel kehtiva Eesti navigatsioonihoiatuse', () => {
    const result = parseEstonianNavigationWarnings([
      {
        id: 'warning:7:1',
        geometry: { type: 'Polygon', coordinates: [[[24, 59], [24.1, 59], [24.1, 59.1], [24, 59.1], [24, 59]]] },
        titleEt: 'Ala liikluseks suletud',
        validFrom: '2026-08-08T10:00:00Z',
        validTo: '2026-08-08T14:00:00Z',
      },
      {
        id: 'warning:7:2',
        geometry: { type: 'Point', coordinates: [24.2, 59.2] },
        titleEt: 'Hilisem töö',
        validFrom: '2026-08-09T10:00:00Z',
      },
    ], ESTONIA_STAMP.fetchedAt, '2026-08-08T12:00:00Z');

    expect(result).toEqual([expect.objectContaining({
      id: 'transpordiamet-warnings:warning:7:1',
      kind: 'navigation_warning',
      severity: 'critical',
      source: 'transpordiamet-warnings',
    })]);
  });

  it("säilitab aegunud Eesti hoiatusallika stale meta ja feature stamp'i", () => {
    const source = estonianWarningsSourceMeta(
      'stale',
      ESTONIA_STAMP.fetchedAt,
      'värskendamine ebaõnnestus',
      600,
    );
    const warnings = parseEstonianNavigationWarnings([{
      id: 'warning:7:stale',
      geometry: { type: 'Point', coordinates: [24.2, 59.2] },
      titleEt: 'Aegunud hoiatus',
    }], ESTONIA_STAMP.fetchedAt, '2026-08-08T12:00:00Z', true);

    expect(source).toMatchObject({ status: 'stale', stale: true, coverage: 'complete' });
    expect(warnings[0]?.stale).toBe(true);
  });

  it('lisab Traficomi aktiivse hoiatuse Soome marsruudi ettevaatuskihti', () => {
    const warnings = parseFinnishNavigationWarnings([{
      id: 'traficom-warning:86',
      geometry: { type: 'Point', coordinates: [24.94, 60.17] },
      number: 86,
      source: 'traficom',
      titleFi: 'Väylä suljettu',
      titleEn: 'Fairway closed',
      textFi: 'Veneilijöitä kehotetaan varovaisuuteen.',
      textEn: 'Yachtsmen are advised to navigate with caution.',
      publishedAt: '2026-08-08T09:00:00Z',
    }], FINLAND_STAMP.fetchedAt, '2026-08-08T12:00:00Z');

    expect(warnings).toEqual([expect.objectContaining({
      id: 'traficom-warnings:traficom-warning:86',
      kind: 'navigation_warning',
      name: 'Fairway closed',
      severity: 'critical',
      reportedAt: '2026-08-08T09:00:00Z',
      source: 'traficom-warnings',
    })]);
  });

  it("säilitab aegunud Traficomi hoiatusallika stale meta ja feature stamp'i", () => {
    const source = finnishWarningsSourceMeta(
      'stale',
      FINLAND_STAMP.fetchedAt,
      'värskendamine ebaõnnestus',
      600,
    );
    const warnings = parseFinnishNavigationWarnings([{
      id: 'traficom-warning:stale',
      geometry: { type: 'Point', coordinates: [24.94, 60.17] },
      titleEn: 'Stale warning',
    }], FINLAND_STAMP.fetchedAt, '2026-08-08T12:00:00Z', true);

    expect(source).toMatchObject({ status: 'stale', stale: true, coverage: 'complete' });
    expect(warnings[0]?.stale).toBe(true);
  });

  it('normaliseerib OSM-i soovitusliku tee, ohud, TSS-i, silla ja keeluala', () => {
    const result = parseOsmRoutingData(osmFixture as OverpassRoutingResponse, OSM_STAMP);

    expect(result.hazards).toEqual([expect.objectContaining({
      kind: 'rock',
      depthM: 1.7,
      confidence: 'low',
      waterLevelCode: 'submerged',
    })]);
    expect(result.corridors).toEqual([expect.objectContaining({
      kind: 'recommended',
      name: 'Soovituslik tee',
      directionDegrees: 92,
      direction: 'one_way',
      official: false,
    })]);
    expect(result.restrictions.find((item) => item.kind === 'separation_zone')?.geometry.type)
      .toBe('Polygon');
    expect(result.restrictions.find((item) => item.kind === 'bridge')).toMatchObject({
      maxHeightM: 3.2,
      opens: true,
    });
    expect(result.restrictions.find((item) => item.kind === 'restricted_area')).toMatchObject({
      prohibited: true,
      geometry: { type: 'MultiPolygon' },
    });
    expect(result.harbours).toEqual([expect.objectContaining({
      name: 'Jussarö vierassatama',
      official: false,
      geometry: { type: 'Point', coordinates: [23.5706, 59.8294] },
    })]);
  });

  it('tõlgendab suletud OSM fairway ala, mitte keskjoonena', () => {
    const result = parseOsmRoutingData({
      elements: [{
        type: 'way',
        id: 99,
        tags: { 'seamark:type': 'fairway' },
        geometry: [
          { lon: 24, lat: 59 },
          { lon: 24.01, lat: 59 },
          { lon: 24.01, lat: 59.01 },
          { lon: 24, lat: 59.01 },
          { lon: 24, lat: 59 },
        ],
      }],
    }, OSM_STAMP);

    expect(result.corridors).toEqual([expect.objectContaining({
      kind: 'recommended',
      geometryRole: 'area',
      geometry: expect.objectContaining({ type: 'Polygon' }),
    })]);
  });

  it('teisendab OSM-i silla mõõtude ühikud meetriteks ja hülgab tundmatu ühiku', () => {
    expect(parseLengthMetres('12 ft')).toBeCloseTo(3.6576);
    expect(parseLengthMetres("12' 6\"")).toBeCloseTo(3.81);
    expect(parseLengthMetres('250 cm')).toBeCloseTo(2.5);
    expect(parseLengthMetres('3200 mm')).toBeCloseTo(3.2);
    expect(parseLengthMetres('0,004 km')).toBeCloseTo(4);
    expect(parseLengthMetres('3.2 m')).toBeCloseTo(3.2);
    expect(parseLengthMetres('3.2')).toBeCloseTo(3.2);
    expect(parseLengthMetres('10 fathoms')).toBeUndefined();

    const response: OverpassRoutingResponse = {
      elements: [{
        type: 'node',
        id: 55,
        lat: 59,
        lon: 24,
        tags: {
          'seamark:type': 'bridge',
          maxheight: '12 ft',
          maxwidth: '250 cm',
        },
      }],
    };
    const bridge = parseOsmRoutingData(response, OSM_STAMP).restrictions[0];
    expect(bridge).toMatchObject({ kind: 'bridge', maxBeamM: 2.5 });
    expect(bridge?.kind === 'bridge' ? bridge.maxHeightM : undefined).toBeCloseTo(3.6576);

    const rock = parseOsmRoutingData({ elements: [{
      type: 'node', id: 56, lat: 59, lon: 24,
      tags: { 'seamark:type': 'rock', 'seamark:rock:least_depth': '12 ft' },
    }] }, OSM_STAMP).hazards[0];
    expect(rock?.depthM).toBeCloseTo(3.6576);
  });

  it('ei aktsepteeri Overpassi HTTP 200 osalist või struktuurita vastust', () => {
    expect(() => validateOverpassRoutingResponse({
      elements: [],
      remark: 'runtime error: Query timed out',
    })).toThrow(/osalise vastuse/i);
    expect(() => validateOverpassRoutingResponse({ version: 0.6 }))
      .toThrow(/elements massiiv/i);
    expect(() => validateOverpassRoutingResponse({ elements: [] })).not.toThrow();
  });
});

describe('routingu GeoJSON abid', () => {
  const polygon = {
    type: 'Polygon' as const,
    coordinates: [
      [[20, 58], [22, 58], [22, 60], [20, 60], [20, 58]],
      [[20.5, 58.5], [21, 58.5], [21, 59], [20.5, 59], [20.5, 58.5]],
    ] as [number, number][][],
  };

  it('arvestab polügooni auke ja serva', () => {
    expect(pointInRoutingGeometry([21.5, 59.5], polygon)).toBe(true);
    expect(pointInRoutingGeometry([20.75, 58.75], polygon)).toBe(false);
    expect(pointInRoutingGeometry([20, 59], polygon)).toBe(true);
  });

  it('tagastab lõuna-lääs-põhi-ida piirdekasti', () => {
    expect(routingGeometryBbox(polygon)).toEqual([58, 20, 60, 22]);
  });
});
