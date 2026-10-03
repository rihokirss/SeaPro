import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fetchText } from '../http.js';
import { hisRequests } from '../hisRequests.js';

const WFS = 'https://his.vta.ee:8443/HIS/WFS';
const LAYERS = ['mooteala', 'vrakk', 'takist', 'aton', 'laevatee', 'sadam', 'kivi'] as const;
const MAX_PAGE = 10_000;
const BATCH_SIZE = 1_000;
const REFRESH_DAYS = 30;
// Eesti WFS-i ametlik katvus EPSG:3301-s, jäetud äärest varuga.
// GML koordinaatide järjestus on siin põhi, ida.
const ESTONIA_3301: Bounds = [6_300_000, 150_000, 6_750_000, 850_000];
type Bounds = [number, number, number, number];
type Layer = typeof LAYERS[number];
type RecordData = { feature_id: string; properties: Record<string, string>; gml: string | null };

function wfsUrl(layer: Layer, options: Record<string, string>): string {
  const url = new URL(WFS);
  url.search = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: layer, ...options,
  }).toString();
  return url.toString();
}

async function wfs(layer: Layer, options: Record<string, string>): Promise<string> {
  return hisRequests.run(() => fetchText(wfsUrl(layer, options), {
    timeoutMs: 120_000,
    retries: 2,
  }));
}

export function featureCount(xml: string): number {
  const count = Number(xml.match(/\bnumberOfFeatures="(\d+)"/)?.[1]);
  if (!Number.isSafeInteger(count) || count < 0 || !xml.includes('FeatureCollection')) {
    throw new Error('HIS WFS tagastas vigase kirjete arvu');
  }
  return count;
}

function xmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity] ?? _match;
  });
}

export function parseFeatures(xml: string): RecordData[] {
  const records: RecordData[] = [];
  for (const member of xml.matchAll(/<wfs:featureMember>([\s\S]*?)<\/wfs:featureMember>/g)) {
    const body = member[1]!;
    const featureId = body.match(/\bgml:id="([^"]+)"/)?.[1];
    const geometry = body.match(/<gml:(Point|Curve|LineString|Polygon|MultiSurface|MultiCurve|MultiPoint|MultiGeometry|Surface)\b[^>]*>[\s\S]*?<\/gml:\1>/);
    if (!featureId) throw new Error('HIS WFS kirjel puudub ID');
    const properties: Record<string, string> = {};
    for (const field of body.matchAll(/<his:([\w]+)>([^<]*)<\/his:\1>/g)) {
      properties[field[1]!] = xmlText(field[2]!);
    }
    records.push({
      feature_id: featureId,
      properties,
      gml: geometry ? geometry[0].replace(/^<gml:([\w]+)/, '<gml:$1 xmlns:gml="http://www.opengis.net/gml"') : null,
    });
  }
  if (records.length !== featureCount(xml)) {
    throw new Error(`HIS WFS vastus on poolik: ${records.length}/${featureCount(xml)} kirjet`);
  }
  return records;
}

function subdivide([minN, minE, maxN, maxE]: Bounds): Bounds[] {
  const midN = (minN + maxN) / 2;
  const midE = (minE + maxE) / 2;
  return [
    [minN, minE, midN, midE],
    [minN, midE, midN, maxE],
    [midN, minE, maxN, midE],
    [midN, midE, maxN, maxE],
  ];
}

async function hitCount(layer: Layer, bounds?: Bounds): Promise<number> {
  const xml = await wfs(layer, {
    resultType: 'hits',
    ...(bounds ? { bbox: bounds.join(',') } : {}),
  });
  return featureCount(xml);
}

async function insertBatch(client: pg.PoolClient, snapshotId: string, layer: Layer, records: RecordData[]) {
  if (!records.length) return;
  await client.query(`
    INSERT INTO his_features(snapshot_id, layer, feature_id, properties, geom)
    SELECT $1::uuid, $2::text, item.feature_id, item.properties,
           ST_Transform(ST_GeomFromGML(item.gml), 4326)
    FROM jsonb_to_recordset($3::jsonb)
      AS item(feature_id text, properties jsonb, gml text)
    ON CONFLICT DO NOTHING
  `, [snapshotId, layer, JSON.stringify(records)]);
}

async function importRegion(
  client: pg.PoolClient,
  snapshotId: string,
  layer: Layer,
  expected: number,
  bounds?: Bounds,
  depth = 0,
): Promise<void> {
  const regionKey = bounds?.join(',') ?? 'all';
  const done = await client.query(`
    SELECT 1 FROM his_import_regions WHERE snapshot_id=$1 AND layer=$2 AND region_key=$3
  `, [snapshotId, layer, regionKey]);
  if (done.rowCount) return;
  if (!expected) {
    await client.query(`
      INSERT INTO his_import_regions(snapshot_id, layer, region_key) VALUES($1,$2,$3)
      ON CONFLICT DO NOTHING
    `, [snapshotId, layer, regionKey]);
    return;
  }
  if (expected >= MAX_PAGE) {
    if (!bounds || depth >= 16) throw new Error(`HIS ${layer}: piirkonda ei saa piisavalt jagada`);
    for (const child of subdivide(bounds)) {
      await importRegion(client, snapshotId, layer, await hitCount(layer, child), child, depth + 1);
    }
    await client.query(`
      INSERT INTO his_import_regions(snapshot_id, layer, region_key) VALUES($1,$2,$3)
      ON CONFLICT DO NOTHING
    `, [snapshotId, layer, regionKey]);
    return;
  }
  const xml = await wfs(layer, {
    count: String(MAX_PAGE),
    ...(bounds ? { bbox: bounds.join(',') } : {}),
  });
  const records = parseFeatures(xml);
  if (records.length >= MAX_PAGE) {
    throw new Error(`HIS ${layer}: WFS-i 10 000 kirje piir tabati; piirkond tuleb jagada`);
  }
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    await insertBatch(client, snapshotId, layer, records.slice(i, i + BATCH_SIZE));
  }
  await client.query(`
    INSERT INTO his_import_regions(snapshot_id, layer, region_key) VALUES($1,$2,$3)
    ON CONFLICT DO NOTHING
  `, [snapshotId, layer, regionKey]);
}

export async function refreshHisSnapshot(
  url = process.env.DATABASE_MAINTENANCE_URL,
  force = false,
): Promise<{ skipped: boolean; counts?: Record<string, number>; bytes?: number }> {
  if (!url) throw new Error('DATABASE_MAINTENANCE_URL puudub');
  const pool = new pg.Pool({ connectionString: url, options: '-c timezone=UTC', max: 1 });
  const client = await pool.connect();
  let snapshotId: string | undefined;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(73521004) AS locked');
    if (!lock.rows[0]?.locked) throw new Error('HIS-i uuendus juba käib');
    const active = await client.query(`
      SELECT s.completed_at FROM his_active_snapshot a
      JOIN his_snapshots s ON s.id = a.snapshot_id WHERE a.singleton = true
    `);
    const unfinished = await client.query(`
      SELECT id FROM his_snapshots WHERE completed_at IS NULL ORDER BY started_at DESC LIMIT 1
    `);
    if (!force && !unfinished.rows[0] && active.rows[0]?.completed_at
      && Date.now() - new Date(active.rows[0].completed_at).getTime() < REFRESH_DAYS * 86_400_000) {
      return { skipped: true };
    }
    snapshotId = unfinished.rows[0]?.id ?? randomUUID();
    if (!unfinished.rows[0]) await client.query('INSERT INTO his_snapshots(id) VALUES($1)', [snapshotId]);
    else console.log(`HIS: jätkan pooleliolevat importi ${snapshotId}`);
    const expected: Record<string, number> = {};
    const actual: Record<string, number> = {};
    for (const layer of LAYERS) {
      expected[layer] = await hitCount(layer);
      console.log(`HIS ${layer}: ${expected[layer]} kirjet`);
      await importRegion(client, snapshotId!, layer, expected[layer]!,
        layer === 'kivi' ? ESTONIA_3301 : undefined);
      const result = await client.query(
        'SELECT count(*)::integer AS count FROM his_features WHERE snapshot_id=$1 AND layer=$2',
        [snapshotId, layer],
      );
      actual[layer] = result.rows[0].count;
      const tolerance = Math.max(10, Math.ceil(expected[layer]! * 0.001));
      if (Math.abs(actual[layer]! - expected[layer]!) > tolerance) {
        throw new Error(`HIS ${layer}: ${actual[layer]}/${expected[layer]} unikaalset kirjet`);
      }
      console.log(`HIS ${layer}: koopia kontrollitud`);
    }
    await client.query('ANALYZE his_features');
    await client.query('BEGIN');
    await client.query(`
      UPDATE his_snapshots SET completed_at=now(), expected_counts=$2, actual_counts=$3 WHERE id=$1
    `, [snapshotId, expected, actual]);
    await client.query(`
      INSERT INTO his_active_snapshot(singleton, snapshot_id) VALUES(true, $1)
      ON CONFLICT(singleton) DO UPDATE SET snapshot_id=excluded.snapshot_id
    `, [snapshotId]);
    await client.query(`
      DELETE FROM his_snapshots WHERE id NOT IN (
        SELECT id FROM his_snapshots WHERE completed_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT 2
      )
    `);
    await client.query('COMMIT');
    const size = await client.query(`
      SELECT pg_total_relation_size('his_features')::bigint AS bytes
    `);
    return { skipped: false, counts: actual, bytes: Number(size.rows[0].bytes) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(73521004)').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('refreshHisSnapshot.ts')) {
  refreshHisSnapshot(undefined, process.argv.includes('--force'))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
