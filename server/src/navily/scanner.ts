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

/**
 * Brave'i HTML sisaldab serveri renderdatud otsingutulemusi JavaScripti
 * andmeobjektina. Loeme ainult Navily kanoonilise port-URL-i kõrval oleva
 * pealkirja; reklaami-, pildi- ja profiililingid jäävad välja.
 */
export function extractBraveCandidates(html: string): NavilySearchCandidate[] {
  const found = new Map<string, NavilySearchCandidate>();
  const result =
    /title:"((?:\\.|[^"])*)",url:"(https:\/\/www\.navily\.com\/port\/([a-z0-9-]+)\/(\d+))"/g;

  for (const match of html.matchAll(result)) {
    const [, encodedTitle, url, slug, rawId] = match;
    if (!encodedTitle || !url || !slug || !rawId) continue;

    let title: string;
    try {
      title = JSON.parse(`"${encodedTitle}"`) as string;
    } catch {
      continue;
    }

    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
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
