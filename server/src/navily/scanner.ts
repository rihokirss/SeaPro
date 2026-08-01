export interface NavilySearchCandidate {
  title: string;
  url: string;
  slug: string;
  id: number;
}

const GENERIC_WORDS = new Set([
  'marina',
  'port',
  'harbour',
  'harbor',
  'sadam',
  'jahisadam',
  'yacht',
  'club',
  'guest',
  'boat',
  'venesatama',
  'satama',
  'vierasvenesatama',
  'vierassatama',
  'gasthamn',
  'besokshamn',
  'hamn',
  'hamnen',
  'brygga',
  'batklubb',
  'segelklubb',
  'pursiseura',
  'venekerho',
  'kausipaikat',
  'oy',
  'ry',
  'on',
  'navily',
]);

/** Sama normaliseerimine, mida klient kasutab sadamanime võtmena. */
export function normalizeNavilyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(name: string): string[] {
  return normalizeNavilyName(name)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && !GENERIC_WORDS.has(word));
}

/** Eemaldab otsingust üldised sadamatüübid, mis võivad Navilys teises keeles
 * või turundusnimega olla. Vaste kontroll kasutab pärast ikkagi algset nime. */
export function navilySearchTerms(name: string): string {
  return tokens(name).join(' ');
}

/**
 * Tavily vastusest loeme ainult Navily kanoonilised port-URL-id. Vastuse
 * sisukokkuvõtteid ega lehe teksti ei talletata.
 */
export function extractTavilyCandidates(payload: unknown): NavilySearchCandidate[] {
  const found = new Map<string, NavilySearchCandidate>();
  if (!payload || typeof payload !== 'object') return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const { title, url: rawUrl } = result as { title?: unknown; url?: unknown };
    if (typeof title !== 'string' || typeof rawUrl !== 'string') continue;
    const match = rawUrl.match(
      /^https:\/\/(?:www\.)?navily\.com\/(?:[a-z]{2}\/)?port\/([a-z0-9-]+)\/(\d+)\/?(?:[?#].*)?$/i,
    );
    if (!match?.[1] || !match[2]) continue;

    const slug = match[1].toLowerCase();
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const url = `https://www.navily.com/port/${slug}/${id}`;
    found.set(url, { title, url, slug, id });
  }

  return [...found.values()];
}

/**
 * Mõõdab, kui täielikult OSM-i eristavad nimetokenid Navily tulemuses
 * esinevad. Navily lisab sageli turundusnime ("Haven Kakumäe", "Pirita Top"),
 * mistõttu kandidaadi lisasõnu ei karistata.
 */
export function navilyCandidateScore(name: string, candidate: NavilySearchCandidate): number {
  const wanted = tokens(name);
  if (wanted.length === 0) return 0;

  const available = new Set([...tokens(candidate.title), ...tokens(candidate.slug)]);
  const matched = wanted.filter((word) => available.has(word)).length;
  return matched / wanted.length;
}

export interface CandidateDecision {
  candidate?: NavilySearchCandidate;
  score: number;
  ambiguous: boolean;
}

/**
 * Automaatne vaste peab katma vähemalt 80% OSM-i eristavast nimest. Kui kaks
 * tulemust on peaaegu võrdsed (nt mitu Tallinna jahisadamat), ei valita
 * kumbagi — vale otselink on halvem kui toimiv koordinaadivaade.
 */
export function chooseNavilyCandidate(
  name: string,
  candidates: NavilySearchCandidate[],
): CandidateDecision {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: navilyCandidateScore(name, candidate) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.8) {
    return { score: best?.score ?? 0, ambiguous: false };
  }

  const second = ranked[1];
  if (second && second.score >= best.score - 0.2) {
    return { score: best.score, ambiguous: true };
  }

  return { candidate: best.candidate, score: best.score, ambiguous: false };
}
