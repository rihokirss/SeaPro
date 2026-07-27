import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Kahekihiline vahemälu, mis püsib ka üle taaskäivituse.
 *
 * Kiht 1 (`fresh`) — värske vastus, kehtib `ttl` sekundit.
 * Kiht 2 (`stale`) — viimane EDUKAS vastus, ei aegu kunagi.
 * Kiht 3 (ketas)   — `stale` kirjutatakse perioodiliselt faili.
 *
 * Teine kiht on siin sihilikult: METOC jookseb PHP 5.3 peal ja LainePoiss on
 * ühe ettevõtte server. Kui allikas on maas, on tunni vanune mõõtmine kaatris
 * kordades kasulikum kui tühi ekraan — kuvame selle koos vanuse hoiatusega.
 *
 * Kolmas kiht lisandus päris probleemi peale: Open-Meteo tasuta kasutus loeb
 * mitmepunktilise päringu iga punkti eraldi kutseks ja arenduses jooksis
 * päringulimiit täis. Ilma kettata algaks iga serveri taaskäivitus tühja
 * vahemäluga ja tõmbaks kõik uuesti.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
  storedAt: number;
}

interface Pending<T> {
  promise: Promise<T>;
}

export interface CachedResult<T> {
  value: T;
  /** Kas väärtus tuli aegunud varukoopiast (allikas oli kättesaamatu). */
  stale: boolean;
  /** Väärtuse vanus sekundites. */
  ageSeconds: number;
}

/** Kettale kirjutatakse ainult see, mis on väiksem kui see piir (baitides). */
const MAX_PERSISTED_ENTRY = 512 * 1024;

/** Kirjeid vanemad kui see, ei laadita tagasi — need on niikuinii kasutud. */
const MAX_PERSISTED_AGE_MS = 24 * 3600 * 1000;

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../data');
const CACHE_FILE = join(DATA_DIR, 'cache.json');

interface PersistedEntry {
  key: string;
  value: unknown;
  storedAt: number;
  /**
   * Millal kirje VÄRSKUS lõppes. Ilma selleta ei saa taaskäivitusel otsustada,
   * kas kirje on veel ajakohane, ja kõik tuleks uuesti tõmmata.
   */
  expiresAt?: number;
}

export class Cache {
  #fresh = new Map<string, Entry<unknown>>();
  #stale = new Map<string, Entry<unknown>>();
  #pending = new Map<string, Pending<unknown>>();
  #dirty = false;
  #flushTimer: NodeJS.Timeout | null = null;

  /**
   * Tagastab vahemälust või kutsub `loader`i.
   *
   * Sama võtmega samaaegsed päringud jagavad ÜHTE `loader` kutset — muidu
   * tekitaks 20 korraga saabuvat brauseripäringut 20 päringut METOC-i vastu.
   */
  async get<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<CachedResult<T>> {
    const now = Date.now();

    const fresh = this.#fresh.get(key) as Entry<T> | undefined;
    if (fresh && fresh.expiresAt > now) {
      return { value: fresh.value, stale: false, ageSeconds: (now - fresh.storedAt) / 1000 };
    }

    const inFlight = this.#pending.get(key) as Pending<T> | undefined;
    if (inFlight) {
      const value = await inFlight.promise;
      const entry = this.#fresh.get(key) as Entry<T> | undefined;
      return {
        value,
        stale: false,
        ageSeconds: entry ? (Date.now() - entry.storedAt) / 1000 : 0,
      };
    }

    const promise = loader()
      .then((value) => {
        const stamp = Date.now();
        const entry: Entry<T> = { value, expiresAt: stamp + ttlSeconds * 1000, storedAt: stamp };
        this.#fresh.set(key, entry);
        this.#stale.set(key, entry);
        this.#dirty = true;
        return value;
      })
      .finally(() => {
        this.#pending.delete(key);
      });

    this.#pending.set(key, { promise });

    try {
      const value = await promise;
      return { value, stale: false, ageSeconds: 0 };
    } catch (err) {
      // Allikas kukkus. Kui meil on vana edukas vastus, anname selle.
      const backup = this.#stale.get(key) as Entry<T> | undefined;
      if (backup) {
        return {
          value: backup.value,
          stale: true,
          ageSeconds: (Date.now() - backup.storedAt) / 1000,
        };
      }
      throw err;
    }
  }

  /** Kirjutab väärtuse otse (taustatööde jaoks, mis ise pärivad). */
  set<T>(key: string, ttlSeconds: number, value: T): void {
    const stamp = Date.now();
    const entry: Entry<T> = { value, expiresAt: stamp + ttlSeconds * 1000, storedAt: stamp };
    this.#fresh.set(key, entry);
    this.#stale.set(key, entry);
    this.#dirty = true;
  }

  /**
   * Laeb eelmise käivituse vahemälu kettalt.
   *
   * Veel KEHTIVAD kirjed lähevad tagasi `fresh`i, aegunud ainult `stale`'i.
   *
   * Varem läks kõik ainult `stale`'i mõttega "pärast taaskäivitust ei tea me,
   * kas andmed on ajakohased". See mõte oli vale: kui kirje TTL pole veel
   * möödas, ongi ta ajakohane — kellaaeg ei sõltu sellest, kas meie protsess
   * vahepeal restarditi. Praktikas tähendas see, et iga deploy või koodimuutus
   * viskas minutivanused andmed minema ja tõmbas kõik uuesti, süües
   * Open-Meteo tunnieelarvet asja eest.
   */
  loadFromDisk(log?: (msg: string) => void): void {
    let raw: string;
    try {
      raw = readFileSync(CACHE_FILE, 'utf8');
    } catch {
      return; // Esimene käivitus — faili polegi.
    }

    try {
      const entries = JSON.parse(raw) as PersistedEntry[];
      const now = Date.now();
      const cutoff = now - MAX_PERSISTED_AGE_MS;
      let loaded = 0;
      let stillFresh = 0;

      for (const e of entries) {
        if (e.storedAt < cutoff) continue;

        const expiresAt = e.expiresAt ?? 0;
        const entry = { value: e.value, storedAt: e.storedAt, expiresAt };

        this.#stale.set(e.key, entry);
        if (expiresAt > now) {
          this.#fresh.set(e.key, entry);
          stillFresh++;
        }
        loaded++;
      }
      log?.(`Vahemälu kettalt: ${loaded} kirjet, neist ${stillFresh} veel värsked`);
    } catch (err) {
      // Rikutud fail ei tohi serverit takistada — alustame tühjalt.
      log?.(`Vahemälu fail on rikutud, alustan tühjalt: ${String(err)}`);
    }
  }

  /** Käivitab perioodilise kettale kirjutamise. */
  startPersisting(intervalSeconds = 120, log?: (msg: string) => void): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setInterval(() => this.flush(log), intervalSeconds * 1000);
    this.#flushTimer.unref();
  }

  stopPersisting(): void {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  /** Kirjutab `stale` kihi kettale. Ohutu kutsuda ka siis, kui midagi ei muutunud. */
  flush(log?: (msg: string) => void): void {
    if (!this.#dirty) return;

    const cutoff = Date.now() - MAX_PERSISTED_AGE_MS;
    const out: PersistedEntry[] = [];

    for (const [key, entry] of this.#stale) {
      if (entry.storedAt < cutoff) continue;
      let serialized: string;
      try {
        serialized = JSON.stringify(entry.value);
      } catch {
        continue; // Mitteserialiseeritav väärtus — jäta vahele.
      }
      // Hoiame faili mõistlikus suuruses: üksikud hiiglaslikud vastused
      // (nt LainePoisi täisajalugu) ei anna taaskäivitusel piisavalt tagasi,
      // et nende kirjutamist õigustada.
      if (serialized.length > MAX_PERSISTED_ENTRY) continue;

      // Värskusaeg tuleb kaasa panna: ilma selleta ei saaks taaskäivitusel
      // eristada minutivanust kirjet tunnivanusest.
      const fresh = this.#fresh.get(key);
      out.push({
        key,
        value: entry.value,
        storedAt: entry.storedAt,
        expiresAt: fresh?.expiresAt ?? 0,
      });
    }

    try {
      mkdirSync(DATA_DIR, { recursive: true });
      // Kirjuta ajutisse faili ja nimeta ümber — nii ei jää poolik fail alles,
      // kui protsess kirjutamise ajal tapetakse.
      const tmp = `${CACHE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), 'utf8');
      renameSync(tmp, CACHE_FILE);
      this.#dirty = false;
      log?.(`Vahemälu kettale: ${out.length} kirjet`);
    } catch (err) {
      log?.(`Vahemälu kettale kirjutamine ebaõnnestus: ${String(err)}`);
    }
  }

  /** Loeb ainult mälust, ilma allikat puutumata. Null = pole üldse midagi. */
  peek<T>(key: string): CachedResult<T> | null {
    const now = Date.now();
    const fresh = this.#fresh.get(key) as Entry<T> | undefined;
    if (fresh && fresh.expiresAt > now) {
      return { value: fresh.value, stale: false, ageSeconds: (now - fresh.storedAt) / 1000 };
    }
    const backup = this.#stale.get(key) as Entry<T> | undefined;
    if (backup) {
      return { value: backup.value, stale: true, ageSeconds: (now - backup.storedAt) / 1000 };
    }
    return null;
  }

  delete(key: string): void {
    this.#fresh.delete(key);
    this.#stale.delete(key);
  }

  get size(): number {
    return this.#stale.size;
  }
}

export const cache = new Cache();
