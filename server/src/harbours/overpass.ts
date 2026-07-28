import type { Harbour } from '@seapro/shared';
import { cache } from '../cache.js';
import { fetchJson } from '../http.js';

/**
 * Sadamad ja väikesadamad OpenStreetMapist Overpassi kaudu.
 *
 * Miks OSM ja mitte mõni ametlik register: mõõtmise järgi on Eesti 295
 * sadamakirjest 223 seotud RIIKLIKU sadamaregistriga (`sadamaregister:*`,
 * `ref:LOCODE`), st keegi on ametliku andmestiku siia toonud ja hooldab seda.
 * Katvus on kaatrimehele oluliste väljade osas hea: 94% kategooria, 81%
 * elekter ja septikutühjendus, 75% süvis ja telefon.
 *
 * See EI OLE WeatherProvider — sadam pole ilmanähtus, tal pole ajarida ega
 * ühikuid. Sundida teda sama liidese alla tähendaks tühje meetodeid, seega
 * on ta eraldi moodul oma marsruudiga.
 *
 * Overpass on tasuta ja võtmeta, aga KOORMATUD: uurimise käigus vastas avalik
 * instants kaks korda järjest 504-ga. Sellepärast on siin mitu peeglit,
 * ööpäevane TTL ja tugev lootus vahemälule — sadamad ei liigu.
 */

/** Peeglid proovitakse järjekorras. Esimene, mis vastab, võidab. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

/** Sadamad ei liigu. Päevane värskus on siin heldegi. */
const TTL_SECONDS = 24 * 3600;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

/**
 * Tõmbab sadamad piirkonna kohta.
 * `bbox` on [lõuna, lääs, põhi, ida] — sama kuju mis mujal.
 */
export async function fetchHarbours(bbox: [number, number, number, number]): Promise<Harbour[]> {
  // Kleebime bbox'i täiskraadidele: sadamate nimekiri on väike ja jäme
  // ruudustik tähendab, et kogu Eesti mahub paari vahemälukirjesse.
  const [south, west, north, east] = bbox.map((v, i) =>
    i < 2 ? Math.floor(v) : Math.ceil(v),
  ) as [number, number, number, number];

  // Ankrukohad tulevad SAMA päringuga, mitte eraldi.
  //
  // Kaks põhjust. Overpass on koormatud ja iga lisapäring on uus võimalus 504
  // saada. Ja vahemälu: sama bbox annab nüüd ühe kirje kahe asemel, ehk kihi
  // sisselülitamine ei maksa uut ringi allika juurde.
  //
  // `anchorage` on ankrupiirkond, `anchor_berth` üksik määratud koht. Mõlemad
  // on kaatri jaoks sama küsimuse vastus: kuhu ma ööseks jään.
  const query = `[out:json][timeout:60];
(
  node["leisure"="marina"](${south},${west},${north},${east});
  way["leisure"="marina"](${south},${west},${north},${east});
  node["seamark:type"="anchorage"](${south},${west},${north},${east});
  way["seamark:type"="anchorage"](${south},${west},${north},${east});
  node["seamark:type"="anchor_berth"](${south},${west},${north},${east});
  way["seamark:type"="anchor_berth"](${south},${west},${north},${east});
);
out center tags;`;

  // Võtmes on versioon, sest päringu kuju muutus: ilma selleta serveeriks vana
  // kettavahemälu ööpäeva jagu tulemusi, kus ankrukohti veel polnud.
  const key = `overpass:harbours:v2:${south},${west},${north},${east}`;

  const { value } = await cache.get(key, TTL_SECONDS, () => queryOverpass(query));
  return value;
}

async function queryOverpass(query: string): Promise<Harbour[]> {
  let lastError: unknown;

  for (const endpoint of ENDPOINTS) {
    try {
      // Päring peab minema `data=` VORMIVÄLJANA, mitte toorest kehast ega
      // URL-i parameetrina. Mõõdetult: toores keha andis 504, vormiväli 200
      // ja 331 elementi. Overpassi enda dokumentatsioon lubab mõlemat, aga
      // praktikas käitub avalik instants ainult vormiväljaga.
      const res = await fetchJson<OverpassResponse>(endpoint, {
        form: { data: query },
        // Overpass on aeglane ja koormatud; ühe peegli kordamine ei aita,
        // järgmise juurde liikumine aitab.
        timeoutMs: 90_000,
        retries: 0,
      });
      return parseHarbours(res);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Overpass ei vastanud üheltki peeglilt: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export function parseHarbours(res: OverpassResponse): Harbour[] {
  const elements = res.elements ?? [];
  if (elements.length === 0) {
    throw new Error('Overpass tagastas tühja tulemuse — päring või vorming muutus');
  }

  const out: Harbour[] = [];

  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;

    const tags = el.tags ?? {};

    const seamark = tags['seamark:type'];
    const kind: Harbour['kind'] =
      seamark === 'anchorage' || seamark === 'anchor_berth' ? 'anchorage' : 'harbour';

    const name = tags.name ?? tags['name:et'] ?? tags['seamark:name'];

    // Nimeta SADAM on kaardil ainult punkt ilma sisuta — jätame välja.
    //
    // Ankrukohaga on vastupidi: OSM-is on enamik neist nimetud, aga asukoht
    // ISE ONGI info ("siia saab varju jääda"). Nimenõue oleks kihi peaaegu
    // tühjaks teinud. Nime asemel näitab klient tüübisilti.
    if (!name && kind === 'harbour') continue;

    out.push({
      id: `${el.type}/${el.id}`,
      kind,
      name: name ?? '',
      lat,
      lon,
      category: tags['seamark:harbour:category'],
      phone: tags.phone ?? tags['contact:phone'],
      website: tags.website ?? tags['contact:website'],
      operator: tags.operator,
      maxDraught: parseMetres(tags.maxdraught),
      capacity: parseCount(tags.capacity),
      powerSupply: parseYes(tags.power_supply),
      sanitaryDump: parseYes(tags.sanitary_dump_station),
      fuel: parseYes(tags.fuel) ?? parseYes(tags['fuel:diesel']),
      drinkingWater: parseYes(tags.drinking_water),
      vhf: tags.vhf_channel ?? tags['seamark:radio_station:channel'],
      registryUrl: tags['sadamaregister:url'],
      locode: tags['ref:LOCODE'],
      anchorageCategory: tags['seamark:anchorage:category'],
      seabed: tags['seamark:bottom:nature'] ?? tags['seamark:anchorage:bottom'],
    });
  }

  // Nimetud (ankrukohad) lähevad lõppu — muidu istuks tühi nimi loendi ees.
  return out.sort((a, b) => {
    if (!a.name) return b.name ? 1 : 0;
    if (!b.name) return -1;
    return a.name.localeCompare(b.name);
  });
}

/** "3.5", "3,5" või "2.5 m" -> 3.5. Tundmatu kuju -> undefined. */
function parseMetres(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  const v = Number(m[0]);
  // Läänemere väikesadamate süvis on ühikutes meetrites; 50 m oleks
  // ilmselgelt vale ühik või vale silt.
  return Number.isFinite(v) && v > 0 && v < 50 ? v : undefined;
}

function parseCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * OSM-i loogilised väärtused pole ainult "yes"/"no": esineb "customers",
 * "limited", "public". Tõlgendame kõike, mis pole selge eitus, olemasoluna —
 * "seal on midagi" on kaatrimehele kasulikum kui "teadmata".
 */
function parseYes(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase().trim();
  if (v === 'no' || v === 'none' || v === 'false') return false;
  return true;
}
