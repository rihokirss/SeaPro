import type { Vessel } from '@seapro/shared';

/**
 * Üks laevaregister, kuhu voolavad kõik AIS-allikad.
 *
 * Miks ühine register, mitte allikapõhised nimekirjad: sama laev näeb
 * Digitraffici ja aisstreami kaudu välja nagu kaks laeva. Liidame MMSI järgi
 * ja hoiame VÄRSKEIMAT positsiooni — nii ei hüppa laev kaardil kahe allika
 * vahel edasi-tagasi ja frontend ei pea allikatest üldse teadma.
 *
 * Nimed ja laevatüübid tulevad AIS-i staatilistest sõnumitest, mis saabuvad
 * positsioonidest palju harvemini (iga 6 min vs iga paar sekundit). Seetõttu
 * hoiame metaandmeid eraldi ja liidame need positsioonile alles väljastamisel
 * — muidu kaoks laeva nimi iga positsiooniuuendusega ära.
 */

interface VesselMeta {
  name?: string;
  callSign?: string;
  imo?: number;
  shipType?: number;
  destination?: string;
  toBow?: number;
  toStern?: number;
  toPort?: number;
  toStarboard?: number;
  updatedAt: number;
}

interface StoredPosition {
  vessel: Vessel;
  receivedAt: number;
}

/**
 * Kui kaua hoiame positsiooni mälus pärast selle SAABUMIST.
 * Kaitseb registrit kasvamast, kui allikas lakkab laeva mainimast.
 */
const MAX_RECEIVED_AGE_MS = 20 * 60 * 1000;

/**
 * Kui vana tohib laeva ENDA ajatempel olla, et teda kaardil näidata.
 *
 * See on eraldi ülemisest piirist ja tegelikult tähtsam. Digitraffic tagastab
 * igal pollimisel ka need laevad, kes on ammu vaikinud — meie saame nende
 * kirje iga 30 s tagant "värskelt", aga positsioon ise võib olla tunde vana.
 * Ilma selle kontrollita joonistas kaart laeva kohta, kus ta oli kaheksa
 * tundi tagasi. Navigatsioonipildil on see halvem kui laeva mitte näidata.
 */
const MAX_POSITION_AGE_MS = 30 * 60 * 1000;

/** Metaandmeid hoiame kauem — laeva nimi ei vanane. */
const MAX_META_AGE_MS = 24 * 3600 * 1000;

class VesselRegistry {
  #positions = new Map<number, StoredPosition>();
  #meta = new Map<number, VesselMeta>();

  upsertPosition(vessel: Vessel): void {
    const existing = this.#positions.get(vessel.mmsi);
    const incoming = new Date(vessel.timestamp).getTime();

    if (existing) {
      const current = new Date(existing.vessel.timestamp).getTime();
      // Vanem positsioon ei tohi värskemat üle kirjutada, olenemata sellest,
      // kummalt allikalt ta tuli.
      if (Number.isFinite(current) && incoming <= current) return;
    }

    this.#positions.set(vessel.mmsi, { vessel, receivedAt: Date.now() });
  }

  upsertMeta(mmsi: number, meta: Omit<VesselMeta, 'updatedAt'>): void {
    const existing = this.#meta.get(mmsi) ?? { updatedAt: 0 };
    this.#meta.set(mmsi, {
      // Tühjad väljad ei tohi olemasolevat infot kustutada.
      name: meta.name ?? existing.name,
      callSign: meta.callSign ?? existing.callSign,
      imo: meta.imo ?? existing.imo,
      shipType: meta.shipType ?? existing.shipType,
      destination: meta.destination ?? existing.destination,
      toBow: meta.toBow ?? existing.toBow,
      toStern: meta.toStern ?? existing.toStern,
      toPort: meta.toPort ?? existing.toPort,
      toStarboard: meta.toStarboard ?? existing.toStarboard,
      updatedAt: Date.now(),
    });
  }

  /** Laevad antud alas, metaandmetega rikastatult. */
  query(bbox: [number, number, number, number]): Vessel[] {
    const [south, west, north, east] = bbox;
    const now = Date.now();
    const receivedCutoff = now - MAX_RECEIVED_AGE_MS;
    const positionCutoff = now - MAX_POSITION_AGE_MS;
    const out: Vessel[] = [];

    for (const { vessel, receivedAt } of this.#positions.values()) {
      if (receivedAt < receivedCutoff) continue;
      if (vessel.lat < south || vessel.lat > north) continue;
      if (vessel.lon < west || vessel.lon > east) continue;

      const reported = new Date(vessel.timestamp).getTime();
      if (Number.isFinite(reported) && reported < positionCutoff) continue;

      const meta = this.#meta.get(vessel.mmsi);
      out.push(meta ? { ...vessel, ...stripUndefined(meta) } : vessel);
    }

    return out;
  }

  /** Eemaldab vananenud kirjed. Kutsutakse taustatööst. */
  prune(): void {
    const posCutoff = Date.now() - MAX_RECEIVED_AGE_MS;
    for (const [mmsi, entry] of this.#positions) {
      if (entry.receivedAt < posCutoff) this.#positions.delete(mmsi);
    }
    const metaCutoff = Date.now() - MAX_META_AGE_MS;
    for (const [mmsi, meta] of this.#meta) {
      if (meta.updatedAt < metaCutoff) this.#meta.delete(mmsi);
    }
  }

  get stats(): { positions: number; meta: number } {
    return { positions: this.#positions.size, meta: this.#meta.size };
  }
}

function stripUndefined(meta: VesselMeta): Partial<Vessel> {
  const out: Partial<Vessel> = {};
  if (meta.name) out.name = meta.name;
  if (meta.callSign) out.callSign = meta.callSign;
  if (meta.imo) out.imo = meta.imo;
  if (meta.shipType !== undefined) out.shipType = meta.shipType;
  if (meta.destination) out.destination = meta.destination;
  if (meta.toBow !== undefined) out.toBow = meta.toBow;
  if (meta.toStern !== undefined) out.toStern = meta.toStern;
  if (meta.toPort !== undefined) out.toPort = meta.toPort;
  if (meta.toStarboard !== undefined) out.toStarboard = meta.toStarboard;
  return out;
}

export const vessels = new VesselRegistry();
