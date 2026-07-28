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
 * Seepärast on siin väike KÄSITSI koostatud tabel: kus id on teada, avaneb
 * täpne leht, mujal koordinaadivaade. Tabelit ei kasvatata masinaga — see on
 * ühekordne korje Eesti tuntumate jahisadamate kohta ja seda võib täiendada
 * käsitsi (leia sadam navily.com-ist, kopeeri URL-i lõpust id).
 *
 * Võti on sadama OSM-nimi ilma täpitähtedeta ja väiketähtedes — nii saab uue
 * rea lisada otse selle nime järgi, mida rakendus kaardil näitab.
 */
interface NavilyPort {
  id: number;
  /** Nimeosa URL-is. Kontrollitud: server leiab sadama ID järgi ja suvaline
   *  nimeosa toimib samamoodi — hoiame õiget ainult selleks, et link näeks
   *  kasutajale välja nii, nagu Navily ise ta kirjutab. */
  slug: string;
}

const PORTS = ports as Record<string, NavilyPort>;

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
  const port = PORTS[normalize(name)];
  // `/port/<slug>/<id>` on sadama LEHT (arvustused, teenused, hinnad).
  // `/carte/port/<id>` viib ainult kaardile ehk samasse kohta, kuhu
  // koordinaadilink — see ei anna kasutajale midagi juurde.
  if (port) return `https://www.navily.com/port/${port.slug}/${port.id}`;
  return `https://www.navily.com/carte/place/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/** Kas link viib sadama enda lehele (mitte lihtsalt kaardile)? */
export function navilyIsExact(name: string): boolean {
  return PORTS[normalize(name)] !== undefined;
}
