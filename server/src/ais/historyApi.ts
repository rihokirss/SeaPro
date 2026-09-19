import { historyMetrics } from '../db/monitor.js';
import type { FastifyInstance } from 'fastify';
import { database, databaseStatus } from '../db/pool.js';
import { historyConfig, cutoff, DAY } from '../db/config.js';
import { writeQueue } from '../db/queue.js';
import { vesselTrack } from './history.js';
export function historyHealth() {
  return { ...databaseStatus, queue: writeQueue.status, settings: historyConfig, metrics: historyMetrics };
}
export async function registerHistoryApi(app: FastifyInstance) {
  app.get('/api/ais/vessels', async (req, reply) => {
    const input = (req.query as Record<string, string>).mmsi;
    if (!input || !/^\d{1,9}(,\d{1,9}){0,99}$/.test(input) || input.split(',').some((v) => Number(v) <= 0))
      return reply.code(400).send({ error: 'Anna kuni 100 komadega eraldatud MMSI-t' });
    try {
      const ids = [...new Set(input.split(',').map(Number))];
      const result = await database.query(
        'SELECT data,last_seen FROM ais_vessels WHERE mmsi=ANY($1::int[]) AND last_seen >= $2',
        [ids, new Date(cutoff(historyConfig.aisDays)).toISOString()],
      );
      return {
        vessels: result.rows.map((r) => ({
          ...r.data,
          stale: Date.now() - r.last_seen.getTime() > 30 * 60_000,
        })),
      };
    } catch {
      return reply.code(503).send({ error: 'Laevaajalugu ei ole ajutiselt kättesaadav' });
    }
  });
  app.get('/api/ais/vessels/:mmsi/track', async (req, reply) => {
    const raw = (req.params as { mmsi: string }).mmsi,
      q = req.query as Record<string, string>;
    const from = Date.parse(q.from ?? ''),
      to = Date.parse(q.to ?? '');
    if (
      !/^\d{1,9}$/.test(raw) ||
      Number(raw) <= 0 ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from >= to ||
      to - from > 7 * DAY ||
      to > Date.now() + 60000
    )
      return reply.code(400).send({ error: 'Vali kehtiv MMSI ja kuni 7-päevane ajavahemik' });
    try {
      reply.header('Cache-Control', 'no-store');
      return await vesselTrack(Number(raw), from, to);
    } catch (error) {
      if (error instanceof RangeError) return reply.code(413).send({ error: 'Vali lühem ajavahemik' });
      req.log.warn({ err: error }, 'AIS ajaloo päring ebaõnnestus');
      return reply.code(503).send({ error: 'Laevaajalugu ei ole ajutiselt kättesaadav' });
    }
  });
}
