/**
 * Genereerib `src/stations/metoc.json` — TalTech METOC portaali jaamade
 * nimekirja koos koordinaatide ja tüüpidega.
 *
 * Miks eraldi skript, mitte jooksev päring: jaamade nimekiri on peidetud
 * portaali HTML-i sisse genereeritud JavaScripti (üks `new google.maps.Marker`
 * plokk jaama kohta). See nimekiri muutub ehk paar korda aastas. Jooksvalt
 * parsimine tähendaks 50 kB HTML-i tõmbamist ja regexi jooksutamist iga kord;
 * staatiline JSON on kiirem ja teeb muudatused koodiülevaatuses nähtavaks.
 *
 * Käivita:  npx tsx scripts/scrape-metoc-stations.ts
 * Tulemus tuleb üle vaadata ja commitida.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTAL = 'http://on-line.msi.ttu.ee/metoc/';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../src/stations/metoc.json');

const USER_AGENT = 'SeaPro-station-list/1.0 (+itk-arendus@itk-ib.ee)';

interface StationDef {
  id: string;
  name: string;
  kind: 'coastal' | 'offshore' | 'buoy';
  lat: number;
  lon: number;
}

async function main(): Promise<void> {
  console.log(`Tõmban ${PORTAL} …`);
  const html = await fetch(PORTAL, { headers: { 'User-Agent': USER_AGENT } }).then((r) => r.text());

  // Markerid ja jaamade slugid esinevad samas järjekorras: iga jaama kohta
  // üks Marker-plokk ja üks mouseover-käsitleja station-parameetriga.
  const markers = [
    ...html.matchAll(
      /new google\.maps\.Marker\(\{\s*map: gmap, position: new google\.maps\.LatLng\(([-\d.]+), ([-\d.]+)\), icon: (\w+) \}\);/g,
    ),
  ];
  const slugs = [...html.matchAll(/'station': '([a-z0-9_]+)'/g)].map((m) => m[1]!);

  if (markers.length === 0) {
    throw new Error('Ühtki markerit ei leitud — portaali HTML on ilmselt muutunud.');
  }
  if (markers.length !== slugs.length) {
    throw new Error(
      `Markereid ${markers.length}, jaamu ${slugs.length} — järjekord ei klapi, ära usalda tulemust.`,
    );
  }

  const stations: StationDef[] = [];

  for (let i = 0; i < markers.length; i++) {
    const [, latRaw, lonRaw, icon] = markers[i]!;
    const id = slugs[i]!;

    // Portaali legend: ring = rannikujaam, ristkülik = avamerejaam.
    // Poisid (kolmas legendikategooria) tulevad LainePoisi providerilt.
    const kind: StationDef['kind'] = icon!.startsWith('rectangle') ? 'offshore' : 'coastal';

    stations.push({
      id,
      name: await stationName(id),
      kind,
      lat: Number(Number(latRaw).toFixed(6)),
      lon: Number(Number(lonRaw).toFixed(6)),
    });
  }

  stations.sort((a, b) => a.id.localeCompare(b.id));

  await writeFile(OUT, `${JSON.stringify(stations, null, 2)}\n`, 'utf8');
  console.log(`Kirjutasin ${stations.length} jaama -> ${OUT}`);
}

/**
 * Kuvatav nimi tuleb infoaknast, nt "Kihnu (SL)". Kui päring ei õnnestu,
 * kasutame slugi — parem kehv nimi kui puuduv jaam.
 */
async function stationName(id: string): Promise<string> {
  try {
    const res = await fetch(`${PORTAL}infowindow.php`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ station: id }).toString(),
    });
    const html = await res.text();
    const match = html.match(/font-size: 17px;'>([^<]+)</);
    const name = match?.[1]?.trim();
    return name && name.length > 0 ? name : id;
  } catch {
    return id;
  }
}

await main();
