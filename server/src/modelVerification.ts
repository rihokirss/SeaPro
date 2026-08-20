import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ModelSkillPoint,
  ModelSkillReport,
  ModelSkillSeriesReport,
  ModelSkillSourceStats,
  StationReading,
  TimeSeries,
  Variable,
} from '@seapro/shared';
import { distanceMetres } from '@seapro/shared';
import { getProvider } from './providers/registry.js';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug?(msg: string): void;
}

export interface VerificationPoint extends ModelSkillPoint {
  stationId: string;
  lat: number;
  lon: number;
}

/**
 * Kontrollpunktid on päris tuulemõõtjate asukohad, mitte suvalised kaardipunktid.
 * Harmaja Windfinderi spot on jaamast 36 m ja Russarö oma 5,8 km kaugusel;
 * Tallinnamadala lähim spot on Rohuneeme (17,3 km), mis jääb raportis nähtavaks.
 */
export const VERIFICATION_POINTS: VerificationPoint[] = [
  { id: 'naissaare', stationId: 'naissaare', name: 'Naissaare', country: 'EE', observationProviderId: 'ilmateenistus', lat: 59.540833333, lon: 24.563333333 },
  { id: 'tilgu', stationId: 'tilgu', name: 'Tilgu', country: 'EE', observationProviderId: 'ilmateenistus', lat: 59.455795, lon: 24.48814 },
  { id: 'tallinnamadal', stationId: 'tallinnamadal', name: 'Tallinnamadal', country: 'EE', observationProviderId: 'metoc', lat: 59.71205, lon: 24.7315 },
  { id: 'keri', stationId: 'keri', name: 'Keri', country: 'EE', observationProviderId: 'metoc', lat: 59.699298, lon: 25.020338 },
  { id: 'pakri', stationId: 'pakri', name: 'Pakri', country: 'EE', observationProviderId: 'metoc', lat: 59.372836, lon: 24.040081 },
  { id: 'helsinki-harmaja', stationId: 'fmi-100996', name: 'Helsinki Harmaja', country: 'FI', observationProviderId: 'fmi', lat: 60.10512, lon: 24.97539 },
  { id: 'hanko-russaro', stationId: 'fmi-100932', name: 'Hanko Russarö', country: 'FI', observationProviderId: 'fmi', lat: 59.77363, lon: 22.94868 },
];

export const VERIFICATION_LEADS = [0, 3, 12, 24, 48] as const;
export type VerificationLead = (typeof VERIFICATION_LEADS)[number];
export const VERIFICATION_DAYS = [7, 30, 90] as const;
export type VerificationDays = (typeof VERIFICATION_DAYS)[number];

const OPEN_METEO_MODELS = [
  { id: 'metno_nordic', label: 'MET Nordic' },
  { id: 'icon_eu', label: 'ICON-EU' },
  { id: 'ecmwf_ifs025', label: 'ECMWF' },
  { id: 'gfs_seamless', label: 'GFS' },
] as const;

const SOURCES = [
  { id: 'open-meteo:best_match', label: 'Open-Meteo automaatne' },
  ...OPEN_METEO_MODELS.map((model) => ({ id: `open-meteo:${model.id}`, label: model.label })),
  { id: 'windfinder', label: 'Windfinder' },
] as const;

const WIND_VARIABLES: Variable[] = ['wind_speed', 'wind_gust', 'wind_dir'];
const THREE_HOURS_MS = 3 * 3600_000;
const RETENTION_MS = 100 * 24 * 3600_000;
// Jaamad raporteerivad 5–15 min sammuga ja prognoos on täistunnine; kuni
// poole tunni kaugune mõõtmine kirjeldab sama prognoositundi veel ausalt.
const OBSERVATION_MATCH_MS = 30 * 60_000;
const FORECAST_STEP_TOLERANCE_MS = 90 * 60_000;
const MIN_RANKING_SAMPLES = 10;
const MIN_RANKING_COVERAGE = 0.8;

export interface ObservationSample {
  pointId: string;
  observedAt: string;
  windSpeed: number | null;
  windGust: number | null;
  windDirection: number | null;
}

export interface ForecastSample {
  pointId: string;
  sourceId: string;
  sourceLabel: string;
  capturedAt: string;
  validAt: string;
  leadHours: VerificationLead;
  windSpeed: number | null;
  windGust: number | null;
  windDirection: number | null;
  locationDistanceKm: number | null;
}

interface PersistedVerification {
  version: 1;
  collectionStartedAt: string;
  observations: ObservationSample[];
  forecasts: ForecastSample[];
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function macroAverage<T>(items: T[], value: (item: T) => number, decimals = 2): number | null {
  if (items.length === 0) return null;
  return round(items.reduce((sum, item) => sum + value(item), 0) / items.length, decimals);
}

function circularDifference(a: number, b: number): number {
  const difference = Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
  return difference;
}

function isoTime(value: string): number | null {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function forecastKey(sample: ForecastSample): string {
  return `${sample.pointId}|${sample.sourceId}|${sample.capturedAt}|${sample.leadHours}`;
}

function observationKey(sample: ObservationSample): string {
  return `${sample.pointId}|${sample.observedAt}`;
}

export class ModelVerificationStore {
  #state: PersistedVerification;
  #dirty = false;

  constructor(private readonly file: string) {
    this.#state = {
      version: 1,
      collectionStartedAt: new Date().toISOString(),
      observations: [],
      forecasts: [],
    };
  }

  load(log?: (message: string) => void): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedVerification;
      if (parsed.version !== 1 || !Array.isArray(parsed.observations) || !Array.isArray(parsed.forecasts)) {
        throw new Error('tundmatu failivorming');
      }
      this.#state = parsed;
      this.#prune();
      this.#dirty = false;
      log?.(`Mudelitäpsuse ajalugu kettalt: ${parsed.observations.length} mõõtmist, ${parsed.forecasts.length} prognoosi`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log?.(`Mudelitäpsuse ajalugu ei saanud lugeda: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  recordObservation(sample: ObservationSample): void {
    const key = observationKey(sample);
    const index = this.#state.observations.findIndex((item) => observationKey(item) === key);
    if (index >= 0) this.#state.observations[index] = sample;
    else this.#state.observations.push(sample);
    this.#dirty = true;
    this.#prune();
  }

  recordForecast(sample: ForecastSample): void {
    const key = forecastKey(sample);
    const index = this.#state.forecasts.findIndex((item) => forecastKey(item) === key);
    if (index >= 0) this.#state.forecasts[index] = sample;
    else this.#state.forecasts.push(sample);
    this.#dirty = true;
    this.#prune();
  }

  flush(log?: (message: string) => void): void {
    if (!this.#dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#state));
    renameSync(temporary, this.file);
    this.#dirty = false;
    log?.(`Mudelitäpsuse ajalugu kettale: ${this.#state.observations.length} mõõtmist, ${this.#state.forecasts.length} prognoosi`);
  }

  report(days: VerificationDays, leadHours: VerificationLead, now = Date.now(), pointId?: string): ModelSkillReport {
    const cutoff = now - days * 24 * 3600_000;
    const selectedPoints = pointId
      ? VERIFICATION_POINTS.filter((point) => point.id === pointId)
      : VERIFICATION_POINTS;
    const selectedIds = new Set(selectedPoints.map((point) => point.id));
    const observations = this.#observationsByPoint(cutoff, now, selectedIds);

    interface Accumulator {
      speedAbs: number;
      speedSquared: number;
      speedBias: number;
      speedN: number;
      gustAbs: number;
      gustN: number;
      directionAbs: number;
      directionN: number;
      distance: number;
      distanceN: number;
    }
    const accumulators = new Map<string, Map<string, Accumulator>>();
    for (const source of SOURCES) accumulators.set(source.id, new Map());

    for (const forecast of this.#state.forecasts) {
      if (forecast.leadHours !== leadHours || !selectedIds.has(forecast.pointId)) continue;
      const validAt = isoTime(forecast.validAt);
      if (validAt === null || validAt < cutoff || validAt > now) continue;
      const observation = nearestObservation(observations.get(forecast.pointId) ?? [], validAt);
      if (!observation) continue;
      const sourceAccumulators = accumulators.get(forecast.sourceId);
      if (!sourceAccumulators) continue;
      let accumulator = sourceAccumulators.get(forecast.pointId);
      if (!accumulator) {
        accumulator = {
          speedAbs: 0, speedSquared: 0, speedBias: 0, speedN: 0,
          gustAbs: 0, gustN: 0, directionAbs: 0, directionN: 0,
          distance: 0, distanceN: 0,
        };
        sourceAccumulators.set(forecast.pointId, accumulator);
      }

      if (forecast.windSpeed !== null && observation.windSpeed !== null) {
        const error = forecast.windSpeed - observation.windSpeed;
        accumulator.speedAbs += Math.abs(error);
        accumulator.speedSquared += error ** 2;
        accumulator.speedBias += error;
        accumulator.speedN++;
      }
      if (forecast.windGust !== null && observation.windGust !== null) {
        accumulator.gustAbs += Math.abs(forecast.windGust - observation.windGust);
        accumulator.gustN++;
      }
      if (
        forecast.windDirection !== null && observation.windDirection !== null
        && (observation.windSpeed ?? 0) >= 1
      ) {
        accumulator.directionAbs += circularDifference(forecast.windDirection, observation.windDirection);
        accumulator.directionN++;
      }
      if (forecast.locationDistanceKm !== null) {
        accumulator.distance += forecast.locationDistanceKm;
        accumulator.distanceN++;
      }
    }

    const preliminary = SOURCES.map((source) => {
      const values = [...accumulators.get(source.id)!.values()];
      const withSpeed = values.filter((value) => value.speedN > 0);
      const withGust = values.filter((value) => value.gustN > 0);
      const withDirection = values.filter((value) => value.directionN > 0);
      const withDistance = values.filter((value) => value.distanceN > 0);
      return {
        sourceId: source.id,
        label: source.label,
        samples: withSpeed.reduce((sum, value) => sum + value.speedN, 0),
        stations: withSpeed.length,
        // Punktide kaalumata keskmine: tihedamini raporteeriv jaam ei domineeri koondit.
        windSpeedMae: macroAverage(withSpeed, (value) => value.speedAbs / value.speedN),
        windSpeedRmse: macroAverage(withSpeed, (value) => Math.sqrt(value.speedSquared / value.speedN)),
        windSpeedBias: macroAverage(withSpeed, (value) => value.speedBias / value.speedN),
        windGustMae: macroAverage(withGust, (value) => value.gustAbs / value.gustN),
        windDirectionMae: macroAverage(withDirection, (value) => value.directionAbs / value.directionN, 0),
        averageLocationDistanceKm: macroAverage(withDistance, (value) => value.distance / value.distanceN, 1),
      };
    });
    const maxSamples = Math.max(0, ...preliminary.map((source) => source.samples));
    const sources: ModelSkillSourceStats[] = preliminary.map((source) => {
      const coverage = maxSamples > 0 ? source.samples / maxSamples : 0;
      return {
        ...source,
        coverage: round(coverage, 3),
        rankingEligible:
          source.samples >= MIN_RANKING_SAMPLES
          && source.stations === selectedPoints.length
          && coverage >= MIN_RANKING_COVERAGE,
      };
    }).sort((a, b) => {
      if (a.windSpeedMae === null) return b.windSpeedMae === null ? 0 : 1;
      if (b.windSpeedMae === null) return -1;
      return a.windSpeedMae - b.windSpeedMae;
    });

    return {
      generatedAt: new Date(now).toISOString(),
      collectionStartedAt: this.#state.collectionStartedAt,
      lastObservationAt: latest(this.#state.observations.map((item) => item.observedAt)),
      lastForecastAt: latest(this.#state.forecasts.map((item) => item.capturedAt)),
      days,
      leadHours,
      pointId: pointId ?? null,
      points: VERIFICATION_POINTS.map(({ id, name, country, observationProviderId }) => ({
        id, name, country, observationProviderId,
      })),
      sources,
    };
  }

  series(days: VerificationDays, leadHours: VerificationLead, pointId: string, now = Date.now()): ModelSkillSeriesReport {
    const point = VERIFICATION_POINTS.find((item) => item.id === pointId);
    if (!point) throw new Error(`Tundmatu kontrollpunkt: ${pointId}`);
    const cutoff = now - days * 24 * 3600_000;
    const observations = this.#observationsByPoint(cutoff, now, new Set([pointId])).get(pointId) ?? [];

    const sources = SOURCES.map((source) => ({
      sourceId: source.id,
      label: source.label,
      entries: this.#state.forecasts
        .filter((forecast) => forecast.pointId === pointId && forecast.sourceId === source.id && forecast.leadHours === leadHours)
        .flatMap((forecast) => {
          const validAt = isoTime(forecast.validAt);
          if (validAt === null || validAt < cutoff || validAt > now) return [];
          const observation = nearestObservation(observations, validAt);
          if (!observation) return [];
          return [{
            capturedAt: forecast.capturedAt,
            validAt: forecast.validAt,
            observedAt: observation.observedAt,
            forecastWindSpeed: forecast.windSpeed,
            forecastWindGust: forecast.windGust,
            forecastWindDirection: forecast.windDirection,
            observedWindSpeed: observation.windSpeed,
            observedWindGust: observation.windGust,
            observedWindDirection: observation.windDirection,
          }];
        })
        .sort((a, b) => (isoTime(a.validAt) ?? 0) - (isoTime(b.validAt) ?? 0)),
    }));

    return {
      generatedAt: new Date(now).toISOString(),
      days,
      leadHours,
      point: { id: point.id, name: point.name, country: point.country, observationProviderId: point.observationProviderId },
      sources,
    };
  }

  #observationsByPoint(cutoff: number, now: number, pointIds: Set<string>): Map<string, ObservationSample[]> {
    const observations = new Map<string, ObservationSample[]>();
    for (const observation of this.#state.observations) {
      if (!pointIds.has(observation.pointId)) continue;
      const time = isoTime(observation.observedAt);
      if (time === null || time < cutoff - OBSERVATION_MATCH_MS || time > now + OBSERVATION_MATCH_MS) continue;
      const items = observations.get(observation.pointId) ?? [];
      items.push(observation);
      observations.set(observation.pointId, items);
    }
    for (const items of observations.values()) {
      items.sort((a, b) => (isoTime(a.observedAt) ?? 0) - (isoTime(b.observedAt) ?? 0));
    }
    return observations;
  }

  #prune(now = Date.now()): void {
    const cutoff = now - RETENTION_MS;
    this.#state.observations = this.#state.observations.filter((item) => (isoTime(item.observedAt) ?? 0) >= cutoff);
    this.#state.forecasts = this.#state.forecasts.filter((item) => (isoTime(item.validAt) ?? 0) >= cutoff);
  }
}

function nearestObservation(items: ObservationSample[], target: number): ObservationSample | null {
  let best: ObservationSample | null = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const time = isoTime(item.observedAt);
    if (time === null) continue;
    const distance = Math.abs(time - target);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return bestDistance <= OBSERVATION_MATCH_MS ? best : null;
}

function latest(values: string[]): string | null {
  let result: string | null = null;
  let latestTime = -Infinity;
  for (const value of values) {
    const time = isoTime(value);
    if (time !== null && time > latestTime) {
      result = value;
      latestTime = time;
    }
  }
  return result;
}

const dataDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
export const modelVerification = new ModelVerificationStore(join(dataDirectory, 'model-verification.json'));

let observationTimer: NodeJS.Timeout | null = null;
let forecastTimer: NodeJS.Timeout | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let observationsRunning = false;
let forecastsRunning = false;

export function startModelVerification(log: Logger): void {
  modelVerification.load((message) => log.info(message));

  const collectObservations = async (): Promise<void> => {
    if (observationsRunning) return;
    observationsRunning = true;
    try {
      await collectObservationSamples(modelVerification);
    } catch (error) {
      log.warn(`Mudelitäpsuse mõõtmiste kogumine ebaõnnestus: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      observationsRunning = false;
    }
  };

  const collectForecasts = async (): Promise<void> => {
    if (forecastsRunning) return;
    forecastsRunning = true;
    try {
      await collectForecastSamples(modelVerification);
    } catch (error) {
      log.warn(`Mudelitäpsuse prognooside kogumine ebaõnnestus: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      forecastsRunning = false;
    }
  };

  void collectObservations();
  void collectForecasts();
  observationTimer = setInterval(() => void collectObservations(), 5 * 60_000);
  forecastTimer = setInterval(() => void collectForecasts(), THREE_HOURS_MS);
  persistTimer = setInterval(() => modelVerification.flush((message) => log.debug?.(message)), 60_000);
  observationTimer.unref();
  forecastTimer.unref();
  persistTimer.unref();
  log.info(`Mudelitäpsuse taustakoguja: ${VERIFICATION_POINTS.length} punkti, prognoos iga 3 h`);
}

export function stopModelVerification(): void {
  if (observationTimer) clearInterval(observationTimer);
  if (forecastTimer) clearInterval(forecastTimer);
  if (persistTimer) clearInterval(persistTimer);
  observationTimer = null;
  forecastTimer = null;
  persistTimer = null;
  modelVerification.flush();
}

export async function collectObservationSamples(store: ModelVerificationStore): Promise<void> {
  const providers = new Map<string, VerificationPoint[]>();
  for (const point of VERIFICATION_POINTS) {
    const points = providers.get(point.observationProviderId) ?? [];
    points.push(point);
    providers.set(point.observationProviderId, points);
  }

  for (const [providerId, points] of providers) {
    const provider = getProvider(providerId);
    if (!provider?.stations) continue;
    const readings = await provider.stations();
    const byId = new Map(readings.map((reading) => [reading.id, reading]));
    for (const point of points) {
      const reading = byId.get(point.stationId);
      if (!reading?.observedAt) continue;
      recordReading(store, point, reading);
    }
  }
}

function recordReading(store: ModelVerificationStore, point: VerificationPoint, reading: StationReading): void {
  const windSpeed = finite(reading.values.wind_speed);
  const windGust = finite(reading.values.wind_gust);
  const windDirection = finite(reading.values.wind_dir);
  if (windSpeed === null && windGust === null && windDirection === null) return;
  store.recordObservation({ pointId: point.id, observedAt: reading.observedAt!, windSpeed, windGust, windDirection });
}

export async function collectForecastSamples(store: ModelVerificationStore, now = Date.now()): Promise<void> {
  const openMeteo = getProvider('open-meteo');
  const windfinder = getProvider('windfinder');
  if (!openMeteo?.point) return;
  const capturedAtMs = Math.floor(now / THREE_HOURS_MS) * THREE_HOURS_MS;
  const capturedAt = new Date(capturedAtMs).toISOString();

  for (const point of VERIFICATION_POINTS) {
    const [modelsResult, automaticResult] = await Promise.allSettled([
      openMeteo.point({
        lat: point.lat,
        lon: point.lon,
        hours: 55,
        variables: WIND_VARIABLES,
        models: OPEN_METEO_MODELS.map((model) => model.id),
        cellSelection: 'nearest',
      }),
      openMeteo.point({
        lat: point.lat,
        lon: point.lon,
        hours: 55,
        variables: WIND_VARIABLES,
        cellSelection: 'nearest',
      }),
    ]);

    if (modelsResult.status === 'fulfilled') {
      for (const series of modelsResult.value) {
        const model = OPEN_METEO_MODELS.find((item) => item.id === series.modelId);
        if (!model) continue;
        recordSeries(store, point, series, `open-meteo:${model.id}`, model.label, capturedAt, capturedAtMs, false);
      }
    }
    if (automaticResult.status === 'fulfilled') {
      const series = automaticResult.value.find((item) => item.modelId === 'best_match') ?? automaticResult.value[0];
      if (series) recordSeries(store, point, series, 'open-meteo:best_match', 'Open-Meteo automaatne', capturedAt, capturedAtMs, false);
    }

    // Windfinderit küsime järjestikku, et avalikule veebilehele ei läheks korraga päringupuhangut.
    if (windfinder?.point) {
      try {
        const series = (await windfinder.point({ lat: point.lat, lon: point.lon, hours: 55, variables: WIND_VARIABLES }))[0];
        if (series) recordSeries(store, point, series, 'windfinder', 'Windfinder', capturedAt, capturedAtMs, true);
      } catch {
        // Ühe spoti puudumine või parseriviga ei tohi ülejäänud mudelite kogumist katkestada.
      }
    }
  }
}

function recordSeries(
  store: ModelVerificationStore,
  point: VerificationPoint,
  series: TimeSeries,
  sourceId: string,
  sourceLabel: string,
  capturedAt: string,
  capturedAtMs: number,
  spotBased: boolean,
): void {
  const locationDistanceKm = spotBased
    ? round(distanceMetres({ lat: point.lat, lon: point.lon }, { lat: series.lat, lon: series.lon }) / 1000, 1)
    : null;

  for (const leadHours of VERIFICATION_LEADS) {
    const target = capturedAtMs + leadHours * 3600_000;
    let best = series.steps[0];
    let bestDistance = Infinity;
    for (const step of series.steps) {
      const time = isoTime(step.time);
      if (time === null) continue;
      const distance = Math.abs(time - target);
      if (distance < bestDistance) {
        best = step;
        bestDistance = distance;
      }
    }
    if (!best || bestDistance > FORECAST_STEP_TOLERANCE_MS) continue;
    const windSpeed = finite(best.values.wind_speed);
    const windGust = finite(best.values.wind_gust);
    const windDirection = finite(best.values.wind_dir);
    if (windSpeed === null && windGust === null && windDirection === null) continue;
    store.recordForecast({
      pointId: point.id,
      sourceId,
      sourceLabel,
      capturedAt,
      validAt: best.time,
      leadHours,
      windSpeed,
      windGust,
      windDirection,
      locationDistanceKm,
    });
  }
}
