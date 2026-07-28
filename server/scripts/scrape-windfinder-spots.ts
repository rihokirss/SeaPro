/**
 * Genereerib `src/stations/windfinder-spots.json` — Windfinderi rannikuspottide
 * nimekirja koos koordinaatidega. Katab Eesti ranniku ja Soome lahe põhjakalda
 * koos Soome edelasaarestikuga.
 *
 * Miks seda vaja on: Windfinder ei toeta koordinaadipõhiseid URL-e, ainult
 * nimelisi spotte (`/forecast/pirita`). Lähima spoti leidmiseks on vaja
 * kohalikku nimekirja. Nende spotiotsingu API on tasuline B2B-teenus,
 * seega ehitame nimekirja ise ja ühe korra.
 *
 * Kuidas: iga prognoosileht lingib naaberspottidele. Alustame käsitsi
 * valitud rannikupunktidest ja kogume linke laiuti, kuni nimekiri lakkab
 * kasvamast. Koordinaadid saame OpenStreetMapi Nominatimist, sest Windfinder
 * ise neid lehel ei avalda.
 *
 * `/forecast/<spot>` on nende robots.txt-i järgi lubatud (keelatud on ainult
 * `/forecast/*​/print`). Hoiame päringud aeglased ja ühekordsed.
 *
 * Käivita:  npx tsx scripts/scrape-windfinder-spots.ts
 * Tulemus tuleb ÜLE VAADATA ja commitida — automaatgeokodeerimine eksib
 * mõnikord samanimeliste kohtadega.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.windfinder.com';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../src/stations/windfinder-spots.json');

const UA = 'SeaPro-spot-index/1.0 (+itk-arendus@itk-ib.ee)';

/**
 * Rannikuspotid, millest ristluse alustada.
 *
 * Soome pool on siin sama tähtis kui Eesti oma: Soome laht on kitsas ja
 * kasutaja klikib prognoosi vaadates sageli üle lahe. Ainult Eesti spottidega
 * jäi põhjakallas katmata — lähim spot oli üle `MAX_SPOT_DISTANCE_KM`
 * kauguse ja provider tagastas vaikselt tühja seeria.
 *
 * Kui mõni slug ei eksisteeri, tagastab `get()` null ja ristlus läheb edasi —
 * vale oletus siin ei lõhu midagi.
 */
const SEEDS = [
  // Eesti
  'tallinn',
  'parnu',
  'kuressaare',
  'haapsalu',
  'narva-joesuu',
  'kardla',
  'paldiski',
  'kunda',
  // Soome — Soome laht ja edelarannik.
  // Kõik kuus on 2026-07-28 seisuga üle kontrollitud (HTTP 200). NB: pelk
  // 'porvoo' annab 404 — Windfinderil on see pika kujuga.
  'helsinki',
  'hanko',
  'kotka',
  'porvoo_uusimaa_finland',
  'turku',
  'mariehamn',
];

/**
 * Piirkast — kõik väljaspool visatakse ära.
 * Katab Eesti ranniku, Soome lahe mõlemad kaldad ja Soome edelasaarestiku
 * (Turu 60.45, Ahvenamaa lääneserv ~19.5).
 */
const BBOX = { south: 57.4, west: 19.0, north: 61.0, east: 28.3 };

/** Mitu spotti maksimaalselt koguda. Piir hoiab skripti ja päringud ohjes. */
const MAX_SPOTS = 140;

/**
 * Käsitsi kontrollitud koordinaadid, mis kirjutavad automaatika üle.
 *
 * `geocode()` küsib ainult slugi esimest osa, seega liitnimed saavad emalinna
 * koordinaadi: `porvoo_emasalo` sai Porvoo oma (15 km viga), `kotka_haapasaari`
 * Kotka oma (30 km). Rannikurakenduses on selline viga tähendusrikas — 30 km
 * avamerd eemal puhub päris teine tuul.
 *
 * Siin loetletud väärtused on ükshaaval Nominatimist eristava nimega üle
 * küsitud ja silmaga kontrollitud. Ilma selle nimekirjata taastaks järgmine
 * täisristlus vead vaikselt.
 */
const MANUAL_SPOTS: Spot[] = [
  { slug: 'kotka_haapasaari', name: 'Haapasaari', lat: 60.2884, lon: 27.19 },
  { slug: 'pernaja_orrengrund', name: 'Orrengrund', lat: 60.2747, lon: 26.4455 },
  { slug: 'porvoo_emasalo', name: 'Emäsalo', lat: 60.2593, lon: 25.6178 },
  { slug: 'harmaja_helsinki', name: 'Harmaja', lat: 60.1048, lon: 24.9751 },
  { slug: 'suomenlinna', name: 'Suomenlinna', lat: 60.1444, lon: 24.9854 },
  { slug: 'uto', name: 'Utö', lat: 59.7806, lon: 21.3741 },
  { slug: 'vilsandi', name: 'Vilsandi', lat: 58.3811, lon: 21.859 },
  { slug: 'kihnu', name: 'Kihnu', lat: 58.1261, lon: 23.9853 },
  { slug: 'hiiumaa_island_torvanina_beach', name: 'Tõrvanina', lat: 59.0329, lon: 22.676 },
  { slug: 'kose_harjumaa_estonia', name: 'Kose alevik', lat: 59.1801, lon: 25.1679 },
  // Ida-rannik. Ristlus ei jõua nendeni — Kunda ja Narva-Jõesuu naaberlingid
  // viivad sisemaale (Rakvere, Vinni, Kiviõli), mitte mööda rannikut edasi.
  // Toila katab Sillamäe, Loksa terve Lahemaa (Käsmu, Viinistu, Pärispea).
  { slug: 'toila', name: 'Toila alevik', lat: 59.4209, lon: 27.5133 },
  { slug: 'loksa', name: 'Loksa linn', lat: 59.5785, lon: 25.7173 },
];

/**
 * Slugid, mille koordinaati ei õnnestunud kinnitada. Vale koordinaat on
 * halvem kui puuduv spot: nearestSpot valib selle vaikselt välja ja näitab
 * hoopis teise koha tuult.
 */
const REJECT = new Set(['aland_nabben', 'lahe_pank']);

interface Spot {
  slug: string;
  name: string;
  lat: number;
  lon: number;
}

async function main(): Promise<void> {
  const found = new Set<string>(SEEDS);
  const queue = [...SEEDS];
  const visited = new Set<string>();

  while (queue.length > 0 && found.size < MAX_SPOTS) {
    const slug = queue.shift()!;
    if (visited.has(slug)) continue;
    visited.add(slug);

    const html = await get(`${BASE}/forecast/${slug}`);
    if (!html) continue;

    for (const m of html.matchAll(/href="\/forecast\/([a-z0-9_-]+)"/g)) {
      const neighbour = m[1]!;
      if (found.has(neighbour) || found.size >= MAX_SPOTS) continue;
      found.add(neighbour);
      queue.push(neighbour);
    }

    console.log(`${slug}: kokku ${found.size} spotti, järjekorras ${queue.length}`);
    await sleep(1200); // Viisakus: ~1 päring sekundis.
  }

  const spots: Spot[] = [];

  for (const slug of found) {
    const place = await geocode(slug);
    if (!place) {
      console.log(`  ? ${slug} — koordinaate ei leitud, jätan välja`);
      continue;
    }
    if (
      place.lat < BBOX.south ||
      place.lat > BBOX.north ||
      place.lon < BBOX.west ||
      place.lon > BBOX.east
    ) {
      console.log(`  - ${slug} — väljaspool piirkasti, jätan välja`);
      continue;
    }
    spots.push({ slug, name: place.name, lat: place.lat, lon: place.lon });
    await sleep(1100); // Nominatimi kasutustingimus: max 1 päring/s.
  }

  /*
   * Õdeslugid samal koordinaadil tuleb kokku tõmmata.
   *
   * `geocode()` küsib ainult slugi esimest osa, seega `kotka`,
   * `kotka_haapasaari` ja `kotka_hovila` saavad kõik Kotka linna koordinaadi.
   * Haapasaari on tegelikult avameresaar ~30 km eemal.
   *
   * Vale koordinaat on halvem kui puuduv: `nearestSpot` valib selle vaikselt
   * välja ja kasutaja saab hoopis teise koha prognoosi, ilma ühegi märguandeta.
   * Seepärast jätame igast rühmast alles lühima ehk kanoonilise slugi, mille
   * kohta koordinaat ON õige.
   */
  const byCoord = new Map<string, Spot>();
  for (const s of spots) {
    if (REJECT.has(s.slug)) continue;
    // Käsitsi kontrollitud koordinaat võidab automaatika oma.
    const manual = MANUAL_SPOTS.find((m) => m.slug === s.slug);
    const spot = manual ?? s;
    const key = `${spot.lat.toFixed(4)},${spot.lon.toFixed(4)}`;
    const kept = byCoord.get(key);
    if (!kept || spot.slug.length < kept.slug.length) byCoord.set(key, spot);
  }
  // Käsitsi kirjed, mida ristlus üldse ei leidnud, lisame ikka.
  for (const m of MANUAL_SPOTS) {
    if (![...byCoord.values()].some((s) => s.slug === m.slug)) {
      byCoord.set(`${m.lat.toFixed(4)},${m.lon.toFixed(4)}`, m);
    }
  }
  const unique = [...byCoord.values()];
  if (unique.length < spots.length) {
    console.log(`\n  Sama koordinaadi õdeslugid: ${spots.length - unique.length} kirjet eemaldatud`);
  }

  unique.sort((a, b) => a.slug.localeCompare(b.slug));
  await writeFile(OUT, `${JSON.stringify(unique, null, 2)}\n`, 'utf8');
  console.log(`\nKirjutasin ${unique.length} spotti -> ${OUT}`);
  console.log('VAATA TULEMUS ÜLE enne commitimist.');
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Slug -> kohanimi -> koordinaadid. Slugid on kujul "narva-joesuu" või "parnu_parnumaa_estonia". */
async function geocode(slug: string): Promise<{ name: string; lat: number; lon: number } | null> {
  const query = slug
    .split('_')[0]!
    .replace(/-/g, ' ')
    .trim();

  try {
    // countrycodes=ee,fi — Soome pool peab läbi tulema. Ilma "fi"-ta jäid
    // Soome spotid koordinaatideta ja kukkusid nimekirjast välja isegi siis,
    // kui ristlus nad üles leidis.
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ee,fi&q=` +
      encodeURIComponent(query);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const list = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    const first = list[0];
    if (!first) return null;
    return {
      name: first.display_name.split(',')[0]!.trim(),
      lat: Number(first.lat),
      lon: Number(first.lon),
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

await main();
