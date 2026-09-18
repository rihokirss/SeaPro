import WebSocket from 'ws';
import type { AisBaseStation } from '@seapro/shared';
import { config } from '../config.js';

const URL =
  'wss://gis.transpordiamet.ee/gisevent/ws/services/' +
  'AIS-base-station-stream-out/StreamServer/subscribe';
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 30 * 60 * 1000;

const STATION_NAMES: Record<string, string> = {
  '002766000': 'Ruhnu',
  '002766010': 'Torgu',
  '002766020': 'Tõstamaa',
  '002766030': 'Undva',
  '002766040': 'Orissaare',
  '002766050': 'Kõpu',
  '002766060': 'Tahkuna',
  '002766080': 'Dirhami',
  '002766100': 'Pakri',
  '002766140': 'Viimsi',
  '002766160': 'Juminda',
  '002766180': 'Letipea',
  '002766190': 'Valaste',
  '002300085': 'Haapasaari',
  '002300108': 'Espoo',
  '002300047': 'Emäsalo',
  '002300084': 'Lappvik',
  '002300048': 'Harmaja',
  '002300046': 'Orrengrund',
  '002300051': 'Utö',
  '002300053': 'Russarö',
  '002300049': 'Uppinniemi',
  '002300103': 'Virolahti',
  '002750150': 'Jaunupe',
  '002750110': 'Vitrupe',
  '002750120': 'Kolka',
  '002750160': 'Uzava',
  '002734469': 'Gogland',
  '002734468': 'Gorki',
  '002734451': 'Vysotsk',
};

interface StreamMessage {
  geometry?: { x?: number; y?: number };
  attributes?: {
    mmsi?: number | string;
    msg_type?: number;
    timestamp?: number | string;
    fix_type?: string;
    prev_mtyp1?: number;
    prev_mdt1?: number | string;
    lon?: number;
    lat?: number;
  };
}

interface StoredStation {
  station: AisBaseStation;
  receivedAt: number;
}

/** AIS baasjaamade reaalaja register Transpordiameti GeoEvent voost. */
export class AisBaseStationStream {
  #items = new Map<string, StoredStation>();
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

  query([south, west, north, east]: [number, number, number, number]): AisBaseStation[] {
    const cutoff = Date.now() - MAX_AGE_MS;
    return [...this.#items.values()]
      .filter(({ station, receivedAt }) => receivedAt >= cutoff
        && station.lat >= south && station.lat <= north
        && station.lon >= west && station.lon <= east)
      .map(({ station }) => station);
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
            'mmsi,msg_type,timestamp,fix_type,prev_mtyp1,prev_mdt1,lon,lat',
        },
      }));
      this.#backoff = 2000;
      this.#log?.('AIS baasjaamad: ühendatud');
    });

    ws.on('message', (raw) => {
      try {
        this.#handle(JSON.parse(raw.toString()) as StreamMessage);
      } catch {
        // Filtri kinnitus või vigane üksiksõnum ei katkesta voogu.
      }
    });
    ws.on('close', () => this.#scheduleReconnect());
    ws.on('error', (error) => this.#log?.(`AIS baasjaamad: ${error.message}`));
  }

  #handle(message: StreamMessage): void {
    const attributes = message.attributes;
    const mmsiText = String(attributes?.mmsi ?? '').trim();
    const lat = finiteNumber(message.geometry?.y) ?? finiteNumber(attributes?.lat);
    const lon = finiteNumber(message.geometry?.x) ?? finiteNumber(attributes?.lon);
    if (!attributes || !/^\d{9}$/.test(mmsiText) || lat === undefined || lon === undefined) {
      return;
    }

    const [south, west, north, east] = config.aisBbox;
    if (lat < south || lat > north || lon < west || lon > east) return;

    const updatedAt = dateValue(attributes.timestamp);
    const existing = this.#items.get(mmsiText);
    if (existing && updatedAt && existing.station.updatedAt
      && new Date(updatedAt).getTime() <= new Date(existing.station.updatedAt).getTime()) return;

    this.#items.set(mmsiText, {
      station: {
        id: `ais-base:${mmsiText}`,
        mmsi: mmsiText,
        name: STATION_NAMES[mmsiText] ?? `AIS baasjaam ${mmsiText}`,
        lat,
        lon,
        country: countryFromMmsi(mmsiText),
        fixType: attributes.fix_type?.trim() || undefined,
        messageType: finiteNumber(attributes.msg_type),
        previousMessageType: finiteNumber(attributes.prev_mtyp1),
        previousMessageAt: dateValue(attributes.prev_mdt1),
        updatedAt,
      },
      receivedAt: Date.now(),
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(MAX_BACKOFF_MS, this.#backoff * 2);
    this.#log?.(`AIS baasjaamad: uus ühendus ${Math.round(wait / 1000)} s pärast`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, wait);
    this.#reconnectTimer.unref();
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function dateValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function countryFromMmsi(mmsi: string): string | undefined {
  if (mmsi.startsWith('00276')) return 'EST';
  if (mmsi.startsWith('00230')) return 'FIN';
  if (mmsi.startsWith('00275')) return 'LVA';
  if (mmsi.startsWith('00273')) return 'RUS';
  return undefined;
}

export const aisBaseStations = new AisBaseStationStream();
