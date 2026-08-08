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
  flag?: string;
  destination?: string;
  toBow?: number;
  toStern?: number;
  toPort?: number;
  toStarboard?: number;
  lengthM?: number;
  beamM?: number;
  eta?: string;
  draughtM?: number;
  positionFixType?: number;
  updatedAt: number;
}

interface StoredPosition {
  vessel: Vessel;
  receivedAt: number;
}

interface TimedDirection {
  value: number;
  reportedAt: number;
}

interface VesselDirection {
  cog?: TimedDirection;
  heading?: TimedDirection;
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

/**
 * Kui värskeimal positsioonil suund puudub, kasutame lühikest aega mõne teise
 * AIS-allika viimast teadaolevat COG-i või heading'ut. Suund võib manööverdades
 * kiiresti muutuda, mistõttu ei tohi seda hoida sama kaua kui positsiooni.
 */
const MAX_DIRECTION_AGE_MS = 2 * 60 * 1000;

/** Sellest aeglasemal laeval ei kirjelda COG usaldusväärselt laeva suunda. */
const MIN_COG_SPEED_KNOTS = 0.5;

/** Metaandmeid hoiame kauem — laeva nimi ei vanane. */
const MAX_META_AGE_MS = 24 * 3600 * 1000;

export class VesselRegistry {
  #positions = new Map<number, StoredPosition>();
  #meta = new Map<number, VesselMeta>();
  #directions = new Map<number, VesselDirection>();

  upsertPosition(vessel: Vessel): void {
    const existing = this.#positions.get(vessel.mmsi);
    const incoming = new Date(vessel.timestamp).getTime();

    // Suunavälju hoiame positsioonist eraldi. Teise provideri sõnum võib
    // võrguviivituse tõttu saabuda pärast uuemat positsiooni; selle positsiooni
    // jätame kõrvale, kuid värske suunainfo võib endiselt kasulik olla.
    this.#upsertDirection(vessel, incoming);

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
      flag: meta.flag ?? existing.flag,
      destination: meta.destination ?? existing.destination,
      toBow: meta.toBow ?? existing.toBow,
      toStern: meta.toStern ?? existing.toStern,
      toPort: meta.toPort ?? existing.toPort,
      toStarboard: meta.toStarboard ?? existing.toStarboard,
      lengthM: meta.lengthM ?? existing.lengthM,
      beamM: meta.beamM ?? existing.beamM,
      eta: meta.eta ?? existing.eta,
      draughtM: meta.draughtM ?? existing.draughtM,
      positionFixType: meta.positionFixType ?? existing.positionFixType,
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

      const withDirection = this.#withFallbackDirection(vessel, now);
      const meta = this.#meta.get(vessel.mmsi);
      out.push(meta ? { ...withDirection, ...stripUndefined(meta) } : withDirection);
    }

    return out;
  }

  /** Eemaldab vananenud kirjed. Kutsutakse taustatööst. */
  prune(): void {
    const posCutoff = Date.now() - MAX_RECEIVED_AGE_MS;
    for (const [mmsi, entry] of this.#positions) {
      if (entry.receivedAt < posCutoff) this.#positions.delete(mmsi);
    }
    const directionCutoff = Date.now() - MAX_DIRECTION_AGE_MS;
    for (const [mmsi, direction] of this.#directions) {
      if (direction.cog && direction.cog.reportedAt < directionCutoff) delete direction.cog;
      if (direction.heading && direction.heading.reportedAt < directionCutoff) {
        delete direction.heading;
      }
      if (!direction.cog && !direction.heading) this.#directions.delete(mmsi);
    }
    const metaCutoff = Date.now() - MAX_META_AGE_MS;
    for (const [mmsi, meta] of this.#meta) {
      if (meta.updatedAt < metaCutoff) this.#meta.delete(mmsi);
    }
  }

  get stats(): { positions: number; meta: number } {
    return { positions: this.#positions.size, meta: this.#meta.size };
  }

  #upsertDirection(vessel: Vessel, reportedAt: number): void {
    if (!Number.isFinite(reportedAt)) return;
    if (vessel.cog === undefined && vessel.heading === undefined) return;

    const direction = this.#directions.get(vessel.mmsi) ?? {};
    if (
      vessel.cog !== undefined &&
      (!direction.cog || reportedAt >= direction.cog.reportedAt)
    ) {
      direction.cog = { value: vessel.cog, reportedAt };
    }
    if (
      vessel.heading !== undefined &&
      (!direction.heading || reportedAt >= direction.heading.reportedAt)
    ) {
      direction.heading = { value: vessel.heading, reportedAt };
    }
    this.#directions.set(vessel.mmsi, direction);
  }

  #withFallbackDirection(vessel: Vessel, now: number): Vessel {
    const direction = this.#directions.get(vessel.mmsi);
    const cutoff = now - MAX_DIRECTION_AGE_MS;
    const cog = direction?.cog?.reportedAt !== undefined && direction.cog.reportedAt >= cutoff
      ? direction.cog
      : undefined;
    const heading =
      direction?.heading?.reportedAt !== undefined && direction.heading.reportedAt >= cutoff
        ? direction.heading
        : undefined;

    // Seisva laeva COG on sageli viimane liikumissuund või GPS-müra, mitte
    // vööri suund. Kasutame siis üksnes päris heading'ut (ka teise provideri
    // kuni kahe minuti vanust väärtust) ja eemaldame eksitava COG-i.
    if (vessel.sog !== undefined && vessel.sog < MIN_COG_SPEED_KNOTS) {
      const { cog: _cog, ...withoutCog } = vessel;
      if (vessel.heading !== undefined) return withoutCog;
      return heading ? { ...withoutCog, heading: heading.value } : withoutCog;
    }

    // Liikuva laeva värskeima positsiooni enda suund on vahemälust parem.
    if (vessel.cog !== undefined || vessel.heading !== undefined) return vessel;
    if (!cog && !heading) return vessel;

    // Kui väljad pärinevad eri teadetest, kasutame uuemat. Muidu võiks
    // frontend eelistada vanemat heading'ut värskemale COG-ile.
    if (heading && (!cog || heading.reportedAt > cog.reportedAt)) {
      return { ...vessel, heading: heading.value };
    }
    if (cog && (!heading || cog.reportedAt > heading.reportedAt)) {
      return { ...vessel, cog: cog.value };
    }
    return { ...vessel, cog: cog?.value, heading: heading?.value };
  }
}

function stripUndefined(meta: VesselMeta): Partial<Vessel> {
  const out: Partial<Vessel> = {};
  if (meta.name) out.name = meta.name;
  if (meta.callSign) out.callSign = meta.callSign;
  if (meta.imo) out.imo = meta.imo;
  if (meta.shipType !== undefined) out.shipType = meta.shipType;
  if (meta.flag) out.flag = meta.flag;
  if (meta.destination) out.destination = meta.destination;
  if (meta.toBow !== undefined) out.toBow = meta.toBow;
  if (meta.toStern !== undefined) out.toStern = meta.toStern;
  if (meta.toPort !== undefined) out.toPort = meta.toPort;
  if (meta.toStarboard !== undefined) out.toStarboard = meta.toStarboard;
  if (meta.lengthM !== undefined) out.lengthM = meta.lengthM;
  if (meta.beamM !== undefined) out.beamM = meta.beamM;
  if (meta.eta) out.eta = meta.eta;
  if (meta.draughtM !== undefined) out.draughtM = meta.draughtM;
  if (meta.positionFixType !== undefined) out.positionFixType = meta.positionFixType;
  return out;
}

export const vessels = new VesselRegistry();
