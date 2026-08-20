import type { BBox } from '@seapro/shared';
import { config } from '../config.js';
import { bboxTiles } from './sources/common.js';
import {
  isEstonianRoutingTileFresh,
  warmEstonianRoutingTile,
} from './sources/estonia.js';
import {
  isFinnishStaticRoutingTileFresh,
  warmFinnishStaticRoutingTile,
} from './sources/finland.js';
import { isOsmRoutingTileFresh, warmOsmRoutingTile } from './sources/osm.js';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface RoutingWarmupStatus {
  state: 'disabled' | 'idle' | 'running' | 'paused';
  completedTiles: number;
  totalTiles: number;
  queuedTiles: number;
  lastCompletedAt?: string;
  lastError?: string;
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface RoutingWarmupDependencies {
  coreTiles(): BBox[];
  tilesAround(bbox: BBox): BBox[];
  isOsmFresh(tile: BBox): boolean;
  isEstonianFresh(tile: BBox): boolean;
  isFinnishFresh(tile: BBox): boolean;
  warmOsm(tile: BBox, signal?: AbortSignal): Promise<unknown>;
  warmEstonian(tile: BBox): Promise<unknown>;
  warmFinnish(tile: BBox): Promise<unknown>;
  sweepIntervalMs: number;
}

// Sama kaks ala mis routinguteenuse maski Eesti/Soome-lahe ja Edela-Soome
// osad. Botnia laht lisandub kasutuspõhiselt pärast päris marsruuti.
const CORE_REGIONS: readonly BBox[] = [
  [57.45, 21.35, 59.90, 28.35],
  [59.45, 18.75, 61.55, 28.45],
];

const PRIORITY_REGIONS: readonly BBox[] = [
  [59, 22, 61, 29], // Soome laht, sh Tallinn–Helsingi
  [59, 18, 62, 24], // Edela-Soome saarestik
  [57, 21, 60, 29], // ülejäänud Eesti rannikumeri
];

/** Tuumikala kanoonilised 1° paanid koos ühe paani puhvriga. */
export function routingPrewarmTiles(limit: BBox = config.routingBbox): BBox[] {
  const base = dedupeTiles(CORE_REGIONS.flatMap((bbox) => bboxTiles(bbox, 1)));
  return haloTiles(base, limit).sort(compareTilePriority);
}

/** Päris marsruudi ala ja ühe paani naabrid, lõigatuna teenuse kõva piiriga. */
export function routingTilesAround(bbox: BBox, limit: BBox = config.routingBbox): BBox[] {
  return haloTiles(bboxTiles(bbox, 1), limit);
}

export class RoutingWarmup {
  readonly #queue = new Map<string, BBox>();
  readonly #completedCore = new Set<string>();
  #coreTiles: BBox[] = [];
  #coreKeys = new Set<string>();
  #running = false;
  #started = false;
  #stopped = false;
  #activeRoutes = 0;
  #timer: NodeJS.Timeout | null = null;
  #controller: AbortController | null = null;
  #logger: Logger | null = null;
  #lastCompletedAt: string | undefined;
  #lastError: string | undefined;
  readonly #dependencies: RoutingWarmupDependencies;

  constructor(dependencies: Partial<RoutingWarmupDependencies> = {}) {
    this.#dependencies = {
      coreTiles: () => routingPrewarmTiles(),
      tilesAround: (bbox) => routingTilesAround(bbox),
      isOsmFresh: isOsmRoutingTileFresh,
      isEstonianFresh: isEstonianRoutingTileFresh,
      isFinnishFresh: isFinnishStaticRoutingTileFresh,
      warmOsm: warmOsmRoutingTile,
      warmEstonian: warmEstonianRoutingTile,
      warmFinnish: warmFinnishStaticRoutingTile,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      ...dependencies,
    };
  }

  start(log: Logger): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#logger = log;
    this.#coreTiles = this.#dependencies.coreTiles();
    this.#coreKeys = new Set(this.#coreTiles.map(tileKey));
    this.#enqueue(this.#coreTiles);
    this.#timer = setInterval(
      () => this.#enqueue(this.#coreTiles),
      this.#dependencies.sweepIntervalMs,
    );
    this.#timer.unref();
    log.info(`Routingu taustsoojendus: ${this.#coreTiles.length} tuumikupaani`);
    this.#ensureDrain();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
    this.#controller = null;
    this.#queue.clear();
  }

  foregroundStarted(): void {
    if (!this.#started || this.#stopped) return;
    this.#activeRoutes++;
  }

  foregroundFinished(bbox?: BBox): void {
    if (!this.#started || this.#stopped) return;
    this.#activeRoutes = Math.max(0, this.#activeRoutes - 1);
    if (bbox) this.#enqueue(this.#dependencies.tilesAround(bbox));
    this.#ensureDrain();
  }

  status(): RoutingWarmupStatus {
    const state: RoutingWarmupStatus['state'] = !this.#started
      ? 'disabled'
      : this.#activeRoutes > 0 && this.#queue.size > 0
        ? 'paused'
        : this.#running ? 'running' : 'idle';
    return {
      state,
      completedTiles: this.#completedCore.size,
      totalTiles: this.#coreTiles.length,
      queuedTiles: this.#queue.size,
      ...(this.#lastCompletedAt ? { lastCompletedAt: this.#lastCompletedAt } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  #enqueue(tiles: readonly BBox[]): void {
    if (this.#stopped) return;
    for (const tile of tiles) {
      const key = tileKey(tile);
      if (!this.#queue.has(key)) this.#queue.set(key, tile);
    }
    this.#ensureDrain();
  }

  #ensureDrain(): void {
    if (!this.#started || this.#stopped || this.#running || this.#activeRoutes > 0
      || this.#queue.size === 0) return;
    this.#running = true;
    void this.#drain().finally(() => {
      this.#running = false;
      if (!this.#stopped && this.#activeRoutes === 0 && this.#queue.size > 0) {
        this.#ensureDrain();
      }
    });
  }

  async #drain(): Promise<void> {
    const startedAt = performance.now();
    let loaded = 0;
    let skipped = 0;
    let failed = 0;

    while (!this.#stopped && this.#activeRoutes === 0 && this.#queue.size > 0) {
      const entry = this.#queue.entries().next().value as [string, BBox] | undefined;
      if (!entry) break;
      const [key, tile] = entry;
      this.#queue.delete(key);

      const fresh = this.#tileIsFresh(tile);
      if (fresh) {
        skipped++;
        if (this.#coreKeys.has(key)) this.#completedCore.add(key);
        continue;
      }

      this.#controller = new AbortController();
      const jobs: Promise<unknown>[] = [];
      if (!this.#dependencies.isOsmFresh(tile)) {
        jobs.push(this.#dependencies.warmOsm(tile, this.#controller.signal));
      }
      if (!this.#dependencies.isEstonianFresh(tile)) {
        jobs.push(this.#dependencies.warmEstonian(tile));
      }
      if (!this.#dependencies.isFinnishFresh(tile)) {
        jobs.push(this.#dependencies.warmFinnish(tile));
      }
      const results = await Promise.allSettled(jobs);
      this.#controller = null;
      const errors = results.flatMap((result) => result.status === 'rejected'
        ? [errorMessage(result.reason)]
        : []);
      if (errors.length || !this.#tileIsFresh(tile)) {
        failed++;
        this.#lastError = errors[0] ?? 'Paan jäi pärast värskendamist aegunuks';
        this.#completedCore.delete(key);
        this.#logger?.warn(
          `Routingu taustsoojendus ${key} ebaõnnestus: ${this.#lastError}`,
        );
      } else {
        loaded++;
        if (this.#coreKeys.has(key)) this.#completedCore.add(key);
      }
    }

    if (this.#queue.size === 0) this.#lastCompletedAt = new Date().toISOString();
    this.#logger?.info(
      `Routingu taustsoojendus: laaditud ${loaded}, cache'is ${skipped}, `
      + `tõrkeid ${failed}, ${Math.round(performance.now() - startedAt)} ms`,
    );
  }

  #tileIsFresh(tile: BBox): boolean {
    return this.#dependencies.isOsmFresh(tile)
      && this.#dependencies.isEstonianFresh(tile)
      && this.#dependencies.isFinnishFresh(tile);
  }
}

function haloTiles(tiles: readonly BBox[], limit: BBox): BBox[] {
  const result: BBox[] = [];
  for (const [south, west] of tiles) {
    for (let latOffset = -1; latOffset <= 1; latOffset++) {
      for (let lonOffset = -1; lonOffset <= 1; lonOffset++) {
        const lat = south + latOffset;
        const lon = west + lonOffset;
        const tile: BBox = [lat, lon, lat + 1, lon + 1];
        if (intersects(tile, limit)) result.push(tile);
      }
    }
  }
  return dedupeTiles(result);
}

function dedupeTiles(tiles: readonly BBox[]): BBox[] {
  return [...new Map(tiles.map((tile) => [tileKey(tile), tile])).values()];
}

function compareTilePriority(a: BBox, b: BBox): number {
  const tier = (tile: BBox): number => {
    const index = PRIORITY_REGIONS.findIndex((region) => intersects(tile, region));
    return index < 0 ? PRIORITY_REGIONS.length : index;
  };
  return tier(a) - tier(b) || a[0] - b[0] || a[1] - b[1];
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function tileKey(tile: BBox): string {
  return tile.join(',');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const routingWarmup = new RoutingWarmup();
