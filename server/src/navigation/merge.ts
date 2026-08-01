import type { Harbour, NavigationAid } from '@seapro/shared';

/** Ühendab AIS AToN-i ametliku märgiga, kui koordinaadid langevad praktiliselt kokku. */
export function mergeNavigationAids(
  official: NavigationAid[],
  live: NavigationAid[],
): NavigationAid[] {
  const out = official.map((aid) => ({ ...aid, sources: [...aid.sources] }));

  for (const incoming of live) {
    // Virtuaalsel märgil ei pruugi füüsilist vastet olla; seda ei tohi lähima
    // poi külge liita isegi juhul, kui koordinaadid on samad.
    const matchIndex = incoming.virtual
      ? -1
      : out.findIndex((aid) => distanceMetres(aid, incoming) <= 40);
    if (matchIndex < 0) {
      out.push(incoming);
      continue;
    }

    const base = out[matchIndex]!;
    out[matchIndex] = {
      ...base,
      name: incoming.name || base.name,
      category: incoming.category && incoming.category !== 'unknown'
        ? incoming.category
        : base.category,
      atonType: incoming.atonType ?? base.atonType,
      status: incoming.status ?? base.status,
      offPosition: incoming.offPosition ?? base.offPosition,
      mmsi: incoming.mmsi ?? base.mmsi,
      updatedAt: incoming.updatedAt ?? base.updatedAt,
      sources: ['registry', 'ais'],
    };
  }
  return out;
}

/**
 * Ametlik sadamaregister rikastab OSM-i, mitte ei tekita teist markerit.
 * LOCODE on parim võti; selle puudumisel kasutame nime ja lõpuks väga väikest
 * asukohahälvet, sest registrite koordinaadid pole pikslitäpsusega samad.
 */
export function mergeHarbours(osm: Harbour[], official: Harbour[]): Harbour[] {
  const out: Harbour[] = osm.map((harbour) => ({
    ...harbour,
    sources: harbour.sources ?? ['osm'],
  }));

  for (const incoming of official) {
    const matchIndex = out.findIndex((harbour) => {
      if (harbour.kind !== 'harbour') return false;
      if (harbour.locode && incoming.locode) {
        // Nutimeri kirjutab LOCODE'i kujul "EE RST", OSM tavaliselt
        // "EERST". Tühikud ja kirjavahemärgid ei kuulu identifikaatorisse.
        if (normalizeLocode(harbour.locode) === normalizeLocode(incoming.locode)) {
          return true;
        }
      }
      const nearby = distanceMetres(harbour, incoming);
      const sameName = normalizeName(harbour.name) === normalizeName(incoming.name);
      return (sameName && nearby <= 1500) || nearby <= 120;
    });

    if (matchIndex < 0) {
      out.push(incoming);
      continue;
    }

    const base = out[matchIndex]!;
    out[matchIndex] = {
      ...incoming,
      ...base,
      officialId: incoming.officialId,
      name: base.name || incoming.name,
      maxDraught: base.maxDraught ?? incoming.maxDraught,
      registryUrl: base.registryUrl ?? incoming.registryUrl,
      locode: base.locode ?? incoming.locode,
      category: base.category ?? incoming.category,
      sources: ['osm', 'transpordiamet'],
    };
  }
  return out;
}

function normalizeLocode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(sadam|harbour|harbor|marina)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function distanceMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos(lat);
  return Math.hypot(dx, dy);
}
