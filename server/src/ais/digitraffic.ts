import { randomUUID } from 'node:crypto';
import type { Vessel } from '@seapro/shared';
import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config.js';
import { fetchJson } from '../http.js';
import { vessels } from './registry.js';

const BASE = 'https://meri.digitraffic.fi/api/ais/v1';
const MQTT_URL = 'wss://meri.digitraffic.fi:443/mqtt';
const MQTT_TOPIC = 'vessels-v2/#';
const STREAM_STALE_MS = 2 * 60_000;

interface LocationFeature {
  mmsi: number;
  geometry?: { coordinates: [number, number] };
  properties?: {
    sog?: number;
    cog?: number;
    heading?: number;
    navStat?: number;
    /** Millisekundid epohhist — mitte AIS-i sekundiväli. */
    timestampExternal?: number;
  };
}

interface LocationsResponse {
  features?: LocationFeature[];
}

/**
 * AIS-i "väärtus puudub" sentinelid.
 *
 * AIS kodeerib teadmata väärtused skaala ülemise otsana, mitte tühjana:
 *   SOG 1023 (= 102.3 sõlme)  -> kiirus teadmata
 *   COG 3600 (= 360.0 kraadi) -> kurss teadmata
 *   Heading 511               -> vööri suund teadmata
 *
 * Ilma nende kontrollita kuvaks kaart seisvat laeva 102-sõlmese kiirusega.
 */
const SOG_UNKNOWN_KN = 102.2;
const COG_UNKNOWN_DEG = 360;

function realSog(sog: number | undefined): number | undefined {
  return sog === undefined || sog >= SOG_UNKNOWN_KN ? undefined : sog;
}

function realCog(cog: number | undefined): number | undefined {
  return cog === undefined || cog >= COG_UNKNOWN_DEG ? undefined : cog;
}

interface VesselMetadata {
  mmsi: number;
  timestamp?: number;
  name?: string;
  callSign?: string;
  imo?: number;
  shipType?: number;
  destination?: string;
  /** AIS-i pakitud MM-DD-hh-mm väärtus. */
  eta?: number;
  /** Detsimeetrites. */
  draught?: number;
  posType?: number;
  /** AIS-i mõõtmed antennist: A vöör, B ahter, C pakpoord, D tüürpoord. */
  referencePointA?: number;
  referencePointB?: number;
  referencePointC?: number;
  referencePointD?: number;
}

interface MqttLocation {
  time?: number;
  sog?: number;
  cog?: number;
  heading?: number;
  navStat?: number;
  lon?: number;
  lat?: number;
}

interface MqttMetadata {
  timestamp?: number;
  name?: string;
  callSign?: string;
  imo?: number;
  type?: number;
  destination?: string;
  eta?: number;
  draught?: number;
  posType?: number;
  refA?: number;
  refB?: number;
  refC?: number;
  refD?: number;
}

interface DecodedMetadata {
  mmsi: number;
  value: {
    name?: string;
    callSign?: string;
    imo?: number;
    shipType?: number;
    destination?: string;
    eta?: string;
    draughtM?: number;
    lengthM?: number;
    beamM?: number;
    positionFixType?: number;
    toBow?: number;
    toStern?: number;
    toPort?: number;
    toStarboard?: number;
  };
}

export type DigitrafficMqttEvent =
  | { kind: 'position'; value: Vessel }
  | { kind: 'metadata'; value: DecodedMetadata }
  | null;

/**
 * Fintraffic Digitraffic — Soome riiklik AIS-vöö.
 *
 * Tasuta, ilma võtmeta, CC BY 4.0. Kaks nõuet, mille eiramine annab 406:
 *   - `Digitraffic-User` päis (nende kasutustingimus, mitte autentimine)
 *   - gzip pakkimine peab olema lubatud
 *
 * Katvus: Soome AIS-jaamade ulatus, s.t Soome laht ja Põhja-Läänemeri.
 * Eesti põhjarannik on kaetud, Liivi laht ja Väinameri EI OLE — need katab
 * aisstream, kui võti on olemas.
 */
export class DigitrafficAis {
  readonly id = 'digitraffic';
  #metaLoadedAt = 0;
  #mqtt: MqttClient | null = null;
  #lastStreamMessageAt = 0;
  #log: ((message: string) => void) | undefined;

  get enabled(): boolean {
    return true;
  }

  get streamHealthy(): boolean {
    return Boolean(
      this.#mqtt?.connected
      && this.#lastStreamMessageAt >= Date.now() - STREAM_STALE_MS,
    );
  }

  /**
   * Püsiv MQTT-over-WebSocket voog. Digitraffic ei paku geograafilist
   * topic-filtrit, seega võtame kogu voo vastu. API-päring filtreerib ühise
   * registri kasutaja nähtava kaardiala järgi.
   */
  start(log?: (message: string) => void): void {
    if (this.#mqtt) return;
    this.#log = log;

    const client = mqtt.connect(MQTT_URL, {
      clientId: `SeaPro/${config.appVersion}; ${randomUUID()}`,
      clean: true,
      connectTimeout: 25_000,
      keepalive: 60,
      protocolVersion: 4,
      reconnectPeriod: 5_000,
    });
    this.#mqtt = client;

    client.on('connect', () => {
      client.subscribe(MQTT_TOPIC, { qos: 0 }, (error) => {
        if (error) {
          this.#log?.(`AIS Digitraffic MQTT tellimine ebaõnnestus: ${error.message}`);
          return;
        }
        // Ühendus ja tellimus on korras. Kui broker vaikib üle kahe minuti,
        // loeb streamHealthy voo ikkagi katkiseks ja REST-varu käivitub.
        this.#lastStreamMessageAt = Date.now();
        this.#log?.('AIS Digitraffic MQTT: ühendatud');
      });
    });

    client.on('message', (topic, payload) => {
      this.#lastStreamMessageAt = Date.now();
      try {
        const event = decodeDigitrafficMqtt(topic, payload.toString('utf8'));
        if (event?.kind === 'position') {
          vessels.upsertPosition(event.value);
        } else if (event?.kind === 'metadata') {
          vessels.upsertMeta(event.value.mmsi, event.value.value);
        }
      } catch {
        // Üks vigane sõnum ei tohi voogu katkestada.
      }
    });

    client.on('reconnect', () => this.#log?.('AIS Digitraffic MQTT: ühendan uuesti'));
    client.on('error', (error) => this.#log?.(`AIS Digitraffic MQTT: ${error.message}`));
  }

  stop(): void {
    const client = this.#mqtt;
    this.#mqtt = null;
    this.#lastStreamMessageAt = 0;
    if (client) client.end(true);
  }

  /** Tõmbab käivitamisel või vootõrke ajal kõik positsioonid registrisse. */
  async poll(): Promise<number> {
    // Täisnimekiri on ~2000 laeva ja tuleb gzip'itult paarisaja kilobaidina.
    // Hoiame kõik registris: vastus on juba tervikuna kohale tulnud ning
    // nähtava kaardiala filter rakendub /api/ais päringus.
    const res = await fetchJson<LocationsResponse>(`${BASE}/locations`, {
      headers: { 'Digitraffic-User': `SeaPro/${config.appVersion}` },
      timeoutMs: 25_000,
    });

    let count = 0;
    for (const f of res.features ?? []) {
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const [lon, lat] = coords;

      const props = f.properties ?? {};
      const stamp = props.timestampExternal;

      vessels.upsertPosition({
        mmsi: f.mmsi,
        lat,
        lon,
        sog: realSog(props.sog),
        cog: realCog(props.cog),
        heading: props.heading === undefined || props.heading >= 511 ? undefined : props.heading,
        navStat: props.navStat,
        timestamp: new Date(stamp ?? Date.now()).toISOString(),
        source: 'digitraffic',
      });
      count++;
    }

    // Metaandmed (nimed, tüübid) muutuvad harva — tõmbame kord 12 tunni jooksul.
    if (Date.now() - this.#metaLoadedAt > 12 * 3600_000) {
      await this.#loadMetadata();
    }

    return count;
  }

  /** Hoiab harva muutuvad nimed ja mõõtmed värskena ka terve MQTT-ühenduse ajal. */
  async refreshMetadata(): Promise<void> {
    if (Date.now() - this.#metaLoadedAt > 12 * 3600_000) await this.#loadMetadata();
  }

  async #loadMetadata(): Promise<void> {
    try {
      const list = await fetchJson<VesselMetadata[]>(`${BASE}/vessels`, {
        headers: { 'Digitraffic-User': `SeaPro/${config.appVersion}` },
        timeoutMs: 30_000,
      });
      for (const v of list) {
        const lengthM = sumPositive(v.referencePointA, v.referencePointB);
        const beamM = sumPositive(v.referencePointC, v.referencePointD);
        vessels.upsertMeta(v.mmsi, {
          name: v.name?.trim() || undefined,
          callSign: v.callSign?.trim() || undefined,
          imo: v.imo || undefined,
          shipType: v.shipType,
          destination: v.destination?.trim() || undefined,
          eta: decodePackedEta(v.eta, v.timestamp ?? Date.now()),
          draughtM: v.draught && v.draught < 255 ? v.draught / 10 : undefined,
          lengthM,
          beamM,
          positionFixType: v.posType !== undefined && v.posType < 15 ? v.posType : undefined,
          // 0 tähendab AIS-is "teadmata", mitte nullpikkust.
          toBow: v.referencePointA || undefined,
          toStern: v.referencePointB || undefined,
          toPort: v.referencePointC || undefined,
          toStarboard: v.referencePointD || undefined,
        });
      }
      this.#metaLoadedAt = Date.now();
    } catch {
      // Nimed puuduvad, positsioonid töötavad edasi. Proovime järgmisel ringil.
    }
  }
}

/** Muudab brokeri topicu ja JSON-i samasse kujusse, mida ühine register kasutab. */
export function decodeDigitrafficMqtt(topic: string, payload: string): DigitrafficMqttEvent {
  const parts = topic.split('/');
  if (parts[0] !== 'vessels-v2' || parts.length !== 3) return null;
  const mmsi = Number(parts[1]);
  if (!Number.isInteger(mmsi) || mmsi <= 0) return null;

  const kind = parts[2];
  if (kind === 'location' || kind === 'locations') {
    const msg = JSON.parse(payload) as MqttLocation;
    if (!Number.isFinite(msg.lat) || !Number.isFinite(msg.lon)) return null;
    const reportedMs = Number.isFinite(msg.time)
      ? msg.time! > 1_000_000_000_000 ? msg.time! : msg.time! * 1000
      : Date.now();
    return {
      kind: 'position',
      value: {
        mmsi,
        lat: msg.lat!,
        lon: msg.lon!,
        sog: realSog(msg.sog),
        cog: realCog(msg.cog),
        heading: msg.heading === undefined || msg.heading >= 511 ? undefined : msg.heading,
        navStat: msg.navStat,
        timestamp: new Date(reportedMs).toISOString(),
        source: 'digitraffic',
      },
    };
  }

  if (kind === 'metadata') {
    const msg = JSON.parse(payload) as MqttMetadata;
    const lengthM = sumPositive(msg.refA, msg.refB);
    const beamM = sumPositive(msg.refC, msg.refD);
    return {
      kind: 'metadata',
      value: {
        mmsi,
        value: {
          name: msg.name?.trim() || undefined,
          callSign: msg.callSign?.trim() || undefined,
          imo: msg.imo || undefined,
          shipType: msg.type,
          destination: msg.destination?.trim() || undefined,
          eta: decodePackedEta(msg.eta, msg.timestamp ?? Date.now()),
          draughtM: msg.draught && msg.draught < 255 ? msg.draught / 10 : undefined,
          lengthM,
          beamM,
          positionFixType: msg.posType !== undefined && msg.posType < 15 ? msg.posType : undefined,
          toBow: msg.refA || undefined,
          toStern: msg.refB || undefined,
          toPort: msg.refC || undefined,
          toStarboard: msg.refD || undefined,
        },
      },
    };
  }

  return null;
}

function sumPositive(a: number | undefined, b: number | undefined): number | undefined {
  const sum = (a ?? 0) + (b ?? 0);
  return sum > 0 ? sum : undefined;
}

/** AIS ETA: 4 bitti kuu, 5 päev, 5 tund, 6 minut; aastat sõnumis pole. */
function decodePackedEta(value: number | undefined, referenceMs: number): string | undefined {
  if (!value) return undefined;
  const minute = value & 0x3f;
  const hour = (value >> 6) & 0x1f;
  const day = (value >> 11) & 0x1f;
  const month = (value >> 16) & 0x0f;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return undefined;
  }

  const reference = new Date(referenceMs);
  const candidate = new Date(Date.UTC(reference.getUTCFullYear(), month - 1, day, hour, minute));
  // Aastat AIS ei edasta. Kui kuupäev on üle kuu minevikus, tähendab see
  // tavaliselt järgmise aasta reisi (oluline detsembri/jaanuari piiril).
  if (candidate.getTime() < reference.getTime() - 31 * 24 * 3600_000) {
    candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
  }
  return candidate.toISOString();
}

export const digitraffic = new DigitrafficAis();
