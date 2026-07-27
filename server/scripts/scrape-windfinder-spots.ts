/**
 * Genereerib `src/stations/windfinder-spots.json` — Windfinderi Eesti
 * rannikuspottide nimekirja koos koordinaatidega.
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

/** Rannikuspotid, millest ristluse alustada. */
const SEEDS = [
  'tallinn',
  'parnu',
  'kuressaare',
  'haapsalu',
  'narva-joesuu',
  'kardla',
  'paldiski',
  'kunda',
];

/** Eesti piirkast — kõik väljaspool visatakse ära. */
const BBOX = { south: 57.4, west: 21.6, north: 60.0, east: 28.3 };

/** Mitu spotti maksimaalselt koguda. Piir hoiab skripti ja päringud ohjes. */
const MAX_SPOTS = 60;

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
      console.log(`  - ${slug} — väljaspool Eestit, jätan välja`);
      continue;
    }
    spots.push({ slug, name: place.name, lat: place.lat, lon: place.lon });
    await sleep(1100); // Nominatimi kasutustingimus: max 1 päring/s.
  }

  spots.sort((a, b) => a.slug.localeCompare(b.slug));
  await writeFile(OUT, `${JSON.stringify(spots, null, 2)}\n`, 'utf8');
  console.log(`\nKirjutasin ${spots.length} spotti -> ${OUT}`);
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
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ee&q=` +
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
