import { database } from './db/pool.js';
import { writeQueue } from './db/queue.js';
import { historyConfig, DAY, cutoff } from './db/config.js';
import type {
  ModelSkillPoint,
  ModelSkillReport,
  ModelSkillWindReport,
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
const RETENTION_MS = historyConfig.weatherDays ? historyConfig.weatherDays * DAY : Infinity;
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

export interface PersistedVerification {
  version: 1;
  collectionStartedAt: string;
  observations: ObservationSample[];
  forecasts: ForecastSample[];
}

interface TimedObservation {
  sample: ObservationSample;
  time: number;
}

interface TimedForecast {
  sample: ForecastSample;
  validTime: number;
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
  #observationPositions = new Map<string, number>();
  #forecastPositions = new Map<string, number>();
  #observationsByPoint = new Map<string, TimedObservation[]>();
  #forecastsByLeadPoint = new Map<VerificationLead, Map<string, TimedForecast[]>>();
  #latestObservationAt: string | null = null;
  #latestForecastAt: string | null = null;
  #indexesDirty = false;
  #lastPrunedAt = 0;
  #revision = 0;
  #queryCache = new Map<string, ModelSkillReport | ModelSkillSeriesReport | ModelSkillWindReport>();

  constructor(state?: PersistedVerification) {
    this.#state = {
      version: 1,
      collectionStartedAt: new Date().toISOString(),
      observations: [],
      forecasts: [],
    };
    if (state) this.restore(state);
  }

  restore(state: PersistedVerification): void {
    this.#state = structuredClone(state);
    this.#rebuildIndexes();
    this.#queryCache.clear();
  }

  snapshot(): PersistedVerification { return structuredClone(this.#state); }

  recordObservation(sample: ObservationSample): void {
    this.#maybePrune();
    const key = observationKey(sample);
    const index = this.#observationPositions.get(key) ?? -1;
    if (index >= 0) this.#state.observations[index] = sample;
    else {
      this.#observationPositions.set(key, this.#state.observations.length);
      this.#state.observations.push(sample);
    }
    this.#markChanged();
  }

  recordForecast(sample: ForecastSample): void {
    this.#maybePrune();
    const key = forecastKey(sample);
    const index = this.#forecastPositions.get(key) ?? -1;
    if (index >= 0) this.#state.forecasts[index] = sample;
    else {
      this.#forecastPositions.set(key, this.#state.forecasts.length);
      this.#state.forecasts.push(sample);
    }
    this.#markChanged();
  }

  report(days: VerificationDays, leadHours: VerificationLead, now = Date.now(), pointId?: string): ModelSkillReport {
    this.#ensureIndexes();
    const cacheKey = `report|${this.#revision}|${Math.floor(now / 60_000)}|${days}|${leadHours}|${pointId ?? '*'}`;
    const cached = this.#queryCache.get(cacheKey);
    if (cached) return cached as ModelSkillReport;

    const cutoff = now - days * 24 * 3600_000;
    const selectedPoints = pointId
      ? VERIFICATION_POINTS.filter((point) => point.id === pointId)
      : VERIFICATION_POINTS;
    const selectedIds = new Set(selectedPoints.map((point) => point.id));

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

    const forecastsByPoint = this.#forecastsByLeadPoint.get(leadHours);
    for (const selectedPointId of selectedIds) {
      const forecasts = forecastsByPoint?.get(selectedPointId) ?? [];
      const observations = this.#observationsByPoint.get(selectedPointId) ?? [];
      for (let index = lowerBound(forecasts, cutoff, (item) => item.validTime); index < forecasts.length; index++) {
        const timedForecast = forecasts[index]!;
        if (timedForecast.validTime > now) break;
        const forecast = timedForecast.sample;
        const observation = nearestObservation(observations, timedForecast.validTime);
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

    const result: ModelSkillReport = {
      generatedAt: new Date(now).toISOString(),
      collectionStartedAt: this.#state.collectionStartedAt,
      lastObservationAt: this.#latestObservationAt,
      lastForecastAt: this.#latestForecastAt,
      days,
      leadHours,
      pointId: pointId ?? null,
      points: VERIFICATION_POINTS.map(({ id, name, country, observationProviderId }) => ({
        id, name, country, observationProviderId,
      })),
      sources,
    };
    this.#cacheQuery(cacheKey, result);
    return result;
  }

  series(days: VerificationDays, leadHours: VerificationLead, pointId: string, now = Date.now()): ModelSkillSeriesReport {
    const point = VERIFICATION_POINTS.find((item) => item.id === pointId);
    if (!point) throw new Error(`Tundmatu kontrollpunkt: ${pointId}`);
    this.#ensureIndexes();
    const cacheKey = `series|${this.#revision}|${Math.floor(now / 60_000)}|${days}|${leadHours}|${pointId}`;
    const cached = this.#queryCache.get(cacheKey);
    if (cached) return cached as ModelSkillSeriesReport;

    const cutoff = now - days * 24 * 3600_000;
    const observations = this.#observationsByPoint.get(pointId) ?? [];
    const entries = new Map<string, ModelSkillSeriesReport['sources'][number]['entries']>();
    for (const source of SOURCES) entries.set(source.id, []);
    const forecasts = this.#forecastsByLeadPoint.get(leadHours)?.get(pointId) ?? [];
    for (let index = lowerBound(forecasts, cutoff, (item) => item.validTime); index < forecasts.length; index++) {
      const timedForecast = forecasts[index]!;
      if (timedForecast.validTime > now) break;
      const forecast = timedForecast.sample;
      const observation = nearestObservation(observations, timedForecast.validTime);
      if (!observation) continue;
      entries.get(forecast.sourceId)?.push({
        capturedAt: forecast.capturedAt,
        validAt: forecast.validAt,
        observedAt: observation.observedAt,
        forecastWindSpeed: forecast.windSpeed,
        forecastWindGust: forecast.windGust,
        forecastWindDirection: forecast.windDirection,
        observedWindSpeed: observation.windSpeed,
        observedWindGust: observation.windGust,
        observedWindDirection: observation.windDirection,
      });
    }
    const sources = SOURCES.map((source) => ({
      sourceId: source.id,
      label: source.label,
      entries: entries.get(source.id)!,
    }));

    const result: ModelSkillSeriesReport = {
      generatedAt: new Date(now).toISOString(),
      days,
      leadHours,
      point: { id: point.id, name: point.name, country: point.country, observationProviderId: point.observationProviderId },
      sources,
    };
    this.#cacheQuery(cacheKey, result);
    return result;
  }

  windReport(days: VerificationDays, leadHours: VerificationLead, now = Date.now(), pointId?: string): ModelSkillWindReport {
    this.#ensureIndexes();
    const key = `wind|${this.#revision}|${Math.floor(now / 60_000)}|${days}|${leadHours}|${pointId ?? '*'}`;
    const cached = this.#queryCache.get(key);
    if (cached) return cached as ModelSkillWindReport;
    const points = VERIFICATION_POINTS.filter((point) => !pointId || point.id === pointId);
    const reports = points.map((point) => this.series(days, leadHours, point.id, now));
    const sources = SOURCES.filter((source) => reports.some((report) => report.sources.some(
      (item) => item.sourceId === source.id && item.entries.some((entry) => entry.forecastWindSpeed !== null && entry.observedWindSpeed !== null),
    ))).map((source) => ({ sourceId: source.id, label: source.label }));
    const bins = Array.from({ length: 11 }, (_, index) => ({
      from: index * 2, to: index === 10 ? null : index * 2 + 2,
      stations: new Map<string, Map<string, { abs: number; bias: number; n: number }>>(),
    }));
    for (const report of reports) {
      // Üks võrdlus jaama ja prognoosiaja kohta; kõigil mudelitel sama valim.
      const bySource = new Map(report.sources.map((source) => {
        const times = new Map<number, typeof source.entries[number]>();
        for (const entry of source.entries) {
          if (entry.forecastWindSpeed === null || entry.observedWindSpeed === null) continue;
          const validTime = Date.parse(entry.validAt);
          const previous = times.get(validTime);
          if (!previous || Date.parse(entry.capturedAt) > Date.parse(previous.capturedAt)) times.set(validTime, entry);
        }
        return [source.sourceId, times] as const;
      }));
      const first = sources[0] && bySource.get(sources[0].sourceId);
      if (!first) continue;
      for (const [time, observation] of first) {
        const entries = sources.map((source) => bySource.get(source.sourceId)?.get(time));
        if (entries.some((entry) => !entry)) continue;
        const speed = observation.observedWindSpeed!;
        if (speed < 0) continue;
        const bin = bins[Math.min(10, Math.floor(speed / 2))]!;
        let station = bin.stations.get(report.point.id);
        if (!station) { station = new Map(); bin.stations.set(report.point.id, station); }
        sources.forEach((source, index) => {
          const error = entries[index]!.forecastWindSpeed! - speed;
          const acc = station!.get(source.sourceId) ?? { abs: 0, bias: 0, n: 0 };
          acc.abs += Math.abs(error); acc.bias += error; acc.n++;
          station!.set(source.sourceId, acc);
        });
      }
    }
    const result: ModelSkillWindReport = {
      generatedAt: new Date(now).toISOString(), days, leadHours, pointId: pointId ?? null, sources,
      bins: bins.map((bin) => ({
        from: bin.from, to: bin.to, stations: bin.stations.size,
        samples: [...bin.stations.values()].reduce((sum, station) => sum + (station.values().next().value?.n ?? 0), 0),
        sources: bin.stations.size === 0 ? [] : sources.map((source) => {
          const values = [...bin.stations.values()].map((station) => station.get(source.sourceId)!);
          return { sourceId: source.sourceId, mae: macroAverage(values, (value) => value.abs / value.n)!, bias: macroAverage(values, (value) => value.bias / value.n)! };
        }),
      })),
    };
    this.#cacheQuery(key, result);
    return result;
  }

  #cacheQuery(key: string, value: ModelSkillReport | ModelSkillSeriesReport | ModelSkillWindReport): void {
    if (this.#queryCache.size >= 256) this.#queryCache.clear();
    this.#queryCache.set(key, value);
  }

  #markChanged(): void {
    this.#dirty = true;
    this.#indexesDirty = true;
    this.#revision++;
    this.#queryCache.clear();
  }

  #ensureIndexes(): void {
    if (this.#indexesDirty) this.#rebuildIndexes();
  }

  /** Ehitab stringiaegadest ühe korra arvulised, sorteeritud otsinguindeksid. */
  #rebuildIndexes(): void {
    this.#observationPositions.clear();
    this.#forecastPositions.clear();
    this.#observationsByPoint.clear();
    this.#forecastsByLeadPoint.clear();
    this.#latestObservationAt = null;
    this.#latestForecastAt = null;
    let latestObservationTime = -Infinity;
    let latestForecastTime = -Infinity;

    this.#state.observations.forEach((sample, index) => {
      this.#observationPositions.set(observationKey(sample), index);
      const time = isoTime(sample.observedAt);
      if (time === null) return;
      const items = this.#observationsByPoint.get(sample.pointId) ?? [];
      items.push({ sample, time });
      this.#observationsByPoint.set(sample.pointId, items);
      if (time > latestObservationTime) {
        latestObservationTime = time;
        this.#latestObservationAt = sample.observedAt;
      }
    });
    for (const items of this.#observationsByPoint.values()) {
      items.sort((a, b) => a.time - b.time);
    }

    this.#state.forecasts.forEach((sample, index) => {
      this.#forecastPositions.set(forecastKey(sample), index);
      const validTime = isoTime(sample.validAt);
      const capturedTime = isoTime(sample.capturedAt);
      if (capturedTime !== null && capturedTime > latestForecastTime) {
        latestForecastTime = capturedTime;
        this.#latestForecastAt = sample.capturedAt;
      }
      if (validTime === null) return;
      let byPoint = this.#forecastsByLeadPoint.get(sample.leadHours);
      if (!byPoint) {
        byPoint = new Map();
        this.#forecastsByLeadPoint.set(sample.leadHours, byPoint);
      }
      const items = byPoint.get(sample.pointId) ?? [];
      items.push({ sample, validTime });
      byPoint.set(sample.pointId, items);
    });
    for (const byPoint of this.#forecastsByLeadPoint.values()) {
      for (const items of byPoint.values()) items.sort((a, b) => a.validTime - b.validTime);
    }
    this.#indexesDirty = false;
  }

  #maybePrune(now = Date.now()): void {
    if (now - this.#lastPrunedAt < 3600_000) return;
    const changed = this.#prune(now);
    this.#rebuildIndexes();
    if (changed) {
      this.#dirty = true;
      this.#revision++;
      this.#queryCache.clear();
    }
  }

  #prune(now = Date.now()): boolean {
    const cutoff = now - RETENTION_MS;
    const observationsBefore = this.#state.observations.length;
    const forecastsBefore = this.#state.forecasts.length;
    this.#state.observations = this.#state.observations.filter((item) => (isoTime(item.observedAt) ?? 0) >= cutoff);
    this.#state.forecasts = this.#state.forecasts.filter((item) => (isoTime(item.validAt) ?? 0) >= cutoff);
    this.#lastPrunedAt = now;
    this.#indexesDirty = true;
    return observationsBefore !== this.#state.observations.length
      || forecastsBefore !== this.#state.forecasts.length;
  }
}

function lowerBound<T>(items: T[], target: number, timeOf: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timeOf(items[middle]!) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nearestObservation(items: TimedObservation[], target: number): ObservationSample | null {
  const next = lowerBound(items, target, (item) => item.time);
  const before = items[next - 1];
  const after = items[next];
  const best = !before
    ? after
    : !after || target - before.time <= after.time - target
      ? before
      : after;
  return best && Math.abs(best.time - target) <= OBSERVATION_MATCH_MS ? best.sample : null;
}

/** Query-scoped calculator: production never loads the complete archive into memory. */
class DatabaseVerificationStore {
  private cache = new Map<string, {at: number; value: unknown}>();
  recordObservation(sample: ObservationSample) { writeQueue.enqueue({kind:'observation', data:sample}); this.cache.clear(); }
  recordForecast(sample: ForecastSample) { writeQueue.enqueue({kind:'forecast', data:sample}); this.cache.clear(); }
  async calculate(kind: 'report' | 'series' | 'windReport', days: VerificationDays, lead: VerificationLead, now: number, pointId?: string): Promise<any> {
    const key=JSON.stringify([kind,days,lead,pointId,Math.floor(now/60000)]);
    const cached=this.cache.get(key); if(cached && now-cached.at<60000) return cached.value;
    const lower=Math.max(now-days*DAY, cutoff(historyConfig.weatherDays,now));
    const retention=new Date(cutoff(historyConfig.weatherDays,now)).toISOString();
    const [observations,forecasts,meta,latest]=await Promise.all([
      database.query('SELECT data FROM weather_observations WHERE observed_at >= $1 AND observed_at <= $2 AND ($3::text IS NULL OR point_id=$3)',[new Date(Math.max(lower-1800000,cutoff(historyConfig.weatherDays,now))).toISOString(),new Date(now+1800000).toISOString(),pointId??null]),
      database.query('SELECT data FROM weather_forecasts WHERE valid_at >= $1 AND valid_at <= $2 AND lead_hours=$3 AND ($4::text IS NULL OR point_id=$4)',[new Date(lower).toISOString(),new Date(now).toISOString(),lead,pointId??null]),
      database.query("SELECT value FROM app_metadata WHERE key='verificationStartedAt'"),
      database.query("SELECT (SELECT data->>'observedAt' FROM weather_observations WHERE observed_at >= $1 ORDER BY observed_at DESC LIMIT 1) AS observation, (SELECT data->>'capturedAt' FROM weather_forecasts WHERE valid_at >= $1 ORDER BY captured_at DESC LIMIT 1) AS forecast",[retention]),
    ]);
    const calculator=new ModelVerificationStore({version:1,collectionStartedAt:meta.rows[0]?.value??new Date(now).toISOString(),observations:observations.rows.map(r=>r.data),forecasts:forecasts.rows.map(r=>r.data)});
    const value=kind==='series' ? calculator.series(days,lead,pointId!,now) : calculator[kind](days,lead,now,pointId);
    if(kind==='report') Object.assign(value,{ lastObservationAt:latest.rows[0].observation??null, lastForecastAt:latest.rows[0].forecast??null });
    if(this.cache.size>=32) this.cache.clear(); this.cache.set(key,{at:now,value}); return value;
  }
  report(days: VerificationDays, lead: VerificationLead, now=Date.now(), pointId?: string) { return this.calculate('report',days,lead,now,pointId); }
  series(days: VerificationDays, lead: VerificationLead, pointId: string, now=Date.now()) { return this.calculate('series',days,lead,now,pointId); }
  windReport(days: VerificationDays, lead: VerificationLead, now=Date.now(), pointId?: string) { return this.calculate('windReport',days,lead,now,pointId); }
}
export const modelVerification = new DatabaseVerificationStore();
type SampleWriter = Pick<ModelVerificationStore, 'recordObservation' | 'recordForecast'>;

let observationTimer: NodeJS.Timeout | null = null;
let forecastTimer: NodeJS.Timeout | null = null;
const collectionTasks = new Set<Promise<void>>();
function trackCollection(task: Promise<void>) { collectionTasks.add(task); void task.finally(() => collectionTasks.delete(task)); }
let observationsRunning = false;
let forecastsRunning = false;

export function startModelVerification(log: Logger): void {
  writeQueue.enqueue({kind:'metadata',data:{key:'verificationStartedAt',value:new Date().toISOString()}});

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

  trackCollection(collectObservations());
  trackCollection(collectForecasts());
  observationTimer = setInterval(() => trackCollection(collectObservations()), 5 * 60_000);
  forecastTimer = setInterval(() => trackCollection(collectForecasts()), THREE_HOURS_MS);
  observationTimer.unref();
  forecastTimer.unref();
  log.info(`Mudelitäpsuse taustakoguja: ${VERIFICATION_POINTS.length} punkti, prognoos iga 3 h`);
}

export async function stopModelVerification(): Promise<void> {
  if (observationTimer) clearInterval(observationTimer);
  if (forecastTimer) clearInterval(forecastTimer);
  observationTimer = null;
  forecastTimer = null;
  await Promise.allSettled(collectionTasks);
}

export async function collectObservationSamples(store: SampleWriter): Promise<void> {
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

function recordReading(store: SampleWriter, point: VerificationPoint, reading: StationReading): void {
  const windSpeed = finite(reading.values.wind_speed);
  const windGust = finite(reading.values.wind_gust);
  const windDirection = finite(reading.values.wind_dir);
  if (windSpeed === null && windGust === null && windDirection === null) return;
  store.recordObservation({ pointId: point.id, observedAt: reading.observedAt!, windSpeed, windGust, windDirection });
}

export async function collectForecastSamples(store: SampleWriter, now = Date.now()): Promise<void> {
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
  store: SampleWriter,
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
