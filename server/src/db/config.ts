import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function historySettings(env: NodeJS.ProcessEnv = process.env) {
  const integer = (key: string, fallback: number, minimum = 0) => {
    const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(`${key} peab olema täisarv ≥ ${minimum}`);
    return value;
  };
  const settings = {
    aisDays: integer('AIS_HISTORY_RETENTION_DAYS', 30),
    hotDays: integer('AIS_HISTORY_HOT_DAYS', 7, 1),
    heatmapDays: integer('AIS_HEATMAP_RETENTION_DAYS', 0),
    weatherDays: integer('MODEL_VERIFICATION_RETENTION_DAYS', 365),
    usageDays: integer('USAGE_RETENTION_DAYS', 45),
    movingSeconds: integer('AIS_HISTORY_MOVING_INTERVAL_SECONDS', 60, 1),
    stationarySeconds: integer('AIS_HISTORY_STATIONARY_INTERVAL_SECONDS', 300, 1),
    archiveSeconds: integer('AIS_HISTORY_ARCHIVE_INTERVAL_SECONDS', 300, 1),
    queueBytes: integer('DATABASE_QUEUE_MAX_MB', 512, 1) * 1024 * 1024,
  };
  if (settings.aisDays && settings.hotDays > settings.aisDays)
    throw new Error('AIS_HISTORY_HOT_DAYS ei tohi ületada AIS_HISTORY_RETENTION_DAYS');
  return settings;
}
export const historyConfig = historySettings();
export const DAY = 86_400_000;
export function cutoff(days: number, now = Date.now()): number {
  return days === 0 ? -62135596800000 : now - days * DAY;
}
// Works both in src/db and in the bundled server/dist entrypoint.
const here = dirname(fileURLToPath(import.meta.url));
export const dataDirectory =
  process.env.SEAPRO_DATA_DIR ?? resolve(here, here.endsWith('/db') ? '../../../data' : '../../data');
