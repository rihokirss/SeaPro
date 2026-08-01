import { config } from '../config.js';
import { fetchJson } from '../http.js';
import { vessels } from './registry.js';

const BASE = 'https://meri.digitraffic.fi/api/ais/v1';

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

  get enabled(): boolean {
    return true;
  }

  /** Tõmbab kõik positsioonid meie huvipiirkonnas registrisse. */
  async poll(): Promise<number> {
    const [south, west, north, east] = config.aisBbox;

    // Digitraffic pakub raadius- või täisnimekirja päringut, aga mitte bbox'i.
    // Täisnimekiri on ~2000 laeva ja tuleb gzip'itult paarisaja kilobaidina;
    // filtreerime ise, sest see on ühe päringuga odavam kui mitu raadiust.
    const res = await fetchJson<LocationsResponse>(`${BASE}/locations`, {
      headers: { 'Digitraffic-User': `SeaPro/${config.appVersion}` },
      timeoutMs: 25_000,
    });

    let count = 0;
    for (const f of res.features ?? []) {
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const [lon, lat] = coords;
      if (lat < south || lat > north || lon < west || lon > east) continue;

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
