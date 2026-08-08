/**
 * Marsruudiplaneerimise benchmark: püsiv snapshot + korratavad mõõtmised.
 *
 *   npx tsx scripts/bench-routing.ts capture <stsenaarium>
 *   npx tsx scripts/bench-routing.ts run --fixture <stsenaarium> [--repeat 3] [--json fail]
 *   npx tsx scripts/bench-routing.ts run --synthetic worst [--repeat 3] [--json fail]
 *   npx tsx scripts/bench-routing.ts compare <a.json> <b.json> [--allow-equal-cost]
 *
 * `capture` laeb elusandmed võrgust ja külmutab need `data/bench/` alla, et
 * `run` oleks võrguta ja deterministlik. `compare` on optimeerimissammude
 * regressioonivärav: geomeetria räsi peab olema identne (või lipuga sama
 * kuluga, mis dokumenteeritakse).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BBox, RoutePlanRequest, RoutePlanResponse } from '@seapro/shared';
import { distanceMetres } from '@seapro/shared';
import {
  loadRoutingSnapshot,
  planRoute,
  routePlanningBbox,
  type RoutingSnapshot,
} from '../src/routing/planner.js';
import { RoutingDepthState, type RoutingDepthRaster } from '../src/routing/depthRaster.js';
import type { RoutingWaterMask } from '../src/routing/waterMask.js';
import type { RoutingHazard, RoutingVectorData } from '../src/routing/sourceTypes.js';

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bench');

const SCENARIOS: Record<string, RoutePlanRequest> = {
  'long-jussaro-tilgu': {
    start: { lat: 59.8302, lon: 23.5714 },
    end: { lat: 59.4553, lon: 24.4884 },
    departureTime: '2026-08-09T09:00:00+03:00',
    speedKnots: 8,
    draughtM: 1.2,
    underKeelClearanceM: 0.5,
    beamM: 3.5,
    airDraughtM: 4,
  },
  'short-tallinn-bay': {
    start: { lat: 59.49, lon: 24.66 },
    end: { lat: 59.57, lon: 24.62 },
    departureTime: '2026-08-09T09:00:00+03:00',
    speedKnots: 8,
    draughtM: 1.2,
    underKeelClearanceM: 0.5,
    beamM: 3.5,
    airDraughtM: 4,
  },
};

interface Fixture {
  name: string;
  request: RoutePlanRequest;
  bbox: BBox;
  snapshot: SerializedSnapshot;
}

interface SerializedSnapshot {
  depth: Omit<RoutingDepthRaster, 'depths' | 'states'> & { depths: string; states: string };
  water: { zoom: number; tiles: Array<[string, { polygons: [number, number][][][] } | null]>; source: RoutingWaterMask['source'] };
  vectors: RoutingVectorData;
}

interface PhaseSample {
  name: string;
  ms: number;
  [key: string]: string | number;
}

interface RunResult {
  status: RoutePlanResponse['status'];
  distanceNm?: number;
  geometryHash?: string;
  totalCost?: number;
  totalMs: number;
  phases: PhaseSample[];
}

interface RunReport {
  scenario: string;
  runs: RunResult[];
  medianTotalMs: number;
}

function serializeSnapshot(snapshot: RoutingSnapshot): SerializedSnapshot {
  const { depths, states, ...depthRest } = snapshot.depth;
  return {
    depth: {
      ...depthRest,
      depths: Buffer.from(depths.buffer, depths.byteOffset, depths.byteLength).toString('base64'),
      states: Buffer.from(states.buffer, states.byteOffset, states.byteLength).toString('base64'),
    },
    water: {
      zoom: snapshot.water.zoom,
      tiles: [...snapshot.water.tiles.entries()] as SerializedSnapshot['water']['tiles'],
      source: snapshot.water.source,
    },
    vectors: snapshot.vectors,
  };
}

function deserializeSnapshot(serialized: SerializedSnapshot): RoutingSnapshot {
  const depthsBuffer = Buffer.from(serialized.depth.depths, 'base64');
  const statesBuffer = Buffer.from(serialized.depth.states, 'base64');
  return {
    depth: {
      ...serialized.depth,
      depths: new Float32Array(depthsBuffer.buffer, depthsBuffer.byteOffset, depthsBuffer.byteLength / 4),
      states: new Uint8Array(statesBuffer.buffer, statesBuffer.byteOffset, statesBuffer.byteLength),
    },
    water: {
      zoom: serialized.water.zoom,
      tiles: new Map(serialized.water.tiles),
      source: serialized.water.source,
    },
    vectors: serialized.vectors,
  };
}

async function capture(name: string): Promise<void> {
  const request = SCENARIOS[name];
  if (!request) throw new Error(`Tundmatu stsenaarium: ${name}. Valikud: ${Object.keys(SCENARIOS).join(', ')}`);
  const bbox = routePlanningBbox(request, distanceMetres(request.start, request.end));
  console.log(`Laen snapshot'i ${name} jaoks, bbox ${bbox.map((v) => v.toFixed(3)).join(',')} ...`);
  const snapshot = await loadRoutingSnapshot(bbox, request.departureTime);
  const fixture: Fixture = { name, request, bbox, snapshot: serializeSnapshot(snapshot) };
  mkdirSync(BENCH_DIR, { recursive: true });
  const path = join(BENCH_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(fixture));
  console.log(`Salvestatud: ${path}`);
}

function syntheticWorst(): { name: string; request: RoutePlanRequest; bbox: BBox; snapshot: RoutingSnapshot } {
  // Soome lahe keskosa teenindusmaski sees; ühtlane 8 m vesi ja kolm
  // kammikujulist takistusmüüri, mis sunnivad serpentiini. Halvim juht
  // täisvõre otsingule ilma võrguandmeteta.
  const bbox: BBox = [59.35, 23.4, 59.85, 25.4];
  const width = 1024;
  const height = 512;
  const states = new Uint8Array(width * height);
  states.fill(RoutingDepthState.Water);
  const depths = new Float32Array(width * height);
  depths.fill(8);
  const source = { id: 'test', fetchedAt: '2026-08-08T12:00:00.000Z', ageSeconds: 0, stale: false, coverage: 'complete' as const };

  const walls: RoutingHazard[] = [0.25, 0.5, 0.75].map((fraction, index) => {
    const lon = bbox[1] + fraction * (bbox[3] - bbox[1]);
    const gapAtTop = index % 2 === 0;
    const south = gapAtTop ? 59.35 : 59.45;
    const north = gapAtTop ? 59.75 : 59.85;
    return {
      id: `synthetic:wall:${index}`,
      kind: 'obstruction',
      geometry: { type: 'LineString', coordinates: [[lon, south], [lon, north]] },
      name: `Sein ${index}`,
      confidence: 'high',
      source: 'transpordiamet-his',
      fetchedAt: source.fetchedAt,
      stale: false,
    } satisfies RoutingHazard;
  });

  const snapshot: RoutingSnapshot = {
    depth: {
      bbox: [bbox[1], bbox[0], bbox[3], bbox[2]],
      width,
      height,
      states,
      depths,
      source: { ...source, id: 'emodnet-depth' },
    },
    water: {
      zoom: 0,
      tiles: new Map([['0:0', { polygons: [[[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]]] }]]),
      source: { ...source, id: 'openfreemap-water' },
    },
    vectors: {
      bbox,
      hazards: walls,
      corridors: [],
      restrictions: [],
      warnings: [],
      surveyAreas: [],
      sources: [{
        id: 'transpordiamet-his',
        source: 'transpordiamet-his',
        status: 'ok',
        stale: false,
        fetchedAt: source.fetchedAt,
        ageSeconds: 0,
        coverage: 'complete',
        tilesRequested: 1,
        tilesLoaded: 1,
        attribution: 'test',
        attributionUrl: 'https://example.test',
      }],
    },
  };
  const request: RoutePlanRequest = {
    start: { lat: 59.6, lon: 23.5 },
    end: { lat: 59.6, lon: 25.3 },
    departureTime: '2026-08-09T09:00:00+03:00',
    speedKnots: 8,
    draughtM: 1.2,
    underKeelClearanceM: 0.5,
    beamM: 3.5,
    airDraughtM: 4,
  };
  return { name: 'synthetic-worst', request, bbox, snapshot };
}

async function runScenario(
  name: string,
  request: RoutePlanRequest,
  bbox: BBox,
  snapshot: RoutingSnapshot,
  repeat: number,
): Promise<RunReport> {
  const runs: RunResult[] = [];
  for (let iteration = 0; iteration < repeat; iteration++) {
    const phases: PhaseSample[] = [];
    const startedAt = performance.now();
    const result = await planRoute(request, {
      snapshot,
      bbox,
      timeoutMs: 300_000,
      instrumentation: { phase: (phase, ms, meta) => phases.push({ name: phase, ms, ...meta }) },
    });
    const totalMs = performance.now() - startedAt;
    const run: RunResult = { status: result.status, totalMs, phases };
    if (result.status !== 'no_route') {
      run.distanceNm = result.distanceNm;
      run.geometryHash = createHash('sha256')
        .update(JSON.stringify(result.geometry.coordinates))
        .digest('hex');
      run.totalCost = phases.filter((phase) => phase.name === 'search')
        .reduce((sum, phase) => sum + (typeof phase.totalCost === 'number' ? phase.totalCost : 0), 0);
    }
    runs.push(run);
    console.log(`  #${iteration + 1}: ${result.status} ${run.distanceNm?.toFixed(1) ?? '-'} NM, ${totalMs.toFixed(0)} ms`);
  }
  const sorted = [...runs].sort((a, b) => a.totalMs - b.totalMs);
  const medianTotalMs = sorted[Math.floor(sorted.length / 2)]!.totalMs;
  return { scenario: name, runs, medianTotalMs };
}

function printPhaseTable(report: RunReport): void {
  const median = report.runs[Math.floor(report.runs.length / 2)] ?? report.runs[0]!;
  const byPhase = new Map<string, { ms: number; count: number; meta: PhaseSample }>();
  for (const phase of median.phases) {
    const entry = byPhase.get(phase.name) ?? { ms: 0, count: 0, meta: phase };
    entry.ms += phase.ms;
    entry.count += 1;
    byPhase.set(phase.name, entry);
  }
  console.log(`\n${report.scenario}: mediaan ${report.medianTotalMs.toFixed(0)} ms`);
  for (const [name, entry] of [...byPhase.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
    const extras = Object.entries(entry.meta)
      .filter(([key]) => key !== 'name' && key !== 'ms')
      .map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}`)
      .join(' ');
    console.log(`  ${name.padEnd(32)} ${entry.ms.toFixed(0).padStart(8)} ms  x${entry.count}  ${extras}`);
  }
}

async function run(args: string[]): Promise<void> {
  const fixtureIndex = args.indexOf('--fixture');
  const syntheticIndex = args.indexOf('--synthetic');
  const repeatIndex = args.indexOf('--repeat');
  const jsonIndex = args.indexOf('--json');
  const repeat = repeatIndex >= 0 ? Number(args[repeatIndex + 1]) : 3;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat peab olema positiivne täisarv');

  let report: RunReport;
  if (fixtureIndex >= 0) {
    const name = args[fixtureIndex + 1];
    if (!name) throw new Error('--fixture vajab nime');
    const fixture = JSON.parse(readFileSync(join(BENCH_DIR, `${name}.json`), 'utf8')) as Fixture;
    console.log(`Käivitan ${name} (${repeat}x, offline snapshot):`);
    report = await runScenario(name, fixture.request, fixture.bbox, deserializeSnapshot(fixture.snapshot), repeat);
  } else if (syntheticIndex >= 0) {
    const synthetic = syntheticWorst();
    console.log(`Käivitan ${synthetic.name} (${repeat}x):`);
    report = await runScenario(synthetic.name, synthetic.request, synthetic.bbox, synthetic.snapshot, repeat);
  } else {
    throw new Error('run vajab --fixture <nimi> või --synthetic worst');
  }

  printPhaseTable(report);
  if (jsonIndex >= 0) {
    const path = args[jsonIndex + 1];
    if (!path) throw new Error('--json vajab failiteed');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`Raport: ${path}`);
  }
}

function compare(args: string[]): void {
  const allowEqualCost = args.includes('--allow-equal-cost');
  const [aPath, bPath] = args.filter((arg) => !arg.startsWith('--'));
  if (!aPath || !bPath) throw new Error('compare vajab kahte raportifaili');
  const a = JSON.parse(readFileSync(aPath, 'utf8')) as RunReport;
  const b = JSON.parse(readFileSync(bPath, 'utf8')) as RunReport;
  const aRun = a.runs[0]!;
  const bRun = b.runs[0]!;
  console.log(`${a.scenario}: ${a.medianTotalMs.toFixed(0)} ms -> ${b.medianTotalMs.toFixed(0)} ms`);
  if (aRun.status !== bRun.status) {
    console.error(`STAATUS MUUTUS: ${aRun.status} -> ${bRun.status}`);
    process.exitCode = 1;
    return;
  }
  if (aRun.geometryHash === bRun.geometryHash) {
    console.log('Geomeetria: identne');
    return;
  }
  if (allowEqualCost
    && aRun.totalCost !== undefined && bRun.totalCost !== undefined
    && Math.abs(aRun.totalCost - bRun.totalCost) <= 1e-9 * Math.max(1, Math.abs(aRun.totalCost))) {
    console.log(`Geomeetria erineb, kuid kulu on võrdne (${aRun.totalCost}); lubatud --allow-equal-cost lipuga.`);
    return;
  }
  console.error(`GEOMEETRIA ERINEB: kulu ${aRun.totalCost} -> ${bRun.totalCost}`);
  process.exitCode = 1;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'capture') {
  const name = rest[0];
  if (!name) throw new Error('capture vajab stsenaariumi nime');
  await capture(name);
} else if (command === 'run') {
  await run(rest);
} else if (command === 'compare') {
  compare(rest);
} else {
  console.log('Kasutus: capture <stsenaarium> | run --fixture <nimi> | run --synthetic worst | compare <a> <b>');
  process.exitCode = command ? 1 : 0;
}
