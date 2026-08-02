const STORAGE_KEY = 'seapro.session.v1';
let memorySessionId: string | null = null;

function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Juhuslik anonüümne installatsiooni/seansi ID kasutusmahu hindamiseks.
 * See ei sisalda IP-d, kasutaja nime ega seadme sõrmejälge.
 */
export function getSessionId(): string {
  if (memorySessionId) return memorySessionId;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      memorySessionId = existing;
      return existing;
    }
    const created = createSessionId();
    localStorage.setItem(STORAGE_KEY, created);
    memorySessionId = created;
    return created;
  } catch {
    // Privaatrežiim või range brauseripoliitika võib localStorage'i keelata.
    // Sellisel juhul jääb ID vähemalt selle lehelaadimise ajaks stabiilseks.
    memorySessionId = createSessionId();
    return memorySessionId;
  }
}
