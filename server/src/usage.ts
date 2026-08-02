import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type OpenMeteoApi = 'forecast' | 'marine';
export type OpenMeteoUse = 'grid' | 'point';
export type CacheOutcome = 'fresh' | 'stale' | 'shared' | 'loaded' | 'error';

interface UpstreamCounter {
  requests: number;
  estimatedUnits: number;
  successes: number;
  failures: number;
}

interface CacheCounter {
  fresh: number;
  stale: number;
  shared: number;
  loaded: number;
  error: number;
}

interface HourBucket {
  /** UTC tund kujul YYYY-MM-DDTHH. */
  hour: string;
  apiRequests: number;
  /** Kuupõhiselt soolatud seansi-ID räsi; algset ID-d ei salvestata. */
  sessions: Set<string>;
  upstream: Record<OpenMeteoApi, Record<OpenMeteoUse, UpstreamCounter>>;
  cache: Record<OpenMeteoUse, CacheCounter>;
}

interface PersistedHourBucket extends Omit<HourBucket, 'sessions'> {
  sessions: string[];
}

interface UsageFile {
  version: 1;
  startedAt: number;
  hours: PersistedHourBucket[];
}

interface PeriodSummary {
  sessions: number;
  apiRequests: number;
  upstream: {
    requests: number;
    estimatedUnits: number;
    successes: number;
    failures: number;
    forecast: UpstreamCounter;
    marine: UpstreamCounter;
  };
  cache: CacheCounter & {
    lookups: number;
    hits: number;
    hitRatePercent: number | null;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../data');
const USAGE_FILE = join(DATA_DIR, 'openmeteo-usage.json');
const RETENTION_MS = 45 * 24 * 3600 * 1000;
const SESSION_HEADER_RE = /^[A-Za-z0-9_-]{16,80}$/;

function upstreamCounter(): UpstreamCounter {
  return { requests: 0, estimatedUnits: 0, successes: 0, failures: 0 };
}

function cacheCounter(): CacheCounter {
  return { fresh: 0, stale: 0, shared: 0, loaded: 0, error: 0 };
}

function bucket(hour: string): HourBucket {
  return {
    hour,
    apiRequests: 0,
    sessions: new Set(),
    upstream: {
      forecast: { grid: upstreamCounter(), point: upstreamCounter() },
      marine: { grid: upstreamCounter(), point: upstreamCounter() },
    },
    cache: { grid: cacheCounter(), point: cacheCounter() },
  };
}

function addUpstream(target: UpstreamCounter, source: UpstreamCounter): void {
  target.requests += source.requests;
  target.estimatedUnits += source.estimatedUnits;
  target.successes += source.successes;
  target.failures += source.failures;
}

function addCache(target: CacheCounter, source: CacheCounter): void {
  target.fresh += source.fresh;
  target.stale += source.stale;
  target.shared += source.shared;
  target.loaded += source.loaded;
  target.error += source.error;
}

function validCounter(value: unknown): value is Record<string, number> {
  return Boolean(value) && typeof value === 'object';
}

/**
 * Püsiv, privaatsust hoidev kasutusmõõdik.
 *
 * Open-Meteo kulu loetakse kohas, kus päris HTTP-päring välja läheb — mitte
 * SeaPro `/api/grid` päringute järgi, sest enamik neist tuleb cache'ist.
 * Seansi-ID on brauseri juhuslik väärtus; server salvestab ainult kuupõhiselt
 * soolatud räsi, mida ei saa järgmise kuu andmetega kokku viia.
 */
export class UsageMeter {
  #hours = new Map<string, HourBucket>();
  #startedAt = Date.now();
  #dirty = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly file = USAGE_FILE) {}

  #current(now = Date.now()): HourBucket {
    const hour = new Date(now).toISOString().slice(0, 13);
    let current = this.#hours.get(hour);
    if (!current) {
      current = bucket(hour);
      this.#hours.set(hour, current);
    }
    return current;
  }

  #sessionHash(sessionId: string, now: number): string {
    const month = new Date(now).toISOString().slice(0, 7);
    return createHash('sha256').update(`${month}:${sessionId}`).digest('hex').slice(0, 32);
  }

  recordApiRequest(sessionId: string | undefined, now = Date.now()): void {
    const current = this.#current(now);
    current.apiRequests++;
    if (sessionId && SESSION_HEADER_RE.test(sessionId)) {
      current.sessions.add(this.#sessionHash(sessionId, now));
    }
    this.#dirty = true;
  }

  recordUpstreamRequest(
    api: OpenMeteoApi,
    use: OpenMeteoUse,
    estimatedUnits: number,
    now = Date.now(),
  ): void {
    const counter = this.#current(now).upstream[api][use];
    counter.requests++;
    counter.estimatedUnits += Math.max(0, estimatedUnits);
    this.#dirty = true;
  }

  recordUpstreamResult(
    api: OpenMeteoApi,
    use: OpenMeteoUse,
    success: boolean,
    now = Date.now(),
  ): void {
    const counter = this.#current(now).upstream[api][use];
    if (success) counter.successes++;
    else counter.failures++;
    this.#dirty = true;
  }

  recordCache(use: OpenMeteoUse, outcome: CacheOutcome, now = Date.now()): void {
    this.#current(now).cache[use][outcome]++;
    this.#dirty = true;
  }

  #summarize(prefix: string): PeriodSummary {
    const sessions = new Set<string>();
    const forecast = upstreamCounter();
    const marine = upstreamCounter();
    const cache = cacheCounter();
    let apiRequests = 0;

    for (const current of this.#hours.values()) {
      if (!current.hour.startsWith(prefix)) continue;
      apiRequests += current.apiRequests;
      current.sessions.forEach((id) => sessions.add(id));
      addUpstream(forecast, current.upstream.forecast.grid);
      addUpstream(forecast, current.upstream.forecast.point);
      addUpstream(marine, current.upstream.marine.grid);
      addUpstream(marine, current.upstream.marine.point);
      addCache(cache, current.cache.grid);
      addCache(cache, current.cache.point);
    }

    const total = upstreamCounter();
    addUpstream(total, forecast);
    addUpstream(total, marine);
    const lookups = cache.fresh + cache.stale + cache.shared + cache.loaded + cache.error;
    // `shared` ei tulnud mälust, kuid säästis eraldi upstream-päringu. Kulumõõdiku
    // jaoks on see cache-tabamus: kasutaja päring ei tekitanud uut API-kutset.
    const hits = cache.fresh + cache.stale + cache.shared;

    return {
      sessions: sessions.size,
      apiRequests,
      upstream: { ...total, forecast, marine },
      cache: {
        ...cache,
        lookups,
        hits,
        hitRatePercent: lookups > 0 ? Math.round((hits / lookups) * 1000) / 10 : null,
      },
    };
  }

  snapshot(monthlyLimit: number, now = Date.now()): {
    startedAt: string;
    today: PeriodSummary;
    month: PeriodSummary;
    projection: {
      observedHours: number;
      estimatedUnits: number;
      monthlyLimit: number;
      limitUsedPercent: number;
    };
  } {
    const date = new Date(now);
    const dayPrefix = date.toISOString().slice(0, 10);
    const monthPrefix = date.toISOString().slice(0, 7);
    const month = this.#summarize(monthPrefix);
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const observedStart = Math.max(monthStart, this.#startedAt);
    const observedMs = Math.max(1, now - observedStart);
    const projected = Math.round(
      month.upstream.estimatedUnits * ((monthEnd - monthStart) / observedMs),
    );

    return {
      startedAt: new Date(this.#startedAt).toISOString(),
      today: this.#summarize(dayPrefix),
      month,
      projection: {
        observedHours: Math.round((observedMs / 3600_000) * 10) / 10,
        estimatedUnits: projected,
        monthlyLimit,
        limitUsedPercent:
          monthlyLimit > 0 ? Math.round((projected / monthlyLimit) * 1000) / 10 : 0,
      },
    };
  }

  loadFromDisk(log?: (message: string) => void): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as UsageFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.hours)) return;
      this.#startedAt = Number.isFinite(parsed.startedAt) ? parsed.startedAt : Date.now();
      const cutoff = Date.now() - RETENTION_MS;

      for (const saved of parsed.hours) {
        const stamp = Date.parse(`${saved.hour}:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(saved.hour) || stamp < cutoff) continue;
        const current = bucket(saved.hour);
        current.apiRequests = Number(saved.apiRequests) || 0;
        current.sessions = new Set(Array.isArray(saved.sessions) ? saved.sessions : []);

        for (const api of ['forecast', 'marine'] as const) {
          for (const use of ['grid', 'point'] as const) {
            const source = saved.upstream?.[api]?.[use];
            if (validCounter(source)) {
              current.upstream[api][use] = {
                requests: Number(source.requests) || 0,
                estimatedUnits: Number(source.estimatedUnits) || 0,
                successes: Number(source.successes) || 0,
                failures: Number(source.failures) || 0,
              };
            }
          }
        }
        for (const use of ['grid', 'point'] as const) {
          const source = saved.cache?.[use];
          if (validCounter(source)) {
            current.cache[use] = {
              fresh: Number(source.fresh) || 0,
              stale: Number(source.stale) || 0,
              shared: Number(source.shared) || 0,
              loaded: Number(source.loaded) || 0,
              error: Number(source.error) || 0,
            };
          }
        }
        this.#hours.set(current.hour, current);
      }
      log?.(`Kasutusmõõdik kettalt: ${this.#hours.size} tunnikirjet`);
    } catch (err) {
      log?.(`Kasutusmõõdiku fail on rikutud, alustan tühjalt: ${String(err)}`);
    }
  }

  #prune(now = Date.now()): void {
    const cutoff = now - RETENTION_MS;
    for (const [hour] of this.#hours) {
      if (Date.parse(`${hour}:00:00Z`) < cutoff) this.#hours.delete(hour);
    }
  }

  flush(log?: (message: string) => void): void {
    if (!this.#dirty) return;
    this.#prune();
    const hours: PersistedHourBucket[] = [...this.#hours.values()].map((current) => ({
      ...current,
      sessions: [...current.sessions],
    }));
    const file: UsageFile = { version: 1, startedAt: this.#startedAt, hours };

    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(file), 'utf8');
      renameSync(temporary, this.file);
      this.#dirty = false;
      log?.(`Kasutusmõõdik kettale: ${hours.length} tunnikirjet`);
    } catch (err) {
      log?.(`Kasutusmõõdiku kirjutamine ebaõnnestus: ${String(err)}`);
    }
  }

  startPersisting(intervalSeconds = 60, log?: (message: string) => void): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.flush(log), intervalSeconds * 1000);
    this.#timer.unref();
  }

  stopPersisting(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

export const usageMeter = new UsageMeter();
