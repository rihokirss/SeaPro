import type { BBox } from '@seapro/shared';
import { config } from '../config.js';
import {
  buildPreparedRoutingGraph,
  loadPreparedRoutingGraph,
  writePreparedRoutingGraph,
} from '../routing/preparedGraph.js';
import { buildHarbourAccessSupport } from '../routing/harbourAccess.js';
import type {
  RoutingCorridor,
  RoutingHarbour,
  RoutingHazard,
  RoutingSourceMeta,
} from '../routing/sourceTypes.js';
import { bboxTiles, settleMapLimit } from '../routing/sources/common.js';
import { loadEstonianRoutingData } from '../routing/sources/estonia.js';
import { loadFinnishStaticRoutingData } from '../routing/sources/finland.js';
import { loadOsmRoutingData } from '../routing/sources/osm.js';

const args = parseArgs(process.argv.slice(2));
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
const failures: string[] = [];

process.stdout.write(
  `${args.supportOnly ? 'Täiendan routingugraafi sadamatuge' : 'Valmistan routingugraafi'} `
  + `${bbox.join(',')} (${tiles.length} paani)\n`,
);

const settled = await settleMapLimit(tiles, 2, async (tile) => {
  const [estonia, finland, osm] = await Promise.all([
    loadEstonianRoutingData(tile),
    loadFinnishStaticRoutingData(tile, new Date().toISOString()),
    loadOsmRoutingData(tile),
  ]);
  for (const corridor of [...estonia.corridors, ...finland.corridors, ...osm.corridors]) {
    corridors.set(corridor.id, corridor);
  }
  for (const harbour of [...estonia.harbours, ...osm.harbours]) {
    harbours.set(harbour.id, harbour);
  }
  for (const hazard of [...estonia.hazards, ...finland.hazards, ...osm.hazards]) {
    hazards.set(hazard.id, hazard);
  }
  for (const source of [estonia.source, finland.source, osm.source]) {
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
const graph = existingGraph
  ? { ...existingGraph, harbourAccessSupport }
  : buildPreparedRoutingGraph([...corridors.values()], bbox, new Date().toISOString(), {
    harbourAccessSupport,
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
if (failures.length) process.stdout.write(`Hoiatus: ${failures.length} poolikut allikapaani\n`);

interface ScriptArgs {
  bbox?: BBox;
  output?: string;
  allowPartial: boolean;
  supportOnly: boolean;
}

function parseArgs(values: string[]): ScriptArgs {
  const result: ScriptArgs = { allowPartial: false, supportOnly: false };
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
    const [rawName, inline] = value.split('=', 2);
    const next = inline ?? values[++index];
    if (!next) throw new Error(`Argumendil ${rawName} puudub väärtus`);
    if (rawName === '--bbox') result.bbox = parseBbox(next);
    else if (rawName === '--output') result.output = next;
    else throw new Error(`Tundmatu argument: ${rawName}`);
  }
  return result;
}

function mergeById<T extends { id: string }>(prepared: readonly T[], loaded: readonly T[]): T[] {
  return [...new Map([...prepared, ...loaded].map((item) => [item.id, item])).values()];
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
