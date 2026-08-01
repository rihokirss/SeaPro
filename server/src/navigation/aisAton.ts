import WebSocket from 'ws';
import type { NavigationAid } from '@seapro/shared';
import { config } from '../config.js';
import { categoryFromAtonType } from './categories.js';

const URL =
  'wss://gis.transpordiamet.ee/gisevent/ws/services/' +
  'AIS-aton-stream-out/StreamServer/subscribe';
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 48 * 3600 * 1000;

interface StreamMessage {
  geometry?: { x?: number; y?: number };
  attributes?: {
    timestamp?: number | string;
    name?: string;
    mmsi?: number | string;
    aton_type?: number;
    off_pos?: number | boolean;
    aton_status?: number;
    virtual_aton?: number | boolean;
    lon?: number;
    lat?: number;
  };
}

interface StoredAid {
  aid: NavigationAid;
  receivedAt: number;
}

/** Reaalajas AIS type 21 navigatsioonimärkide register ja ühendus. */
export class AisAtonStream {
  #items = new Map<number, StoredAid>();
  #ws: WebSocket | null = null;
  #backoff = 2000;
  #stopped = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #log: ((message: string) => void) | undefined;

  start(log?: (message: string) => void): void {
    this.#log = log;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#ws?.close();
    this.#ws = null;
  }

  query([south, west, north, east]: [number, number, number, number]): NavigationAid[] {
    const cutoff = Date.now() - MAX_AGE_MS;
    const out: NavigationAid[] = [];
    for (const { aid, receivedAt } of this.#items.values()) {
      if (receivedAt < cutoff) continue;
      if (aid.lat < south || aid.lat > north || aid.lon < west || aid.lon > east) continue;
      out.push(aid);
    }
    return out;
  }

  prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [mmsi, item] of this.#items) {
      if (item.receivedAt < cutoff) this.#items.delete(mmsi);
    }
  }

  get size(): number {
    return this.#items.size;
  }

  #connect(): void {
    if (this.#stopped) return;
    const ws = new WebSocket(URL);
    this.#ws = ws;

    ws.on('open', () => {
      const [south, west, north, east] = config.aisBbox;
      ws.send(JSON.stringify({
        filter: {
          geometry: {
            xmin: west,
            ymin: south,
            xmax: east,
            ymax: north,
            spatialReference: { wkid: 4326 },
          },
          outFields:
            'timestamp,name,mmsi,aton_type,off_pos,aton_status,virtual_aton,lon,lat',
        },
      }));
      this.#backoff = 2000;
      this.#log?.('AIS navigatsioonimärgid: ühendatud');
    });

    ws.on('message', (raw) => {
      try {
        this.#handle(JSON.parse(raw.toString()) as StreamMessage);
      } catch {
        // Filtri kinnitus või vigane üksiksõnum ei katkesta voogu.
      }
    });
    ws.on('close', () => this.#scheduleReconnect());
    ws.on('error', (error) => this.#log?.(`AIS navigatsioonimärgid: ${error.message}`));
  }

  #handle(message: StreamMessage): void {
    const attributes = message.attributes;
    const mmsi = Number(attributes?.mmsi);
    const lat = finiteNumber(message.geometry?.y) ?? finiteNumber(attributes?.lat);
    const lon = finiteNumber(message.geometry?.x) ?? finiteNumber(attributes?.lon);
    if (!attributes || !Number.isInteger(mmsi) || mmsi <= 0 || lat === undefined || lon === undefined) {
      return;
    }

    const [south, west, north, east] = config.aisBbox;
    if (lat < south || lat > north || lon < west || lon > east) return;

    const virtual = boolValue(attributes.virtual_aton) ?? false;
    const atonType = finiteNumber(attributes.aton_type);
    const timestamp = dateValue(attributes.timestamp);
    const existing = this.#items.get(mmsi);
    if (existing && timestamp && existing.aid.updatedAt) {
      if (new Date(timestamp).getTime() <= new Date(existing.aid.updatedAt).getTime()) return;
    }

    this.#items.set(mmsi, {
      aid: {
        id: `aton:ais:${mmsi}`,
        lat,
        lon,
        name: attributes.name?.trim() || `AIS AToN ${mmsi}`,
        kind: virtual ? 'virtual' : 'ais',
        atonType,
        category: categoryFromAtonType(atonType) ?? (virtual ? 'virtual' : 'unknown'),
        status: finiteNumber(attributes.aton_status),
        offPosition: boolValue(attributes.off_pos),
        virtual,
        mmsi,
        updatedAt: timestamp,
        sources: ['ais'],
      },
      receivedAt: Date.now(),
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(MAX_BACKOFF_MS, this.#backoff * 2);
    this.#log?.(`AIS navigatsioonimärgid: uus ühendus ${Math.round(wait / 1000)} s pärast`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, wait);
    this.#reconnectTimer.unref();
  }
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const number = Number(value);
  return Number.isFinite(number) ? number !== 0 : undefined;
}

function dateValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export const aisAtons = new AisAtonStream();
