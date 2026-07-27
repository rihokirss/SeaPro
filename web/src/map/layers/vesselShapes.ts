import type { Vessel } from '@seapro/shared';

/**
 * Laevakere kuju päris AIS-mõõtmetes.
 *
 * AIS annab neli kaugust GPS-ANTENNIST (A vöör, B ahter, C pakpoord,
 * D tüürpoord), mitte pikkust ja laiust. See vahe on oluline: raporteeritud
 * positsioon on antenni oma ja antenn asub sageli ahtri pool. 300-meetrisel
 * konteinerlaeval tähendaks kere joonistamine positsiooni ümber sümmeetriliselt
 * ~100 m viga.
 *
 * Kuju: ristkülik kolmnurkse ninaga. Vöörikoonus võtab endale osa pikkusest —
 * mida pikem laev, seda teravam nina, sest lühikesel paadil näeks pikk koonus
 * välja nagu nool, mitte nagu paat.
 */

/** Osa laeva pikkusest, mille vöörikoonus endale võtab. */
const BOW_FRACTION = 0.22;

/** Vaikimisi mõõtmed, kui AIS neid ei anna (väike paat). */
const FALLBACK_LENGTH_M = 12;
const FALLBACK_BEAM_M = 4;

export interface HullDimensions {
  lengthM: number;
  beamM: number;
  /** Kaugus antennist vöörini, meetrites. */
  toBowM: number;
  /** Kaugus antennist pakpoordi, meetrites. */
  toPortM: number;
  /** Kas mõõtmed tulid päriselt AIS-ist või on need oletus. */
  known: boolean;
}

export function hullDimensions(v: Vessel): HullDimensions {
  const a = v.toBow;
  const b = v.toStern;
  const c = v.toPort;
  const d = v.toStarboard;

  const known = a !== undefined && b !== undefined && a + b > 0;

  if (!known) {
    return {
      lengthM: FALLBACK_LENGTH_M,
      beamM: FALLBACK_BEAM_M,
      toBowM: FALLBACK_LENGTH_M / 2,
      toPortM: FALLBACK_BEAM_M / 2,
      known: false,
    };
  }

  const lengthM = a! + b!;
  // Laius võib puududa ka siis, kui pikkus on teada. Laeva proportsioon on
  // tüüpiliselt 1:6 kuni 1:8 — kasutame konservatiivset hinnangut.
  const beamM = c !== undefined && d !== undefined && c + d > 0 ? c + d : Math.max(3, lengthM / 7);

  return {
    lengthM,
    beamM,
    toBowM: a!,
    toPortM: c !== undefined && d !== undefined && c + d > 0 ? c! : beamM / 2,
    known: true,
  };
}

/**
 * Ehitab kere hulknurga WGS84 koordinaatides.
 *
 * Punktid arvutatakse laevakoordinaatides (x = tüürpoordi suunas, y = vööri
 * suunas, alguspunkt antennis), pööratakse kursi järgi ja teisendatakse
 * kraadideks. Laiuskraadi-kohane kokkusurumine (`cos(lat)`) arvestatakse
 * pikkuskraadi teisendusel — ilma selleta oleks laev Läänemere laiuskraadidel
 * kaks korda liiga lai.
 */
export function hullPolygon(v: Vessel, dims: HullDimensions): [number, number][] {
  const { lengthM, beamM, toBowM, toPortM } = dims;

  // Laevakoordinaadid: x tüürpoordi suunas, y vööri suunas, nullpunkt ANTENNIS.
  const portEdge = -toPortM;
  const starboardEdge = beamM - toPortM;
  const toSternM = lengthM - toBowM;

  const bowStraight = toBowM - lengthM * BOW_FRACTION;

  // Vööritipp läheb kere KESKTELJELE, mitte antenni kohale. Antenn asub sageli
  // pardast nihkes (C ei võrdu D-ga) ja tipu jätmine x=0 juurde annaks viltuse,
  // mittevõrdhaarse nina — laev näeks kaardil välja, nagu ta oleks kokku
  // põrganud.
  const centrelineX = (portEdge + starboardEdge) / 2;

  const shape: [number, number][] = [
    [portEdge, bowStraight], // pakpoordi vööripiir
    [centrelineX, toBowM], // vööritipp keskteljel
    [starboardEdge, bowStraight], // tüürpoordi vööripiir
    [starboardEdge, -toSternM], // tüürpoordi ahter
    [portEdge, -toSternM], // pakpoordi ahter
  ];

  // Kurss: eelista tegelikku vööri suunda, muidu kurss üle põhja.
  const headingDeg = v.heading ?? v.cog ?? 0;
  const rad = (headingDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);

  const metersPerDegLat = 111_320;
  const metersPerDegLon = metersPerDegLat * Math.cos((v.lat * Math.PI) / 180);

  const ring = shape.map(([x, y]) => {
    // Pööra: 0° = põhi, kasvab päripäeva.
    const east = x * cos + y * sin;
    const north = -x * sin + y * cos;
    return [v.lon + east / metersPerDegLon, v.lat + north / metersPerDegLat] as [number, number];
  });

  // GeoJSON nõuab suletud rõngast.
  ring.push(ring[0]!);
  return ring;
}

/**
 * Kas seda laeva tasub joonistada päris kujuga?
 *
 * Alla mõne piksli pikk hulknurk on ekraanil täpp, mis ei kanna suunda ega
 * suurust — ikoon on siis nii loetavam kui odavam. Piir on pikslites, mitte
 * zoomitasemes, sest sama zoom tähendab 12-meetrisele paadile ja 300-meetrisele
 * laevale täiesti erinevat asja.
 *
 * 10 px tähendab Läänemere laiuskraadidel, et 100-meetrine laev saab kere
 * umbes zoomil 13 ja 300-meetrine juba zoomil 11 — täpselt see järjekord,
 * mida ka silm ootab.
 */
export const MIN_HULL_LENGTH_PX = 10;

/** Meetrit ühe ekraanipiksli kohta antud zoomil ja laiuskraadil. */
export function metersPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}
