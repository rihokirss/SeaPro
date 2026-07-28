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
    const key = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
    const kept = byCoord.get(key);
    if (!kept || s.slug.length < kept.slug.length) byCoord.set(key, s);
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
