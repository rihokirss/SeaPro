import ports from '../data/navily-ports.json';

/**
 * Link Navilysse — LINK, mitte andmed.
 *
 * Kaks kuju, sest neil on kaks eri hinda:
 *
 *  1. `/carte/place/<lat>/<lon>` — TÖÖTAB IGA SADAMA JAOKS. Navily avab oma
 *     kaardi selles punktis ja loetleb ise lähedased sadamad ning ankrukohad.
 *     Meie poolt ei lähe nende serverile ühtki päringut ja katvus on sama, mis
 *     meie sadamate kihil — Soomes üksi on neid tuhandeid.
 *  2. `/port/<id>` — sadama enda leht arvustustega. Selleks on vaja NENDE
 *     sisemist id-d, mida ei ole kusagilt masinloetavalt võtta: kataloog on
 *     boti-kaitse taga ja selle sisu on nende kasutajate loodud.
 *
 * Seepärast on siin kohalik kontrollitud tabel: kus id on teada, avaneb täpne
 * leht, mujal koordinaadivaade. Esimesed Eesti kirjed koostati käsitsi; uusi
 * kandidaate lisab aeglane hooldusskript ainult siis, kui nimi annab ühe
 * tugeva vaste. Kahtlased vasted jäävad koordinaadivaateks.
 *
 * Võti on sadama OSM-nimi ilma täpitähtedeta ja väiketähtedes — nii saab uue
 * rea lisada otse selle nime järgi, mida rakendus kaardil näitab.
 */
export interface NavilyPort {
  id: number;
  /** Nimeosa URL-is. Kontrollitud: server leiab sadama ID järgi ja suvaline
   *  nimeosa toimib samamoodi — hoiame õiget ainult selleks, et link näeks
   *  kasutajale välja nii, nagu Navily ise ta kirjutab. */
  slug: string;
  /** Automaatse korje kirjetel on lisaks OSM nimi ja koordinaat. Nii saavad
   *  kaks samanimelist Soome sadamat viidata eri Navily lehtedele. */
  name?: string;
  lat?: number;
  lon?: number;
}

export type NavilyPortMap = Record<string, NavilyPort>;

let PORTS = ports as NavilyPortMap;

/**
 * Server loeb skanneri faili runtime'is, seega ei pea uute linkide pärast
 * Vite'i bundle'it uuesti ehitama. Bundle'is olev tabel jääb varukoopiaks:
 * kui API on ajutiselt maas, töötavad vähemalt build'i ajal teada olnud lingid.
 */
export function setNavilyPorts(next: NavilyPortMap): void {
  PORTS = { ...PORTS, ...next };
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    // Kombineeruvad diakriitikud maha: "Kärdla" ja "Kardla" peavad sama võtme
    // andma, muidu sõltuks tabel sellest, kuidas keegi faili kirjutas.
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function navilyUrl(name: string, lat: number, lon: number): string {
  const port = resolvePort(name, lat, lon);
  // `/port/<slug>/<id>` on sadama LEHT (arvustused, teenused, hinnad).
  // `/carte/port/<id>` viib ainult kaardile ehk samasse kohta, kuhu
  // koordinaadilink — see ei anna kasutajale midagi juurde.
  if (port) return `https://www.navily.com/port/${port.slug}/${port.id}`;
  return `https://www.navily.com/carte/place/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/** Kas link viib sadama enda lehele (mitte lihtsalt kaardile)? */
/** Nimevõti katab vanad käsitsi kirjed. Uued skannerikirjed valitakse sama
 * OSM nime ja lähima koordinaadi järgi, et samanimelisi sadamaid mitte segi
 * ajada. */
function resolvePort(name: string, lat: number, lon: number): NavilyPort | undefined {
  const normalized = normalize(name);
  const legacy = PORTS[normalized];
  if (legacy) return legacy;

  let best: { port: NavilyPort; distanceKm: number } | undefined;
  for (const port of Object.values(PORTS)) {
    if (
      port.name === undefined ||
      port.lat === undefined ||
      port.lon === undefined ||
      normalize(port.name) !== normalized
    ) {
      continue;
    }
    const distanceKm = haversineKm(lat, lon, port.lat, port.lon);
    if (!best || distanceKm < best.distanceKm) best = { port, distanceKm };
  }
  // OSM ala keskpunkt võib tegelikust kaist erineda, kuid kilomeetrist suurem
  // vahe vajab juba käsitsi kontrolli.
  return best && best.distanceKm <= 1 ? best.port : undefined;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function navilyIsExactAt(name: string, lat: number, lon: number): boolean {
  return resolvePort(name, lat, lon) !== undefined;
}
