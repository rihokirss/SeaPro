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
const PORT_IDS = ports as Record<string, number>;

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
  const id = PORT_IDS[normalize(name)];
  if (id !== undefined) return `https://www.navily.com/carte/port/${id}`;
  return `https://www.navily.com/carte/place/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/** Kas link viib sadama enda lehele (mitte lihtsalt kaardile)? */
export function navilyIsExact(name: string): boolean {
  return PORT_IDS[normalize(name)] !== undefined;
}
