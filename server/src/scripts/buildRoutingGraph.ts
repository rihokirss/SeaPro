import type { BBox } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchTrafficSchemesSnapshot } from '../navigation/osmTraffic.js';
import {
  buildPreparedRoutingGraph,
  eligibleCorridor,
  loadPreparedRoutingGraph,
  writePreparedRoutingGraph,
  type PreparedRoutingSupport,
} from '../routing/preparedGraph.js';
import { buildHarbourAccessSupport } from '../routing/harbourAccess.js';
import { trafficSchemesToRoutingVectors } from '../routing/trafficSupport.js';
import type {
  RoutingCorridor,
  RoutingHarbour,
  RoutingHazard,
  RoutingRestriction,
  RoutingSourceId,
  RoutingSourceMeta,
} from '../routing/sourceTypes.js';
import { bboxTiles, settleMapLimit } from '../routing/sources/common.js';
import { loadEstonianRoutingData } from '../routing/sources/estonia.js';
import { loadFinnishStaticRoutingData } from '../routing/sources/finland.js';
import { loadOsmRoutingData } from '../routing/sources/osm.js';

const args = parseArgs(process.argv.slice(2));
// CLI-protsess ei käivita serveri bootstrap'i, seega taasta siin sama püsiv
// cache, mida runtime ja taustasoojendus juba täidavad.
cache.loadFromDisk((message) => process.stdout.write(`${message}\n`));
const bbox = args.bbox ?? config.routingGraphBbox;
const output = args.output ?? config.routingGraphFile;
const existingGraph = args.supportOnly ? await loadPreparedRoutingGraph(output) : null;
if (args.supportOnly && !existingGraph) {
  throw new Error(`Olemasolevat routingugraafi ei leitud: ${output}`);
}
const tiles = bboxTiles(bbox, 1);
const corridors = new Map<string, RoutingCorridor>();
const harbours = new Map<string, RoutingHarbour>();
const hazards = new Map<string, RoutingHazard>();
const restrictions = new Map<string, RoutingRestriction>();
const sourceParts = new Map<RoutingSourceId, RoutingSourceMeta[]>();
const failures: string[] = [];

const trafficSnapshot = args.trafficBbox
  ? await fetchTrafficSchemesSnapshot(args.trafficBbox)
  : null;

process.stdout.write(
  `${args.supportOnly ? 'Täiendan routingugraafi sadamatuge' : 'Valmistan routingugraafi'} `
  + `${bbox.join(',')} (${tiles.length} paani)\n`,
);

const settled = await settleMapLimit(tiles, 2, async (tile) => {
  const [estonia, finland, osm] = await Promise.all([
    loadEstonianRoutingData(tile),
    loadFinnishStaticRoutingData(tile, new Date().toISOString()),
    args.skipOsm ? Promise.resolve(null) : loadOsmRoutingData(tile),
  ]);
  for (const corridor of [...estonia.corridors, ...finland.corridors, ...(osm?.corridors ?? [])]) {
    corridors.set(corridor.id, corridor);
  }
  for (const harbour of [...estonia.harbours, ...(osm?.harbours ?? [])]) {
    harbours.set(harbour.id, harbour);
  }
  for (const hazard of [...estonia.hazards, ...finland.hazards, ...(osm?.hazards ?? [])]) {
    hazards.set(hazard.id, hazard);
  }
  for (const restriction of [...finland.restrictions, ...(osm?.restrictions ?? [])]) {
    restrictions.set(restriction.id, restriction);
  }
  for (const source of [estonia.source, finland.source, ...(osm ? [osm.source] : [])]) {
    const parts = sourceParts.get(source.id) ?? [];
    parts.push(source);
    sourceParts.set(source.id, parts);
    collectFailure(source, tile, failures);
  }
  process.stdout.write(
    `${tile.join(',')}: ${corridors.size} unikaalset keskjoont\n`,
  );
});
for (const [index, result] of settled.entries()) {
  if (result.status === 'rejected') {
    failures.push(`${tiles[index]!.join(',')}: ${String(result.reason)}`);
  }
}

if (trafficSnapshot) {
  const traffic = trafficSchemesToRoutingVectors(trafficSnapshot.trafficSchemes, {
    source: 'openstreetmap-overpass',
    fetchedAt: trafficSnapshot.fetchedAt,
    stale: trafficSnapshot.stale,
  });
  for (const corridor of traffic.corridors) corridors.set(corridor.id, corridor);
  for (const restriction of traffic.restrictions) restrictions.set(restriction.id, restriction);
  const entries = sourceParts.get('openstreetmap-overpass') ?? [];
  entries.push({
    id: 'openstreetmap-overpass',
    source: 'openstreetmap-overpass',
    status: trafficSnapshot.stale ? 'stale' : 'ok',
    stale: trafficSnapshot.stale,
    fetchedAt: trafficSnapshot.fetchedAt,
    ageSeconds: trafficSnapshot.ageSeconds,
    coverage: 'complete',
    tilesRequested: 1,
    tilesLoaded: 1,
    attribution: '© OpenStreetMap contributors / OpenSeaMap seamarks',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
  });
  sourceParts.set('openstreetmap-overpass', entries);
}

if (failures.length && !args.allowPartial) {
  throw new Error(
    `Graafi ei kirjutatud, sest lähteandmed jäid poolikuks:\n${failures.join('\n')}\n`
    + 'Kui osaline tulemus on teadlikult sobiv, kasuta --allow-partial.',
  );
}

const harbourAccessSupport = buildHarbourAccessSupport({
  harbours: mergeById(existingGraph?.harbourAccessSupport?.harbours ?? [], [...harbours.values()]),
  hazards: mergeById(existingGraph?.harbourAccessSupport?.hazards ?? [], [...hazards.values()]),
  corridors: mergeById(existingGraph?.harbourAccessSupport?.corridors ?? [], [...corridors.values()]),
});
const routingSupport: PreparedRoutingSupport = {
  bbox: [...bbox],
  hazards: mergeById(existingGraph?.routingSupport.hazards ?? [], [...hazards.values()]),
  corridors: mergeById(
    existingGraph?.routingSupport.corridors ?? [],
    [...corridors.values()].filter((corridor) => !eligibleCorridor(corridor)),
  ),
  restrictions: mergeById(
    existingGraph?.routingSupport.restrictions ?? [],
    [...restrictions.values()],
  ),
  sources: aggregateSources(sourceParts),
};
const graph = existingGraph
  ? { ...existingGraph, harbourAccessSupport, routingSupport }
  : buildPreparedRoutingGraph([...corridors.values()], bbox, new Date().toISOString(), {
    harbourAccessSupport,
    routingSupport,
  });
const target = await writePreparedRoutingGraph(graph, output);
process.stdout.write(
  `Valmis ${target}: ${graph.nodes.length} sõlme, ${graph.edges.length} serva, `
  + `${graph.stats.intersections} ristmikku, ${graph.stats.snappedEndpoints} ühendatud otspunkti\n`,
);
process.stdout.write(
  `Sadamatoeks ${harbourAccessSupport.harbours.length} sadamat, `
  + `${harbourAccessSupport.hazards.length} külgmärki ja `
  + `${harbourAccessSupport.corridors.length} lähedast ametlikku väila\n`,
);
process.stdout.write(
  `Ohutustoeks ${routingSupport.hazards.length} ohtu, `
  + `${routingSupport.corridors.length} graafivälist koridori ja `
  + `${routingSupport.restrictions.length} piirangut\n`,
);
if (failures.length) process.stdout.write(`Hoiatus: ${failures.length} poolikut allikapaani\n`);
cache.flush((message) => process.stdout.write(`${message}\n`));

interface ScriptArgs {
  bbox?: BBox;
  output?: string;
  allowPartial: boolean;
  supportOnly: boolean;
  skipOsm: boolean;
  trafficBbox?: BBox;
}

function parseArgs(values: string[]): ScriptArgs {
  const result: ScriptArgs = { allowPartial: false, supportOnly: false, skipOsm: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === '--allow-partial') {
      result.allowPartial = true;
      continue;
    }
    if (value === '--support-only') {
      result.supportOnly = true;
      continue;
    }
    if (value === '--skip-osm') {
      result.skipOsm = true;
      continue;
    }
    const [rawName, inline] = value.split('=', 2);
    const next = inline ?? values[++index];
    if (!next) throw new Error(`Argumendil ${rawName} puudub väärtus`);
    if (rawName === '--bbox') result.bbox = parseBbox(next);
    else if (rawName === '--traffic-bbox') result.trafficBbox = parseBbox(next);
    else if (rawName === '--output') result.output = next;
    else throw new Error(`Tundmatu argument: ${rawName}`);
  }
  return result;
}

function mergeById<T extends { id: string }>(prepared: readonly T[], loaded: readonly T[]): T[] {
  return [...new Map([...prepared, ...loaded].map((item) => [item.id, item])).values()];
}

function aggregateSources(parts: ReadonlyMap<RoutingSourceId, RoutingSourceMeta[]>): RoutingSourceMeta[] {
  return [...parts].map(([id, entries]) => {
    const first = entries[0]!;
    // A source being outside its own country/coverage must not make the combined
    // Estonia + Finland support layer look partial. Only evaluate tiles where the
    // source claims coverage; keep outside_coverage when there are no such tiles.
    const coveredEntries = entries.filter((entry) => entry.status !== 'outside_coverage');
    const evaluatedEntries = coveredEntries.length > 0 ? coveredEntries : entries;
    const errors = evaluatedEntries.flatMap((entry) => entry.errors ?? (entry.error ? [entry.error] : []));
    const complete = evaluatedEntries.every((entry) => entry.coverage === 'complete');
    const missing = evaluatedEntries.every((entry) => entry.coverage === 'missing');
    const status = evaluatedEntries.some((entry) => entry.status === 'unavailable')
      ? 'unavailable'
      : evaluatedEntries.some((entry) => entry.status === 'partial') ? 'partial'
        : evaluatedEntries.some((entry) => entry.status === 'stale') ? 'stale'
          : coveredEntries.length === 0 ? 'outside_coverage'
            : 'ok';
    return {
      ...first,
      id,
      source: id,
      status,
      stale: evaluatedEntries.some((entry) => entry.stale),
      fetchedAt: evaluatedEntries.map((entry) => entry.fetchedAt).sort()[0]!,
      ageSeconds: Math.max(...evaluatedEntries.map((entry) => entry.ageSeconds)),
      coverage: complete ? 'complete' : missing ? 'missing' : 'partial',
      tilesRequested: entries.reduce((sum, entry) => sum + entry.tilesRequested, 0),
      tilesLoaded: entries.reduce((sum, entry) => sum + entry.tilesLoaded, 0),
      ...(errors.length ? { error: errors[0], errors: [...new Set(errors)] } : {}),
    } satisfies RoutingSourceMeta;
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function parseBbox(value: string): BBox {
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`--bbox peab olema lõuna,lääs,põhi,ida; sai ${value}`);
  }
  const bbox = parts as BBox;
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error(`Vigane --bbox: ${value}`);
  return bbox;
}

function collectFailure(source: RoutingSourceMeta, tile: BBox, failures: string[]): void {
  if (source.tilesRequested === 0 || source.coverage === 'complete') return;
  failures.push(`${source.source} ${tile.join(',')}: ${source.error ?? source.coverage}`);
}
