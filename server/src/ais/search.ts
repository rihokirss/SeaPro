import type { Vessel, VesselSearchResponse, VesselSearchResult } from '@seapro/shared';
import { cutoff, historyConfig } from '../db/config.js';
import { database } from '../db/pool.js';
import { vessels } from './registry.js';

const LIMIT = 12;
function rank(name: string, query: string) {
  const value = name.toLowerCase();
  return value === query ? 0 : value.startsWith(query) ? 1 : 2;
}

export async function searchVessels(query: string): Promise<VesselSearchResponse> {
  const q = query.toLowerCase();
  const live = vessels.query([-90, -180, 90, 180]).filter(v => v.name?.toLowerCase().includes(q));
  let historyAvailable = true;
  let stored: Vessel[] = [];
  try {
    const rows = await database.query<{ data: Vessel }>(
      `SELECT data FROM ais_vessels
       WHERE last_seen >= $1 AND strpos(lower(data->>'name'), $2) > 0
       ORDER BY (lower(data->>'name') = $2) DESC, (strpos(lower(data->>'name'), $2) = 1) DESC,
                last_seen DESC, mmsi
       LIMIT $3`,
      [new Date(cutoff(historyConfig.aisDays)).toISOString(), q, LIMIT],
    );
    stored = rows.rows.map(r => r.data);
  } catch {
    historyAvailable = false;
  }
  const found = new Map<number, Vessel>();
  for (const v of [...stored, ...live]) {
    const old = found.get(v.mmsi);
    if (!old || Date.parse(v.timestamp) >= Date.parse(old.timestamp)) found.set(v.mmsi, v);
  }
  const results = [...found.values()]
    .sort((a, b) => rank(a.name!, q) - rank(b.name!, q) || Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.mmsi - b.mmsi)
    .slice(0, LIMIT)
    .map((v): VesselSearchResult => (
      { kind: 'vessel', name: v.name!, vessel: { ...v, stale: Date.now() - Date.parse(v.timestamp) > 30 * 60000 } }
    ));
  return { results, historyAvailable };
}
