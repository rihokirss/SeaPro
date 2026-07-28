/**
 * Leiab Eesti ja Soome lahe põhjakalda OSM-sadamatele Navily otselingid.
 *
 * Oluline: skript EI rooma Navily API-t ega sadamalehti. Navily API
 * robots.txt keelab roomamise ja veeb on Cloudflare'i taga. Otsing tehakse
 * aeglaselt Brave Searchi avalikust HTML-ist, mis juba sisaldab indekseeritud
 * kanoonilisi URL-e.
 *
 * Ohutus päringueelarvele:
 *   - vaikimisi kuni 8 otsingut ühe käivituse kohta;
 *   - vähemalt 20 sekundit päringute vahel, lisaks juhuslik viivitus;
 *   - sama nime ei küsita uuesti 30 päeva jooksul;
 *   - 403/429/503 või captcha korral katkestatakse terve jooks kohe;
 *   - olek salvestatakse iga päringu järel, seega jätkub järgmine jooks sealt,
 *     kus eelmine pooleli jäi.
 *
 * Kasutus:
 *   npm run navily:smoke --workspace=server
 *   npm run navily:scan --workspace=server
 *   npm run navily:scan --workspace=server -- --max-requests=25 --delay-ms=15000
 *   npm run navily:scan --workspace=server -- --watch
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseNavilyCandidate,
  extractBraveCandidates,
  normalizeNavilyName,
  type NavilySearchCandidate,
} from '../src/navily/scanner.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const OUT = resolve(ROOT, 'web/src/data/navily-ports.json');
const STATE_FILE = resolve(ROOT, 'data/navily-scan-state.json');

const SEARCH_URL = 'https://search.brave.com/search';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  'Chrome/126.0 Safari/537.36 SeaPro-Navily-Link-Maintainer/1.0';
const OVERPASS_USER_AGENT = 'SeaPro-harbour-index/1.0';

const REGIONS = [
  // Eesti läänerannik ja saared. Idapiir jätab välja Võrtsjärve, Emajõe ja
  // Peipsi siseveesadamad, mida ranniku esimese korje hulka pole vaja.
  { country: 'Estonia', south: 57.4, west: 21.5, north: 59.3, east: 24.3 },
  // Eesti põhjarannik Paldiskist Narva-Jõesuuni.
  { country: 'Estonia', south: 59.2, west: 23.0, north: 59.8, east: 28.3 },
  // Turu saarestik, Ahvenamaa ja Soome edelarannik. Oma piirkond hoiab selle
  // esimese Soome lahe korje kõrval selgelt nähtava ja hiljem eraldi
  // kitsendatava/laiendatavana.
  { country: 'Finland', south: 59.5, west: 19.0, north: 61.0, east: 23.2 },
  // Soome lahe põhjakallas Hangost Kotkani.
  { country: 'Finland', south: 59.7, west: 22.5, north: 60.75, east: 28.3 },
] as const;

const OSM_REGION_VERSION = 3;

const SMOKE_NAMES = ['pirita sadam', 'lennusadam', 'virtsu sadam'];

interface PortLink {
  id: number;
  slug: string;
  name?: string;
  lat?: number;
  lon?: number;
}

interface Harbour {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  priority: number;
}

interface SearchRecord {
  checkedAt: number;
  candidates: NavilySearchCandidate[];
  acceptedUrl?: string;
  score: number;
  ambiguous: boolean;
}

interface ScannerState {
  version: 2;
  osmRegionVersion?: number;
  osmFetchedAt?: number;
  lastRequestAt?: number;
  blockedUntil?: number;
  harbours: Harbour[];
  searches: Record<string, SearchRecord>;
}

interface Args {
  smoke: boolean;
  dryRun: boolean;
  watch: boolean;
  focus?: 'finland-archipelago';
  maxRequests: number;
  delayMs: number;
  refreshDays: number;
  intervalHours: number;
}

class RateLimitError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.smoke) {
    await smokeTest(args);
    return;
  }

  do {
    const retryDelayMs = await scanBatch(args);
    if (!args.watch) break;
    const waitMs = retryDelayMs ?? args.intervalHours * 3600_000;
    console.log(
      `Järgmine väike skann umbes ${(waitMs / 3600_000).toFixed(1)} tunni pärast.`,
    );
    await sleep(waitMs);
  } while (true);
}

async function smokeTest(args: Args): Promise<void> {
  const ports = await readPorts();
  let requests = 0;

  for (const name of SMOKE_NAMES) {
    const expected = ports[normalizeNavilyName(name)];
    if (!expected) throw new Error(`Smoke-test: teadaolev sadam puudub tabelist: ${name}`);

    if (requests > 0) await politeDelay(args.delayMs);
    requests += 1;
    const candidates = await searchNavily(name, 'Estonia');
    const expectedUrl = navilyUrl(expected);
    const found = candidates.some((candidate) => candidate.url === expectedUrl);
    console.log(`${found ? 'OK' : 'VIGA'}  ${name} -> ${expectedUrl}`);
    if (!found) {
      throw new Error(
        `Smoke-test ei leidnud teadaolevat URL-i. Kandidaadid: ${candidates
          .map((candidate) => candidate.url)
          .join(', ') || 'puuduvad'}`,
      );
    }
  }

  console.log(`Smoke-test korras: ${requests}/${SMOKE_NAMES.length} päringut.`);
}

async function scanBatch(args: Args): Promise<number | undefined> {
  const state = await readState();
  const ports = await readPorts();

  if (state.blockedUntil && state.blockedUntil > Date.now()) {
    const remainingMs = state.blockedUntil - Date.now();
    console.log(
      `Otsingumootori cooldown kestab kuni ${new Date(state.blockedUntil).toISOString()}; ` +
        'sellel jooksul päringuid ei tee.',
    );
    return remainingMs + 5000;
  }

  if (
    state.osmRegionVersion !== OSM_REGION_VERSION ||
    !state.osmFetchedAt ||
    Date.now() - state.osmFetchedAt > 7 * 86400_000
  ) {
    state.harbours = await fetchHarbours();
    state.osmRegionVersion = OSM_REGION_VERSION;
    state.osmFetchedAt = Date.now();
    await writeState(state);
    console.log(`OSM-ist ${state.harbours.length} nimetatud sadamat.`);
  } else {
    console.log(`OSM-i vahemälust ${state.harbours.length} nimetatud sadamat.`);
  }

  const cutoff = Date.now() - args.refreshDays * 86400_000;
  const queue = state.harbours
    .filter((harbour) => {
      const key = normalizeNavilyName(harbour.name);
      if (hasPort(ports, harbour)) return false;
      return !state.searches[key] || state.searches[key]!.checkedAt < cutoff;
    })
    .sort(
      (a, b) =>
        focusRank(b, args.focus) - focusRank(a, args.focus) ||
        (b.priority ?? 0) - (a.priority ?? 0) ||
        a.country.localeCompare(b.country) ||
        a.name.localeCompare(b.name),
    );

  if (queue.length === 0) {
    console.log('Kõik praegu teadaolevad sadamad on tabelis või värskelt kontrollitud.');
    return undefined;
  }

  console.log(
    `Kontrollimata/aegunud: ${queue.length}; selle jooksu piir: ${args.maxRequests} päringut.`,
  );

  let requests = 0;
  let added = 0;
  let retryDelayMs: number | undefined;
  for (const harbour of queue) {
    if (requests >= args.maxRequests) break;
    await waitForRequestSlot(state.lastRequestAt, args.delayMs);

    try {
      requests += 1;
      const candidates = await searchNavily(harbour.name, harbour.country);
      state.lastRequestAt = Date.now();
      state.blockedUntil = undefined;
      const decision = chooseNavilyCandidate(harbour.name, candidates);
      const key = normalizeNavilyName(harbour.name);

      state.searches[key] = {
        checkedAt: Date.now(),
        candidates,
        acceptedUrl: decision.candidate?.url,
        score: decision.score,
        ambiguous: decision.ambiguous,
      };

      if (decision.candidate) {
        const coordinateKey =
          `${key} @ ${harbour.lat.toFixed(5)},${harbour.lon.toFixed(5)}`;
        ports[coordinateKey] = {
          id: decision.candidate.id,
          slug: decision.candidate.slug,
          name: harbour.name,
          lat: harbour.lat,
          lon: harbour.lon,
        };
        added += 1;
        console.log(
          `+ ${harbour.name} (${harbour.country}) -> ${decision.candidate.url} ` +
            `[${decision.score.toFixed(2)}]`,
        );
        if (!args.dryRun) await writePorts(ports);
      } else {
        const reason = decision.ambiguous
          ? 'mitu võrdset kandidaati'
          : candidates.length === 0
            ? 'tulemust pole'
            : `nõrk vaste ${decision.score.toFixed(2)}`;
        console.log(`? ${harbour.name} (${harbour.country}) — ${reason}`);
      }

      await writeState(state);
    } catch (error) {
      if (error instanceof RateLimitError) {
        state.lastRequestAt = Date.now();
        // Kui vastus ei anna Retry-After väärtust, on kuus tundi teadlikult
        // konservatiivne. Korduv käsitsi käivitamine ei hakka blokki vasardama.
        state.blockedUntil = Date.now() + 6 * 3600_000;
        await writeState(state);
        console.warn(`Peatun viisakalt: ${error.message}`);
        retryDelayMs = 6 * 3600_000 + 5000;
        break;
      }
      throw error;
    }
  }

  console.log(
    `Valmis: ${requests} otsingupäringut, ${added} uut otselinki` +
      `${args.dryRun ? ' (dry-run, tabelit ei muudetud)' : ''}.`,
  );
  console.log(`Detailne kontrollraport: ${STATE_FILE}`);
  return retryDelayMs;
}

async function searchNavily(
  name: string,
  country: string,
): Promise<NavilySearchCandidate[]> {
  const query = `site:navily.com/port/ "${name}" "${country}"`;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&source=web`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });

  if ([403, 429, 503].includes(response.status)) {
    const retry = response.headers.get('retry-after');
    throw new RateLimitError(
      `otsing vastas HTTP ${response.status}${retry ? `; Retry-After ${retry}` : ''}`,
    );
  }
  if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}`);

  const html = await response.text();
  if (
    /<title>[^<]*(captcha|verify|blocked|too many requests)/i.test(html) ||
    /cf-mitigated|__cf_chl_/i.test(html)
  ) {
    throw new RateLimitError('otsing näitas captcha/botikontrolli');
  }
  return extractBraveCandidates(html);
}

async function fetchHarbours(): Promise<Harbour[]> {
  const parts = REGIONS.flatMap((region) => [
    `node["leisure"="marina"](${bbox(region)});`,
    `way["leisure"="marina"](${bbox(region)});`,
    `relation["leisure"="marina"](${bbox(region)});`,
  ]).join('\n');
  const query = `[out:json][timeout:90];\n(\n${parts}\n);\nout center tags;`;

  const body = new URLSearchParams({ data: query });
  let data:
    | {
        elements?: Array<{
          type: string;
          id: number;
          lat?: number;
          lon?: number;
          center?: { lat: number; lon: number };
          tags?: Record<string, string>;
        }>;
      }
    | undefined;
  let lastError = '';

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': OVERPASS_USER_AGENT,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        lastError = `${endpoint}: HTTP ${response.status} ${(await response.text()).slice(0, 160)}`;
        continue;
      }
      data = (await response.json()) as typeof data;
      break;
    } catch (error) {
      lastError = `${endpoint}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (!data) throw new Error(`Overpass ei vastanud: ${lastError}`);

  const unique = new Map<string, Harbour>();
  for (const element of data.elements ?? []) {
    const name = element.tags?.name ?? element.tags?.['name:et'] ?? element.tags?.['name:fi'];
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!name || lat === undefined || lon === undefined) continue;

    const region = REGIONS.find(
      (item) =>
        lat >= item.south && lat <= item.north && lon >= item.west && lon <= item.east,
    );
    if (!region) continue;

    const key = `${element.type}/${element.id}`;
    const tags = element.tags ?? {};
    const priority =
      (tags['ref:LOCODE'] ? 6 : 0) +
      (tags.website || tags['contact:website'] ? 3 : 0) +
      (tags.phone || tags['contact:phone'] ? 2 : 0) +
      (tags.operator ? 1 : 0) +
      (tags.capacity ? 1 : 0);
    unique.set(key, { id: key, name, lat, lon, country: region.country, priority });
  }

  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function bbox(region: (typeof REGIONS)[number]): string {
  return `${region.south},${region.west},${region.north},${region.east}`;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = value(name);
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`--${name} peab olema täisarv ${min}…${max}`);
    }
    return parsed;
  };

  const focus = value('focus');
  if (focus !== undefined && focus !== 'finland-archipelago') {
    throw new Error('--focus toetab praegu väärtust finland-archipelago');
  }

  return {
    smoke: argv.includes('--smoke'),
    dryRun: argv.includes('--dry-run'),
    watch: argv.includes('--watch'),
    focus,
    maxRequests: integer('max-requests', 8, 1, 100),
    delayMs: integer('delay-ms', 20_000, 10_000, 120_000),
    refreshDays: integer('refresh-days', 30, 1, 365),
    intervalHours: integer('interval-hours', 24, 1, 168),
  };
}

/**
 * Saaristomeri: Ahvenamaa, Turu saarestik ja Hankoni ulatuv edelasaarestik.
 * Fookus muudab ainult järjekorda — pärast selle ala läbimist jätkab skanner
 * tavapäraselt ülejäänud Eesti ja Lõuna-Soome sadamatega.
 */
function focusRank(harbour: Harbour, focus: Args['focus']): number {
  if (focus !== 'finland-archipelago') return 0;
  return harbour.country === 'Finland' &&
    harbour.lat >= 59.5 &&
    harbour.lat <= 61.0 &&
    harbour.lon >= 19.0 &&
    harbour.lon <= 23.2
    ? 1
    : 0;
}

async function readPorts(): Promise<Record<string, PortLink>> {
  return JSON.parse(await readFile(OUT, 'utf8')) as Record<string, PortLink>;
}

async function writePorts(ports: Record<string, PortLink>): Promise<void> {
  const sorted = Object.fromEntries(
    Object.entries(ports).sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, PortLink>;
  await atomicWrite(OUT, `${JSON.stringify(sorted, null, 2)}\n`);
}

async function readState(): Promise<ScannerState> {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8')) as ScannerState;
    if (state.version === 2) return state;
  } catch {
    // Esimene käivitus või katkine vana formaat: alustame puhtalt.
  }
  return { version: 2, harbours: [], searches: {} };
}

async function writeState(state: ScannerState): Promise<void> {
  await atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

function navilyUrl(port: PortLink): string {
  return `https://www.navily.com/port/${port.slug}/${port.id}`;
}

function hasPort(ports: Record<string, PortLink>, harbour: Harbour): boolean {
  const normalized = normalizeNavilyName(harbour.name);
  if (ports[normalized]) return true;
  return Object.values(ports).some(
    (port) =>
      port.name !== undefined &&
      port.lat !== undefined &&
      port.lon !== undefined &&
      normalizeNavilyName(port.name) === normalized &&
      haversineKm(harbour.lat, harbour.lon, port.lat, port.lon) <= 1,
  );
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

async function politeDelay(minimumMs: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 1500);
  await sleep(minimumMs + jitter);
}

async function waitForRequestSlot(lastRequestAt: number | undefined, minimumMs: number): Promise<void> {
  if (!lastRequestAt) return;
  const remaining = lastRequestAt + minimumMs - Date.now();
  if (remaining > 0) await politeDelay(remaining);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

await main();
