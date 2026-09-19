import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.js';
import { maintain } from './maintenance.js';
import { applyEvents, type WriteEvent } from './queue.js';
import { dataDirectory } from './config.js';
import {
  VERIFICATION_POINTS,
  ModelVerificationStore,
  type PersistedVerification,
} from '../modelVerification.js';
import { database } from './pool.js';

function validateWeather(d: PersistedVerification) {
  if (
    d.version !== 1 ||
    !Array.isArray(d.observations) ||
    !Array.isArray(d.forecasts) ||
    !Number.isFinite(Date.parse(d.collectionStartedAt))
  )
    throw new Error('Vigane mudelitäpsuse fail');
  for (const p of [...d.observations, ...d.forecasts]) {
    if (!VERIFICATION_POINTS.some((v) => v.id === p.pointId)) throw new Error('Tundmatu kontrollpunkt');
    for (const key of ['windSpeed', 'windGust', 'windDirection'] as const)
      if (p[key] !== null && !Number.isFinite(p[key])) throw new Error(`Vigane ${key}`);
    if ('validAt' in p) {
      if (
        !Number.isFinite(Date.parse(p.validAt)) ||
        !Number.isFinite(Date.parse(p.capturedAt)) ||
        ![0, 3, 12, 24, 48].includes(p.leadHours) ||
        !p.sourceId ||
        !p.sourceLabel
      )
        throw new Error('Vigane prognoos');
    } else if (!Number.isFinite(Date.parse(p.observedAt))) throw new Error('Vigane vaatlus');
  }
}
function validateUsage(d: any) {
  if (d.version !== 1 || !Number.isFinite(d.startedAt) || !Array.isArray(d.hours))
    throw new Error('Vigane kasutusstatistika');
  for (const h of d.hours) {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(h.hour) ||
      !Number.isFinite(Date.parse(`${h.hour}:00:00Z`)) ||
      !Array.isArray(h.sessions) ||
      h.sessions.some((s: unknown) => typeof s !== 'string')
    )
      throw new Error('Vigane kasutusstatistika tund');
    const check = (o: any) => {
      for (const v of Object.values(o)) {
        if (typeof v === 'object' && v !== null) check(v);
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
          throw new Error('Vigane kasutusloendur');
      }
    };
    check({ apiRequests: h.apiRequests, upstream: h.upstream, cache: h.cache });
  }
}
export async function importLegacy(
  directory: string,
  url = process.env.DATABASE_MAINTENANCE_URL ?? process.env.DATABASE_URL,
) {
  const [weatherRaw, usageRaw] = await Promise.all([
    readFile(join(directory, 'model-verification.json'), 'utf8'),
    readFile(join(directory, 'openmeteo-usage.json'), 'utf8'),
  ]);
  const weather = JSON.parse(weatherRaw) as PersistedVerification,
    usage = JSON.parse(usageRaw);
  validateWeather(weather);
  validateUsage(usage);
  const pool = new pg.Pool({ options: '-c timezone=UTC', connectionString: url }),
    client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73521003)');
    for (const point of VERIFICATION_POINTS)
      await client.query(
        'INSERT INTO verification_points VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        [point.id, point],
      );
    const events: WriteEvent[] = [
      { kind: 'metadata', data: { key: 'verificationStartedAt', value: weather.collectionStartedAt } },
      { kind: 'metadata', data: { key: 'usageStartedAt', value: usage.startedAt } },
      ...weather.observations.map((data) => ({ kind: 'observation' as const, data })),
      ...weather.forecasts.map((data) => ({ kind: 'forecast' as const, data })),
      ...usage.hours.map((data: any) => ({ kind: 'usage' as const, data })),
    ];
    await applyEvents(client, events);
    // Verify every imported record and all statistical outputs before committing.
    const obs = await client.query('SELECT data FROM weather_observations'),
      forecasts = await client.query('SELECT data FROM weather_forecasts');
    const normalize = (value: unknown): string =>
      JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      );
    const actualObs = new Map(obs.rows.map((r) => [`${r.data.pointId}|${r.data.observedAt}`, r.data]));
    const actualForecasts = new Map(
      forecasts.rows.map((r) => [
        `${r.data.pointId}|${r.data.sourceId}|${r.data.capturedAt}|${r.data.leadHours}`,
        r.data,
      ]),
    );
    for (const o of weather.observations)
      if (normalize(o) !== normalize(actualObs.get(`${o.pointId}|${o.observedAt}`)))
        throw new Error('Vaatluse migratsioonierinevus');
    for (const f of weather.forecasts)
      if (
        normalize(f) !==
        normalize(actualForecasts.get(`${f.pointId}|${f.sourceId}|${f.capturedAt}|${f.leadHours}`))
      )
        throw new Error('Prognoosi migratsioonierinevus');
    const hours = await client.query('SELECT data FROM usage_hours'),
      byHour = new Map(hours.rows.map((r) => [r.data.hour, r.data]));
    for (const h of usage.hours)
      if (normalize(h) !== normalize(byHour.get(h.hour)))
        throw new Error('Kasutusstatistika migratsioonierinevus');
    const before = new ModelVerificationStore(weather),
      after = new ModelVerificationStore({
        ...weather,
        observations: weather.observations.map((o) => actualObs.get(`${o.pointId}|${o.observedAt}`)),
        forecasts: weather.forecasts.map((f) =>
          actualForecasts.get(`${f.pointId}|${f.sourceId}|${f.capturedAt}|${f.leadHours}`),
        ),
      });
    const now = Date.now();
    for (const days of [7, 30, 90] as const)
      for (const lead of [0, 3, 12, 24, 48] as const) {
        if (
          normalize(before.report(days, lead, now)) !== normalize(after.report(days, lead, now)) ||
          normalize(before.windReport(days, lead, now)) !== normalize(after.windReport(days, lead, now))
        )
          throw new Error('Aruande migratsioonierinevus');
        for (const p of VERIFICATION_POINTS)
          if (
            normalize(before.series(days, lead, p.id, now)) !== normalize(after.series(days, lead, p.id, now))
          )
            throw new Error('Aegrea migratsioonierinevus');
      }
    await client.query(
      "INSERT INTO app_metadata VALUES('legacyImport',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [
        JSON.stringify({
          at: new Date().toISOString(),
          observations: weather.observations.length,
          forecasts: weather.forecasts.length,
          hours: usage.hours.length,
          sha256: createHash('sha256').update(weatherRaw).update(usageRaw).digest('hex'),
        }),
      ],
    );
    await client.query('COMMIT');
    return {
      observations: weather.observations.length,
      forecasts: weather.forecasts.length,
      hours: usage.hours.length,
      verification: 'all records and 135 report/series variants checked',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
async function exportLegacy(directory: string) {
  const client = await database.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const obs = await client.query('SELECT data FROM weather_observations ORDER BY observed_at'),
      forecasts = await client.query('SELECT data FROM weather_forecasts ORDER BY captured_at'),
      hours = await client.query('SELECT data FROM usage_hours ORDER BY hour'),
      meta = await client.query('SELECT * FROM app_metadata');
    const m = new Map(meta.rows.map((r) => [r.key, r.value]));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, 'model-verification.json'),
      JSON.stringify({
        version: 1,
        collectionStartedAt: m.get('verificationStartedAt'),
        observations: obs.rows.map((r) => r.data),
        forecasts: forecasts.rows.map((r) => r.data),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, 'openmeteo-usage.json'),
      JSON.stringify({
        version: 1,
        startedAt: m.get('usageStartedAt'),
        hours: hours.rows.map((r) => r.data),
      }),
      { mode: 0o600 },
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
if (process.argv[1]?.endsWith('/db/cli.ts')) {
  try {
    const command = process.argv[2];
    if (command === 'migrate') await migrate();
    else if (command === 'maintain') console.log(await maintain());
    else if (command === 'import') console.log(await importLegacy(resolve(process.argv[3] ?? dataDirectory)));
    else if (command === 'export') {
      if (!process.argv[3]) throw new Error('Määra ekspordikataloog');
      await exportLegacy(resolve(process.argv[3]));
    } else throw new Error('Käsk: migrate | maintain | import [kataloog] | export <kataloog>');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Andmebaasitoiming ebaõnnestus');
    process.exitCode = 1;
  } finally {
    await database.end();
  }
}
