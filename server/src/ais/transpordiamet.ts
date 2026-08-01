import WebSocket from 'ws';
import { config } from '../config.js';
import { vessels } from './registry.js';

const URL =
  'wss://gis.transpordiamet.ee/gisevent/ws/services/' +
  'AIS-vessels-stream-out/StreamServer/subscribe';

const MAX_BACKOFF_MS = 5 * 60 * 1000;

interface StreamMessage {
  geometry?: {
    x?: number;
    y?: number;
  };
  attributes?: {
    name?: string;
    timestamp?: number | string;
    mmsi?: number | string;
    imo?: number | string;
    flag?: string;
    type_and_cargo?: number;
    nav_status?: number;
    destination?: string;
    eta?: number | string | null;
    sog?: number | null;
    cog?: number | null;
    length?: number | null;
    width?: number | null;
    draught?: number | null;
    fix_type?: number | null;
  };
}

/**
 * Transpordiameti Nutimere avalik AIS-voog Eesti kaldajaamadest.
 *
 * ArcGIS StreamServer hakkab ühenduse avamisel kohe kogu voogu saatma. Seega
 * saadame talle esimesel võimalusel geomeetriafiltri, kuid kontrollime sama
 * bbox'i ka lokaalselt: enne filtri rakendumise kinnitust võib jõuda mõni
 * väljaspoolne sõnum.
 */
export class TranspordiametAis {
  readonly id = 'transpordiamet';
  readonly enabled = true;
  #ws: WebSocket | null = null;
  #backoff = 2000;
  #stopped = false;
  #log: ((msg: string) => void) | undefined;
  #reconnectTimer: NodeJS.Timeout | null = null;

  start(log?: (msg: string) => void): void {
    this.#log = log;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#ws?.close();
    this.#ws = null;
  }

  #connect(): void {
    if (this.#stopped) return;

    const ws = new WebSocket(URL);
    this.#ws = ws;

    ws.on('open', () => {
      const [south, west, north, east] = config.aisBbox;
      ws.send(
        JSON.stringify({
          filter: {
            geometry: {
              xmin: west,
              ymin: south,
              xmax: east,
              ymax: north,
              spatialReference: { wkid: 4326 },
            },
            outFields:
              'name,timestamp,mmsi,imo,flag,type_and_cargo,nav_status,destination,' +
              'eta,sog,cog,length,width,draught,fix_type',
          },
        }),
      );
      this.#backoff = 2000;
      this.#log?.('Transpordiamet AIS: ühendatud');
    });

    ws.on('message', (raw) => {
      try {
        this.#handle(JSON.parse(raw.toString()) as StreamMessage);
      } catch {
        // Filtri kinnitus või üksik vigane sündmus ei tohi voogu katkestada.
      }
    });

    ws.on('close', () => this.#scheduleReconnect());
    ws.on('error', (err) => {
      this.#log?.(`Transpordiamet AIS: ${err.message}`);
      // 'close' järgneb veale ja planeerib taasühenduse.
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(MAX_BACKOFF_MS, this.#backoff * 2);
    this.#log?.(
      `Transpordiamet AIS: ühendus katkes, uus katse ${Math.round(wait / 1000)} s pärast`,
    );

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, wait);
    this.#reconnectTimer.unref();
  }

  #handle(msg: StreamMessage): void {
    const attrs = msg.attributes;
    const lat = msg.geometry?.y;
    const lon = msg.geometry?.x;
    const mmsi = Number(attrs?.mmsi);
    if (!attrs || !Number.isInteger(mmsi) || mmsi <= 0) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const [south, west, north, east] = config.aisBbox;
    if (lat! < south || lat! > north || lon! < west || lon! > east) return;

    const timestamp = parseTimestamp(attrs.timestamp);
    vessels.upsertPosition({
      mmsi,
      lat: lat!,
      lon: lon!,
      sog: validRange(attrs.sog, 0, 102.2),
      cog: validRange(attrs.cog, 0, 360),
      navStat: finiteNumber(attrs.nav_status),
      positionFixType: validRange(attrs.fix_type, 0, 15),
      timestamp,
      source: 'transpordiamet',
    });

    vessels.upsertMeta(mmsi, {
      name: clean(attrs.name),
      imo: positiveInteger(attrs.imo),
      shipType: attrs.type_and_cargo,
      flag: clean(attrs.flag),
      destination: clean(attrs.destination),
      eta: parseOptionalTimestamp(attrs.eta),
      draughtM: positiveNumber(attrs.draught),
      lengthM: positiveNumber(attrs.length),
      beamM: positiveNumber(attrs.width),
      positionFixType: validRange(attrs.fix_type, 0, 15),
    });
  }
}

function parseTimestamp(value: number | string | undefined): string {
  const date = typeof value === 'number' ? new Date(value) : value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function validRange(
  value: number | null | undefined,
  min: number,
  maxExclusive: number,
): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= min && value < maxExclusive
    ? value
    : undefined;
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function parseOptionalTimestamp(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function positiveInteger(value: number | string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function clean(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export const transpordiamet = new TranspordiametAis();
