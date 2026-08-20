import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelVerificationStore,
  VERIFICATION_POINTS,
} from '../src/modelVerification.js';

describe('mudelitäpsuse statistika', () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('seob 24 h prognoosi hilisema jaamamõõtmisega', () => {
    const store = temporaryStore(directories);
    const validAt = '2026-08-19T12:00:00.000Z';
    store.recordForecast({
      pointId: 'tallinnamadal',
      sourceId: 'open-meteo:gfs_seamless',
      sourceLabel: 'GFS',
      capturedAt: '2026-08-18T12:00:00.000Z',
      validAt,
      leadHours: 24,
      windSpeed: 6,
      windGust: 9,
      windDirection: 350,
      locationDistanceKm: null,
    });
    // METOC-i mõõtmine ei pea saabuma täpselt täistunnil; 5 min jääb lubatud aknasse.
    store.recordObservation({
      pointId: 'tallinnamadal',
      observedAt: '2026-08-19T12:05:00.000Z',
      windSpeed: 4,
      windGust: 7,
      windDirection: 10,
    });

    const report = store.report(7, 24, new Date('2026-08-20T12:00:00Z').getTime());
    const gfs = report.sources.find((source) => source.sourceId === 'open-meteo:gfs_seamless');
    expect(gfs).toMatchObject({
      samples: 1,
      stations: 1,
      windSpeedMae: 2,
      windSpeedRmse: 2,
      windSpeedBias: 2,
      windGustMae: 2,
      // Ringviga: 350° ja 10° erinevad 20°, mitte 340°.
      windDirectionMae: 20,
    });
  });

  it('ei sega hetkeprognoose 24 h statistikasse ja taastab ajaloo kettalt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'seapro-model-skill-'));
    directories.push(directory);
    const file = join(directory, 'verification.json');
    const first = new ModelVerificationStore(file);
    first.recordForecast({
      pointId: 'naissaare', sourceId: 'windfinder', sourceLabel: 'Windfinder',
      capturedAt: '2026-08-20T12:00:00.000Z', validAt: '2026-08-20T12:00:00.000Z',
      leadHours: 0, windSpeed: 5, windGust: 7, windDirection: 210, locationDistanceKm: 12,
    });
    first.recordObservation({
      pointId: 'naissaare', observedAt: '2026-08-20T12:03:00.000Z',
      windSpeed: 4, windGust: 6, windDirection: 200,
    });
    first.flush();

    const restored = new ModelVerificationStore(file);
    restored.load();
    const now = new Date('2026-08-20T13:00:00Z').getTime();
    expect(restored.report(7, 24, now).sources.find((source) => source.sourceId === 'windfinder')?.samples).toBe(0);
    expect(restored.report(7, 0, now).sources.find((source) => source.sourceId === 'windfinder')).toMatchObject({
      samples: 1,
      windSpeedMae: 1,
      averageLocationDistanceKm: 12,
    });
  });

  it('sisaldab Eesti ja Soome kontrollpunkte', () => {
    expect(VERIFICATION_POINTS.find((point) => point.id === 'tallinnamadal')).toBeTruthy();
    expect(VERIFICATION_POINTS.filter((point) => point.country === 'FI').map((point) => point.id))
      .toEqual(['helsinki-harmaja', 'hanko-russaro']);
  });

  it('filtreerib ühe punkti ja kaalub koondis jaamu võrdselt', () => {
    const store = temporaryStore(directories);
    const now = new Date('2026-08-20T12:00:00Z').getTime();
    addPair(store, 'tilgu', '2026-08-20T08:00:00Z', 4, 5);
    addPair(store, 'naissaare', '2026-08-20T08:00:00Z', 4, 13);
    addPair(store, 'naissaare', '2026-08-20T09:00:00Z', 4, 13);
    addPair(store, 'naissaare', '2026-08-20T10:00:00Z', 4, 13);

    const aggregate = store.report(7, 0, now).sources.find((source) => source.sourceId === 'open-meteo:gfs_seamless');
    const point = store.report(7, 0, now, 'naissaare').sources.find((source) => source.sourceId === 'open-meteo:gfs_seamless');
    expect(aggregate).toMatchObject({ samples: 4, stations: 2, windSpeedMae: 5 });
    expect(point).toMatchObject({ samples: 3, stations: 1, windSpeedMae: 9 });
  });

  it('märgib järjestuskõlblikuks ainult piisava katvusega mudeli', () => {
    const store = temporaryStore(directories);
    const now = new Date('2026-08-20T12:00:00Z').getTime();
    for (let index = 0; index < 12; index++) {
      const time = new Date(now - (index + 1) * 3600_000).toISOString();
      addPair(store, 'tallinnamadal', time, 5, 6, 'open-meteo:ecmwf_ifs025', 'ECMWF');
      if (index < 10) addPair(store, 'tallinnamadal', time, 5, 7);
    }
    const report = store.report(7, 0, now, 'tallinnamadal');
    expect(report.sources.find((source) => source.sourceId === 'open-meteo:gfs_seamless')).toMatchObject({
      samples: 10,
      coverage: 0.833,
      rankingEligible: true,
    });
    expect(report.sources.find((source) => source.sourceId === 'open-meteo:ecmwf_ifs025')).toMatchObject({
      samples: 12,
      coverage: 1,
      rankingEligible: true,
    });
  });

  it('tagastab punktigraafikule ainult mõõtmisega sobitatud prognoosid', () => {
    const store = temporaryStore(directories);
    const validAt = '2026-08-19T12:00:00Z';
    addPair(store, 'tallinnamadal', validAt, 5, 7, 'open-meteo:gfs_seamless', 'GFS', 24);
    store.recordForecast({
      pointId: 'tallinnamadal', sourceId: 'windfinder', sourceLabel: 'Windfinder',
      capturedAt: '2026-08-18T15:00:00Z', validAt: '2026-08-19T15:00:00Z', leadHours: 24,
      windSpeed: 8, windGust: 10, windDirection: 220, locationDistanceKm: 17,
    });
    const series = store.series(7, 24, 'tallinnamadal', new Date('2026-08-20T12:00:00Z').getTime());
    expect(series.point.id).toBe('tallinnamadal');
    expect(series.sources.find((source) => source.sourceId === 'open-meteo:gfs_seamless')?.entries).toHaveLength(1);
    expect(series.sources.find((source) => source.sourceId === 'windfinder')?.entries).toHaveLength(0);
  });
});

function temporaryStore(directories: string[]): ModelVerificationStore {
  const directory = mkdtempSync(join(tmpdir(), 'seapro-model-skill-'));
  directories.push(directory);
  return new ModelVerificationStore(join(directory, 'verification.json'));
}

function addPair(
  store: ModelVerificationStore,
  pointId: string,
  validAt: string,
  observed: number,
  forecast: number,
  sourceId = 'open-meteo:gfs_seamless',
  sourceLabel = 'GFS',
  leadHours: 0 | 3 | 12 | 24 | 48 = 0,
): void {
  const valid = new Date(validAt);
  store.recordObservation({ pointId, observedAt: valid.toISOString(), windSpeed: observed, windGust: observed + 2, windDirection: 10 });
  store.recordForecast({
    pointId, sourceId, sourceLabel,
    capturedAt: new Date(valid.getTime() - leadHours * 3600_000).toISOString(),
    validAt: valid.toISOString(), leadHours,
    windSpeed: forecast, windGust: forecast + 2, windDirection: 350, locationDistanceKm: null,
  });
}
