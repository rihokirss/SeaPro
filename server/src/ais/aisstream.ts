import WebSocket from 'ws';
import { config } from '../config.js';
import { vessels } from './registry.js';

const URL = 'wss://stream.aisstream.io/v0/stream';

/** Tellimussõnum tuleb saata 3 s jooksul, muidu server sulgeb ühenduse. */
const SUBSCRIBE_DEADLINE_MS = 2500;

/** Taasühendamise ooteaeg kasvab, aga mitte üle selle. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

interface AisStreamMessage {
  MessageType?: string;
  MetaData?: {
    MMSI?: number;
    ShipName?: string;
    latitude?: number;
    longitude?: number;
    time_utc?: string;
  };
  Message?: {
    PositionReport?: {
      Latitude?: number;
      Longitude?: number;
      Sog?: number;
      Cog?: number;
      TrueHeading?: number;
      NavigationalStatus?: number;
    };
    ShipStaticData?: {
      Name?: string;
      CallSign?: string;
      ImoNumber?: number;
      Type?: number;
      Destination?: string;
    };
  };
}

/**
 * aisstream.io — globaalne kogukondlik AIS-voog.
 *
 * Täiendab Digitrafficut seal, kuhu Soome jaamad ei ulatu: Liivi laht,
 * Väinameri, Lõuna-Läänemeri. Vahe on oluline, sest just neis vetes kaater
 * enamasti sõidabki.
 *
 * Iseloom, millega tuleb arvestada:
 *  - WebSocket, mitte REST — ühendus tuleb hoida ja katkemisel taastada
 *  - beeta, ilma SLA-ta: kukkumine on normaalne, mitte erand
 *  - vajab API võtit; ilma selleta on see klass lihtsalt välja lülitatud ja
 *    AIS jääb tööle Digitraffici najal
 */
export class AisStream {
  readonly id = 'aisstream';
  #ws: WebSocket | null = null;
  #backoff = 2000;
  #stopped = false;
  #log: ((msg: string) => void) | undefined;
  #reconnectTimer: NodeJS.Timeout | null = null;

  get enabled(): boolean {
    return Boolean(config.aisstreamKey);
  }

  start(log?: (msg: string) => void): void {
    if (!this.enabled) return;
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

    // Kui tellimus ei jõua kohale õigeks ajaks, sulgeb server ühenduse ise —
    // parem on siis ise kohe uuesti proovida kui jääda ootama.
    const deadline = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.terminate();
    }, SUBSCRIBE_DEADLINE_MS + 5000);

    ws.on('open', () => {
      const [south, west, north, east] = config.aisBbox;
      ws.send(
        JSON.stringify({
          APIKey: config.aisstreamKey,
          // aisstream ootab [[[lat, lon], [lat, lon]]] — lõunalääs, kirdenurk.
          BoundingBoxes: [[[south, west], [north, east]]],
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }),
      );
      this.#backoff = 2000;
      this.#log?.('aisstream: ühendatud');
    });

    ws.on('message', (raw) => {
      try {
        this.#handle(JSON.parse(raw.toString()) as AisStreamMessage);
      } catch {
        // Üksik vigane sõnum ei tohi voogu katkestada.
      }
    });

    ws.on('close', () => {
      clearTimeout(deadline);
      this.#scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.#log?.(`aisstream: ${err.message}`);
      // 'close' tuleb 'error' järel alati — taasühendamist siin ei planeeri.
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(MAX_BACKOFF_MS, this.#backoff * 2);
    this.#log?.(`aisstream: ühendus katkes, uus katse ${Math.round(wait / 1000)} s pärast`);

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, wait);
    this.#reconnectTimer.unref();
  }

  #handle(msg: AisStreamMessage): void {
    const mmsi = msg.MetaData?.MMSI;
    if (!mmsi) return;

    const pos = msg.Message?.PositionReport;
    if (pos && pos.Latitude !== undefined && pos.Longitude !== undefined) {
      vessels.upsertPosition({
        mmsi,
        lat: pos.Latitude,
        lon: pos.Longitude,
        // Samad "teadmata" sentinelid kui Digitrafficul — vt digitraffic.ts.
        sog: pos.Sog === undefined || pos.Sog >= 102.2 ? undefined : pos.Sog,
        cog: pos.Cog === undefined || pos.Cog >= 360 ? undefined : pos.Cog,
        heading:
          pos.TrueHeading === undefined || pos.TrueHeading >= 511 ? undefined : pos.TrueHeading,
        navStat: pos.NavigationalStatus,
        timestamp: msg.MetaData?.time_utc
          ? new Date(msg.MetaData.time_utc).toISOString()
          : new Date().toISOString(),
        source: 'aisstream',
      });

      // Nimi tuleb kaasa ka positsioonisõnumi metaandmetes — kasutame seda,
      // sest staatiline sõnum saabub palju harvemini.
      const name = msg.MetaData?.ShipName?.trim();
      if (name) vessels.upsertMeta(mmsi, { name });
    }

    const stat = msg.Message?.ShipStaticData;
    if (stat) {
      vessels.upsertMeta(mmsi, {
        name: stat.Name?.trim() || undefined,
        callSign: stat.CallSign?.trim() || undefined,
        imo: stat.ImoNumber || undefined,
        shipType: stat.Type,
        destination: stat.Destination?.trim() || undefined,
      });
    }
  }
}

export const aisstream = new AisStream();
