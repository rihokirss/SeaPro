import { database } from './pool.js';
import { historyConfig, DAY } from './config.js';

export const historyMetrics: {
  maintenance: unknown;
  storage: unknown;
  gaps: unknown[];
  error: string | null;
} = { maintenance: null, storage: null, gaps: [], error: null };
let timer: NodeJS.Timeout | undefined;
let busy = false;
export async function refreshHistoryMetrics() {
  if (busy) return;
  busy = true;
  try {
    const [maintenance, size, volume, gaps] = await Promise.all([
      database.query("SELECT value FROM app_metadata WHERE key='maintenance'"),
      database.query(
        "SELECT pg_database_size(current_database())::text AS database_bytes,pg_total_relation_size('ais_track_blocks')::text AS blocks_bytes,pg_total_relation_size('ais_heatmap')::text AS heatmap_bytes",
      ),
      database.query(`SELECT (SELECT count(*) FROM ais_points WHERE day >= (now() AT TIME ZONE 'UTC')::date - 1 AND received_at >= now()-interval '24 hours')::text AS recent_points,
        (SELECT avg(octet_length(payload)::numeric/NULLIF(point_count,0)) FROM ais_track_blocks) AS packed_bytes_per_point,
        (SELECT sum(point_count) FROM ais_track_blocks)::text AS packed_points,
        (SELECT min(received_at) FROM ais_points WHERE day >= (now() AT TIME ZONE 'UTC')::date - 1) AS started_at`),
      database.query('SELECT started_at,ended_at,reason FROM history_gaps ORDER BY started_at DESC LIMIT 10'),
    ]);
    const v = volume.rows[0],
      elapsed = v.started_at ? Math.min(1, Math.max(1 / 24, (Date.now() - v.started_at.getTime()) / DAY)) : 0;
    const pointsPerDay = elapsed ? Math.round(Number(v.recent_points) / elapsed) : 0;
    // An estimate until real cold blocks exist, never used to silently alter retention.
    const packedBytes = v.packed_bytes_per_point ? Number(v.packed_bytes_per_point) : 40;
    const hotBytes = 230;
    const projected = historyConfig.aisDays
      ? Math.round(
          pointsPerDay *
            (Math.min(historyConfig.hotDays, historyConfig.aisDays) * hotBytes +
              Math.max(0, historyConfig.aisDays - historyConfig.hotDays) * packedBytes),
        )
      : null;
    historyMetrics.maintenance = maintenance.rows[0]?.value ?? null;
    historyMetrics.storage = {
      ...size.rows[0],
      ...v,
      pointsPerDay,
      projectedHistoryBytes: projected,
      projectedHistoryWithBackupsBytes: projected === null ? null : projected*(1+Number(process.env.DATABASE_BACKUP_KEEP??2)),
      packedEstimate: v.packed_bytes_per_point === null,
      backupCopies: Number(process.env.DATABASE_BACKUP_KEEP ?? 2),
      note: 'Projection excludes heatmap growth and other applications; backups require additional space.',
    };
    historyMetrics.gaps = gaps.rows;
    historyMetrics.error = null;
  } catch {
    historyMetrics.error = 'Ajaloo mõõdikud ei ole ajutiselt kättesaadavad';
  } finally {
    busy = false;
  }
}
export function startHistoryMonitor() {
  void refreshHistoryMetrics();
  timer = setInterval(() => void refreshHistoryMetrics(), 300000);
  timer.unref();
}
export function stopHistoryMonitor() {
  clearInterval(timer);
}
