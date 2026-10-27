import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from '../src/http.js';
import { NavigationSnapshots, navigationSnapshots } from '../src/navigation/snapshots.js';
import { fetchExerciseAreasWithMeta, fetchLightSectors, fetchLocalNavigationAids } from '../src/navigation/estoniaSupplemental.js';
import { mergeLocalNavigationAids } from '../src/navigation/merge.js';
import { loadEstonianExerciseAreas, preferOfficialExerciseAreas } from '../src/routing/sources/estoniaExerciseAreas.js';
import type { ExerciseArea, NavigationAid } from '@seapro/shared';
import type { RoutingAreaRestriction } from '../src/routing/sourceTypes.js';

const BBOX = [58, 23, 60, 25] as [number, number, number, number];
const polygon: ExerciseArea['geometry'] = { type: 'Polygon', coordinates: [[[24, 59], [24.1, 59], [24.1, 59.1], [24, 59.1], [24, 59]]] };
const aidFeature = (id = 1, lat = 59) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [24, lat] },
  properties: { objectid: id, number: 999, nimi: 'Sadama parem tooder', liik: 'Parema külje tooder', 'värv': 'roheline', kirjeldus: 'Kohalik kirjeldus' } });
const areaFeature = { type: 'Feature', geometry: polygon, properties: { objectid: 1, objnam: '1A' } };
const collection = (features: unknown[], more = false) => ({ type: 'FeatureCollection', features, exceededTransferLimit: more });

describe('Eesti täiendavate navigatsioonikihtide püsikoopiad', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'seapro-extra-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
    const store = new NavigationSnapshots(directory);
    vi.spyOn(navigationSnapshots, 'get').mockImplementation(store.get.bind(store));
    vi.spyOn(http, 'fetchJson').mockResolvedValue(collection([]));
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it('laadib kõigi alade ühise koopia, taastab selle restarti järel ja säilitab tõrkel', async () => {
    vi.mocked(http.fetchJson).mockResolvedValue(collection([aidFeature(), aidFeature(2, 60.5)]));
    const first = await fetchLocalNavigationAids(BBOX);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ unregulated: true, category: 'lateral-starboard', markColours: ['green'] });
    expect(first[0]?.atonCode).toBeUndefined(); // teenuse lokaalne number pole NMA number
    vi.mocked(http.fetchJson).mockClear();
    const restarted = new NavigationSnapshots(directory);
    vi.mocked(navigationSnapshots.get).mockImplementation(restarted.get.bind(restarted));
    const other = await fetchLocalNavigationAids([60.4, 23, 60.6, 25]);
    expect(other[0]?.id).toBe('aton:local:2');
    expect(http.fetchJson).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 31 * 86400_000);
    vi.mocked(http.fetchJson).mockRejectedValue(new Error('Offline'));
    const fallback = await fetchLocalNavigationAids(BBOX);
    expect(fallback[0]?.id).toBe(first[0]?.id);
    expect(fallback[0]?.registryStale).toBe(true);
    await fetchLocalNavigationAids(BBOX);
    expect(http.fetchJson).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 3601_000);
    vi.mocked(http.fetchJson).mockResolvedValue(collection([aidFeature(3)]));
    expect((await fetchLocalNavigationAids(BBOX))[0]?.id).toBe('aton:local:3');
  });

  it('ei kirjuta head koopiat osalise, vigase ega korduvate lehekülgedega üle', async () => {
    vi.mocked(http.fetchJson).mockResolvedValue(collection([aidFeature()]));
    await fetchLocalNavigationAids(BBOX);
    vi.setSystemTime(Date.now() + 31 * 86400_000);
    vi.mocked(http.fetchJson).mockResolvedValue(collection([aidFeature(3)], true));
    const saved = await fetchLocalNavigationAids(BBOX);
    expect(saved[0]?.id).toBe('aton:local:1');
    expect(saved[0]?.registryStale).toBe(true);
    expect(http.fetchJson).toHaveBeenCalledTimes(3); // esmane + katkise korduv leht
    vi.setSystemTime(Date.now() + 3601_000);
    vi.mocked(http.fetchJson).mockResolvedValue(collection([{ ...aidFeature(4), geometry: null }]));
    expect((await fetchLocalNavigationAids(BBOX))[0]?.id).toBe('aton:local:1');
  });

  it('laadib sektoreid lehekülgedena, säilitab eraldi päeva/öö ja algsed suunad', async () => {
    vi.mocked(http.fetchJson).mockImplementation(async (value) => {
      const url = new URL(value);
      const layer = Number(url.pathname.split('/').at(-2));
      const secondPage = url.searchParams.get('resultOffset') !== '0';
      if (layer !== 5 && layer !== 18) return collection([]);
      if (secondPage) return collection([]);
      return collection([{ type: 'Feature', geometry: polygon, properties: { objectid: 1, aton: '045',
        atonn: 'Vaindloo tuletorn', night_day: layer === 5 ? 'night' : 'day', sect_colour: 'W',
        begin_direction: 350, end_direction: 10, range: 11 } }], layer === 5);
    });
    const sectors = await fetchLightSectors(BBOX);
    expect(sectors).toHaveLength(2);
    expect(sectors.map((s) => s.mode)).toEqual(['night', 'day']);
    expect(sectors[0]).toMatchObject({ atonCode: '045', fromDegrees: 350, toDegrees: 10, geometry: polygon });
    expect(http.fetchJson).toHaveBeenCalledTimes(9);
    expect((await fetchLightSectors([57, 20, 58, 21]))).toHaveLength(0);
    expect(http.fetchJson).toHaveBeenCalledTimes(9);
  });

  it('käsitleb laskeala püsiva ettevaatusinfona ilma aktiivse hoiatuse väiteta', async () => {
    vi.mocked(http.fetchJson).mockResolvedValue(collection([areaFeature]));
    const mapData = await fetchExerciseAreasWithMeta(BBOX);
    const routeData = await loadEstonianExerciseAreas(BBOX);
    expect(mapData.value).toHaveLength(1);
    expect(routeData.warnings[0]).toMatchObject({ kind: 'exercise_area', severity: 'caution' });
    expect(routeData.source.status).toBe('ok');
    expect(http.fetchJson).toHaveBeenCalledTimes(1);
  });
});

describe('kattuvate objektide ühendamine', () => {
  const official: NavigationAid = { id: 'nma:1', name: 'Registri parem tooder', kind: 'floating',
    category: 'lateral-starboard', lat: 59, lon: 24, atonCode: '123', sources: ['registry'] };
  const local: NavigationAid = { ...official, id: 'local:1', atonCode: undefined, name: 'Kohalik parem',
    lat: 59.00002, unregulated: true, description: 'Lisainfo', sources: ['transpordiamet-local'] };

  it('säilitab registri identiteedi ja lisab ainult täiendava kirjelduse', () => {
    const merged = mergeLocalNavigationAids([official], [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'nma:1', atonCode: '123', name: official.name,
      description: 'Lisainfo', sources: ['registry', 'transpordiamet-local'] });
    expect(merged[0]?.unregulated).toBeUndefined();
    expect(official.sources).toEqual(['registry']);
  });

  it('ei liida vastaskülje märki, kaugemat eri nimega märki ega mitut märki üheks', () => {
    expect(mergeLocalNavigationAids([official], [{ ...local, category: 'lateral-port' }])).toHaveLength(2);
    expect(mergeLocalNavigationAids([official], [{ ...local, lat: 59.00025 }])).toHaveLength(2);
    expect(mergeLocalNavigationAids([official], [local, { ...local, id: 'local:2' }])).toHaveLength(2);
  });

  const area: ExerciseArea = { id: 'area:1', name: '1A', geometry: polygon };
  const osm: RoutingAreaRestriction = { id: 'osm:1', name: 'Firing area 1A', kind: 'restricted_area',
    rule: 'military', geometry: polygon, source: 'openstreetmap-overpass', prohibited: false,
    fetchedAt: '2026-10-27T12:00:00Z', stale: false };
  it('asendab OSM-i sama laskeala ametlikuga, kuid jätab keelud ja muud alad alles', () => {
    const banned = { ...osm, id: 'osm:2', prohibited: true };
    const other = { ...osm, id: 'osm:3', rule: 'fishing_prohibited', name: 'Fishing area' };
    expect(preferOfficialExerciseAreas([osm, banned, other], [area])).toEqual([banned, other]);
    expect(preferOfficialExerciseAreas([osm], [])).toEqual([osm]);
  });
});
