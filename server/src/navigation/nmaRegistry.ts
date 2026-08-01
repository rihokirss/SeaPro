import { cache } from '../cache.js';
import { fetchText } from '../http.js';

const NMA_XML = 'https://nma.vta.ee/xml_file/';
const REGISTRY_TTL = 24 * 3600;

export interface NmaAidDetails {
  typeName: string;
  colours?: string;
}

export type NmaAidIndex = Record<string, NmaAidDetails>;

/**
 * NMA avalik koondfail uueneb kord ööpäevas. Üks globaalne indekseeritud
 * allalaadimine on nii NMA-le kui meie serverile odavam kui iga kaardimärgi
 * HTML-lehe eraldi küsimine.
 */
export async function fetchNmaAidIndex(): Promise<NmaAidIndex> {
  const { value } = await cache.get('nma:aton-registry:v1', REGISTRY_TTL, async () => {
    const xml = await fetchText(NMA_XML, {
      timeoutMs: 30_000,
      retries: 1,
      headers: { Accept: 'application/xml' },
    });
    return parseNmaAidIndex(xml);
  });
  return value;
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
    index[estNo] = { typeName, ...(colours ? { colours } : {}) };
  }
  return index;
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
