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
    StandardClassBPositionReport?: PositionBody;
    ExtendedClassBPositionReport?: PositionBody & {
      Name?: string;
      Type?: number;
      Dimension?: Dimension;
      FixType?: number;
    };
    ShipStaticData?: {
      Name?: string;
      CallSign?: string;
      ImoNumber?: number;
      Type?: number;
      Destination?: string;
      Eta?: { Month?: number; Day?: number; Hour?: number; Minute?: number };
      MaximumStaticDraught?: number;
      FixType?: number;
      /** aisstream annab mõõtmed pesastatud objektina. */
      Dimension?: Dimension;
    };
    StaticDataReport?: {
      ReportA?: { Name?: string; Valid?: boolean };
      ReportB?: {
        CallSign?: string;
        ShipType?: number;
        Dimension?: Dimension;
        FixType?: number;
        Valid?: boolean;
      };
    };
  };
}

interface PositionBody {
  Latitude?: number;
  Longitude?: number;
  Sog?: number;
  Cog?: number;
  TrueHeading?: number;
  NavigationalStatus?: number;
}

interface Dimension {
  A?: number;
  B?: number;
  C?: number;
  D?: number;
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
          // Class B ja type 24 on väikelaevade jaoks vältimatud. Ainult
          // PositionReport + ShipStaticData piiraks voo sisuliselt Class A-le.
          FilterMessageTypes: [
            'PositionReport',
            'StandardClassBPositionReport',
            'ExtendedClassBPositionReport',
            'ShipStaticData',
            'StaticDataReport',
          ],
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

    const pos =
      msg.Message?.PositionReport ??
      msg.Message?.StandardClassBPositionReport ??
      msg.Message?.ExtendedClassBPositionReport;
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
      const lengthM = dimensionLength(stat.Dimension);
      const beamM = dimensionBeam(stat.Dimension);
      vessels.upsertMeta(mmsi, {
        name: stat.Name?.trim() || undefined,
        callSign: stat.CallSign?.trim() || undefined,
        imo: stat.ImoNumber || undefined,
        shipType: stat.Type,
        destination: stat.Destination?.trim() || undefined,
        eta: etaFromParts(stat.Eta),
        draughtM:
          stat.MaximumStaticDraught && stat.MaximumStaticDraught < 25.5
            ? stat.MaximumStaticDraught
            : undefined,
        lengthM,
        beamM,
        positionFixType: validFixType(stat.FixType),
        // 0 tähendab AIS-is "teadmata", mitte nullpikkust.
        toBow: stat.Dimension?.A || undefined,
        toStern: stat.Dimension?.B || undefined,
        toPort: stat.Dimension?.C || undefined,
        toStarboard: stat.Dimension?.D || undefined,
      });
    }

    const extended = msg.Message?.ExtendedClassBPositionReport;
    if (extended) {
      vessels.upsertMeta(mmsi, {
        name: extended.Name?.trim() || undefined,
        shipType: extended.Type,
        toBow: extended.Dimension?.A || undefined,
        toStern: extended.Dimension?.B || undefined,
        toPort: extended.Dimension?.C || undefined,
        toStarboard: extended.Dimension?.D || undefined,
        lengthM: dimensionLength(extended.Dimension),
        beamM: dimensionBeam(extended.Dimension),
        positionFixType: validFixType(extended.FixType),
      });
    }

    const report = msg.Message?.StaticDataReport;
    if (report) {
      const partA = report.ReportA?.Valid === false ? undefined : report.ReportA;
      const partB = report.ReportB?.Valid === false ? undefined : report.ReportB;
      vessels.upsertMeta(mmsi, {
        name: partA?.Name?.trim() || undefined,
        callSign: partB?.CallSign?.trim() || undefined,
        shipType: partB?.ShipType,
        toBow: partB?.Dimension?.A || undefined,
        toStern: partB?.Dimension?.B || undefined,
        toPort: partB?.Dimension?.C || undefined,
        toStarboard: partB?.Dimension?.D || undefined,
        lengthM: dimensionLength(partB?.Dimension),
        beamM: dimensionBeam(partB?.Dimension),
        positionFixType: validFixType(partB?.FixType),
      });
    }
  }
}

function dimensionLength(dimension: Dimension | undefined): number | undefined {
  const length = (dimension?.A ?? 0) + (dimension?.B ?? 0);
  return length > 0 ? length : undefined;
}

function dimensionBeam(dimension: Dimension | undefined): number | undefined {
  const beam = (dimension?.C ?? 0) + (dimension?.D ?? 0);
  return beam > 0 ? beam : undefined;
}

function validFixType(value: number | undefined): number | undefined {
  return value !== undefined && value >= 0 && value < 15 ? value : undefined;
}

/** AIS ETA-l puudub aasta; valime lähima tulevase mõistliku kuupäeva. */
function etaFromParts(
  eta: { Month?: number; Day?: number; Hour?: number; Minute?: number } | undefined,
): string | undefined {
  const { Month: month, Day: day, Hour: hour, Minute: minute } = eta ?? {};
  if (!month || !day || hour === undefined || minute === undefined) return undefined;
  if (month > 12 || day > 31 || hour > 23 || minute > 59) return undefined;

  const now = new Date();
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day, hour, minute));
  if (candidate.getTime() < now.getTime() - 31 * 24 * 3600_000) {
    candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
  }
  return candidate.toISOString();
}

export const aisstream = new AisStream();
