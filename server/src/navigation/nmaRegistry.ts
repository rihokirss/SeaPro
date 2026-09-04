import type { BBox, Fairway, NavigationAid } from '@seapro/shared';
import { fetchText } from '../http.js';
import { categoryFromRegistry } from './categories.js';
import { navigationSnapshots, snapshotAids } from './snapshots.js';

const NMA_XML = 'https://nma.transpordiamet.ee/xml_file/';
const REGISTRY_TTL = 24 * 3600;

export interface NmaAidDetails {
  typeName: string;
  colours?: string;
  description?: string;
}

export type NmaAidIndex = Record<string, NmaAidDetails>;

/**
 * NMA avalik koondfail uueneb kord ööpäevas. Üks globaalne indekseeritud
 * allalaadimine on nii NMA-le kui meie serverile odavam kui iga kaardimärgi
 * HTML-lehe eraldi küsimine.
 */
export async function fetchNmaAidIndex(): Promise<NmaAidIndex> {
  return parseNmaAidIndex((await fetchNmaXml()).value);
}

function fetchNmaXml() {
  return navigationSnapshots.get('nma:xml:v1', REGISTRY_TTL, () =>
    fetchText(NMA_XML, {
      timeoutMs: 30_000,
      retries: 1,
      headers: { Accept: 'application/xml' },
    }), (value): value is string => typeof value === 'string'
      && /<\/SOAP-ENV:Envelope>\s*$/.test(value)
      && parseNmaNavigationAids(value).length > 0);
}

/** Kogu Eesti koondfail on üks püsikoopia, seega töötab ka varem vaatamata ala. */
export async function fetchNmaNavigationAids(bbox: BBox): Promise<NavigationAid[]> {
  const snapshot = await fetchNmaXml();
  const [south, west, north, east] = bbox;
  return snapshotAids(parseNmaNavigationAids(snapshot.value).filter((aid) =>
    aid.lat >= south && aid.lat <= north && aid.lon >= west && aid.lon <= east), snapshot);
}

export async function fetchNmaLeadingLines(bbox: BBox): Promise<Fairway[]> {
  const snapshot = await fetchNmaXml();
  return parseNmaLeadingLines(snapshot.value).filter((line) => geometryIntersectsBbox(line, bbox));
}

export function parseNmaNavigationAids(xml: string): NavigationAid[] {
  const index = parseNmaAidIndex(xml);
  return [...xml.matchAll(/<Navimark>([\s\S]*?)<\/Navimark>/g)].flatMap((match) => {
    const body = match[1]!;
    const atonCode = tag(body, 'EstNo');
    const name = tag(body, 'Name');
    const registry = atonCode ? index[atonCode] : undefined;
    // NMA XSD: koordinaadid on miljondikes kaareminutites, mitte kraadides.
    // https://nma.transpordiamet.ee/xsd_file
    const lat = Number(tag(body, 'Latitude')) / 60_000_000;
    const lon = Number(tag(body, 'Longitude')) / 60_000_000;
    if (!atonCode || !name || !registry || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    const floating = /poi|tooder/i.test(registry.typeName);
    const season = tag(body, 'Season');
    const kind = floating ? (season && season !== 'Aastaringne' ? 'seasonal' : 'floating') : 'fixed';
    const light = tag(body, 'LightActive');
    return [{
      id: `aton:nma:${atonCode}`,
      atonCode, name, lat, lon, kind,
      registryType: registry.typeName,
      category: categoryFromRegistry(name, kind, undefined, registry.typeName),
      markColours: markColoursFromNma(registry),
      lightActive: light === '1' ? true : light === '0' ? false : undefined,
      lightDetails: tag(body, 'LightChar'),
      owner: tag(body, 'HolderName'),
      location: tag(body, 'Loc_descr'),
      fairwayName: tag(body, 'Fairway'),
      sources: ['registry'],
    } satisfies NavigationAid];
  });
}

/**
 * Koostab liitsihi ülemisest märgist läbi alumise märgi töötsooni lõpuni.
 * NMA kordab sama `LeadingLine` plokki mõlema märgi all, mistõttu deduplime
 * märginumbrite ja nime järgi.
 */
export function parseNmaLeadingLines(xml: string): Fairway[] {
  const positions = new Map<string, [number, number]>();
  const markBodies = [...xml.matchAll(/<Navimark>([\s\S]*?)<\/Navimark>/g)].map((match) => match[1]!);
  for (const body of markBodies) {
    const code = tag(body, 'EstNo');
    const lat = Number(tag(body, 'Latitude')) / 60_000_000;
    const lon = Number(tag(body, 'Longitude')) / 60_000_000;
    if (code && Number.isFinite(lat) && Number.isFinite(lon)
      && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) positions.set(code, [lon, lat]);
  }

  const lines = new Map<string, Fairway>();
  for (const body of markBodies) {
    const leadingLines = body.match(/<LeadingLines>([\s\S]*?)<\/LeadingLines>/)?.[1] ?? '';
    for (const match of leadingLines.matchAll(/<LeadingLine>([\s\S]*?)<\/LeadingLine>/g)) {
      const line = match[1]!;
      const name = tag(line, 'LineName');
      const bearing = finite(tag(line, 'Bearing'));
      const start = finite(tag(line, 'FrontFwBegin'));
      const end = finite(tag(line, 'FrontFwEnd'));
      const members = [...line.matchAll(/<LeadingLineAton>([\s\S]*?)<\/LeadingLineAton>/g)]
        .map((member) => ({
          code: tag(member[1]!, 'LdgLnAtonEstNo'),
          order: finite(tag(member[1]!, 'LdgLnAtonOrderNo')),
        }))
        .filter((member): member is { code: string; order: number } => !!member.code && member.order !== undefined)
        .sort((a, b) => a.order - b.order);
      const front = members.find((member) => member.order === 1);
      const rear = members.find((member) => member.order === 2);
      const frontPosition = front ? positions.get(front.code) : undefined;
      const rearPosition = rear ? positions.get(rear.code) : undefined;
      if (!name || bearing === undefined || end === undefined || end <= 0
        || !front || !rear || !frontPosition || !rearPosition) continue;
      const key = `${name}:${front.code}:${rear.code}`;
      lines.set(key, {
        id: `leading-line:nma:${front.code}:${rear.code}`,
        name,
        type: 'leading-line',
        bearingDegrees: bearing,
        workingRangeStartM: start,
        workingRangeEndM: end,
        geometry: {
          type: 'LineString',
          // Registri peiling on merelt sihimärkide suunas. Töötsoon asub
          // alumisest märgist vastupeilingul, sihimärkidest mere pool.
          coordinates: [rearPosition, frontPosition, destination(frontPosition, (bearing + 180) % 360, end)],
        },
      });
    }
  }
  return [...lines.values()];
}

function finite(value: string | undefined): number | undefined {
  const number = Number(value);
  return value !== undefined && Number.isFinite(number) ? number : undefined;
}

function destination([lon, lat]: [number, number], bearing: number, metres: number): [number, number] {
  const radius = 6_371_008.8;
  const distance = metres / radius;
  const angle = bearing * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance)
    + Math.cos(lat1) * Math.sin(distance) * Math.cos(angle));
  const lon2 = lon1 + Math.atan2(
    Math.sin(angle) * Math.sin(distance) * Math.cos(lat1),
    Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

function geometryIntersectsBbox(line: Fairway, [south, west, north, east]: BBox): boolean {
  const coordinates = line.geometry.type === 'LineString'
    ? line.geometry.coordinates
    : line.geometry.coordinates.flat();
  const lons = coordinates.map(([lon]) => lon);
  const lats = coordinates.map(([, lat]) => lat);
  return Math.max(...lons) >= west && Math.min(...lons) <= east
    && Math.max(...lats) >= south && Math.min(...lats) <= north;
}

/** Eksporditud eraldi, et ametliku XML-i kuju saaks võrguta testida. */
export function parseNmaAidIndex(xml: string): NmaAidIndex {
  const index: NmaAidIndex = {};
  for (const match of xml.matchAll(/<Navimark>([\s\S]*?)<\/Navimark>/g)) {
    const body = match[1] ?? '';
    const estNo = tag(body, 'EstNo');
    const typeName = tag(body, 'TypeName');
    if (!estNo || !typeName) continue;
    const colours = tag(body, 'Colours');
    const description = tag(body, 'Description');
    index[estNo] = {
      typeName,
      ...(colours ? { colours } : {}),
      ...(description ? { description } : {}),
    };
  }
  return index;
}

type MarkColour = 'red' | 'green' | 'white' | 'yellow' | 'orange' | 'black' | 'grey';

/**
 * `Colours` on NMA-s eelistatud väli, kuid enamikul tulepaakidel on see tühi
 * ja värv leidub ainult ehitise vabatekstilises kirjelduses.
 */
export function markColoursFromNma(details: NmaAidDetails | undefined): MarkColour[] | undefined {
  if (!details) return undefined;
  const source = details.colours?.trim() || details.description?.trim();
  if (!source) return undefined;
  const normalized = source.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const terms: Array<[string, MarkColour]> = [
    ['puna', 'red'],
    ['rohel', 'green'],
    ['valg', 'white'],
    ['kolla', 'yellow'],
    ['oran', 'orange'],
    ['must', 'black'],
    ['hall', 'grey'],
  ];
  const found = terms.flatMap(([term, colour]) => normalized.includes(term) ? [colour] : []);
  return found.length ? found : undefined;
}

function tag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  const value = match?.[1]?.trim();
  return value ? decodeXml(value) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
