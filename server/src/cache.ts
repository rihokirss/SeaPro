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
  /**
   * Väärtuse ligikaudne suurus baitides (serialiseeritud kujul).
   *
   * Vaja on seda seepärast, et kirjed on VÄGA eri suurusega: jaamamõõtmine on
   * paar kilobaiti, võrepaan nädala andmetega ligi 200 kB. Ainult kirjete arvu
   * piiramine tähendaks, et sama piir hoiab kord 2 MB, kord 200 MB.
   */
  bytes: number;
}

interface Pending<T> {
  promise: Promise<T>;
}

export interface CachedResult<T> {
  value: T;
  /** Kuidas vastus saadi; kasutusmõõdik eristab cache'i ja päris laadimist. */
  cacheOutcome: 'fresh' | 'stale' | 'shared' | 'loaded';
  /** Kas väärtus tuli aegunud varukoopiast (allikas oli kättesaamatu). */
  stale: boolean;
  /** Väärtuse vanus sekundites. */
  ageSeconds: number;
  /** Viga, mille tõttu stale-vastus kasutusele võeti. Ainult jooksva päringu meta. */
  fallbackError?: unknown;
}

/**
 * Kettale kirjutatakse ainult see, mis on väiksem kui see piir (baitides).
 *
 * Nädalane Open-Meteo võrepaan võib üheksa välja ja 16 asukohaga ületada
 * 512 kB. Vana piir jättis seetõttu just kaardipaanid cache.json-ist välja:
 * deploy või PM2 restart kaotas viimased ilmaandmed, kuigi väiksemad kirjed
 * taastati. 2 MB jätab välja päriselt hiiglaslikud vastused, kuid mahutab
 * tavapärase võrepaani.
 */
const MAX_PERSISTED_ENTRY = 2 * 1024 * 1024;

/** Kirjeid vanemad kui see, ei laadita tagasi — need on niikuinii kasutud. */
const MAX_PERSISTED_AGE_MS = 24 * 3600 * 1000;

/**
 * Mälupiir `stale` kihile.
 *
 * Miks see olemas on: `stale` on sihilikult AJATU — see ongi varukoopia, mis
 * peab üle elama allika kadumise. Ajatu tähendas aga ka "kustub alles
 * taaskäivitusel": iga kaardinihe lõi uue paanivõtme ja ükski vana ei kadunud
 * kunagi. Kasutaja, kes mööda Läänemerd ringi kerib, kasvatas protsessi mälu
 * seni, kuni PM2 `max_memory_restart` selle maha võttis — koristus taaskäivituse
 * kaudu, keset kasutamist.
 *
 * 96 MB on valitud paani suuruse järgi: nädala jagu andmeid ühe paani kohta on
 * ~200 kB, seega mahub siia mitusada paani ehk kordades rohkem, kui üks seanss
 * jõuab vaadata. Piiri ületamisel kaob KÕIGE AMMU KASUTATUD kirje — mitte
 * kõige vanem, sest praegu vaadatavat ala hoitakse pidevalt värskena ja see
 * peab alles jääma.
 */
const MAX_MEMORY_BYTES = 96 * 1024 * 1024;

/**
 * Vanuspiir `stale` kirjele.
 *
 * Sama piir mis kettal: üle ööpäeva vana prognoos ei ole enam "veidi vana
 * andmed", vaid eksitav. Varukoopiana ei kõlba, kettale ei lähe — mälus
 * hoidmiseks pole samuti põhjust.
 */
const MAX_STALE_AGE_MS = MAX_PERSISTED_AGE_MS;

/**
 * Vahemälu faili versioon.
 *
 * Tõsta seda, kui MÕNE võtme kuju muutub. Näide, mille peale see sündis:
 * võrgustikupäring läks ühetunniselt aknalt ööpäevasele plokile ja võtmesse
 * läks uus `start_hour`/`end_hour` paar. Vanad kirjed jäid faili alles, ei
 * tabanud enam kunagi ja hoidsid kettal 10 MB — mõõtmise järgi 158 kirjet
 * 159-st.
 */
const CACHE_VERSION = 3;

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../data');
const CACHE_FILE = join(DATA_DIR, 'cache.json');

interface PersistedFile {
  version: number;
  entries: PersistedEntry[];
}

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
  /** `stale` kihi ligikaudne mälukulu baitides. */
  #bytes = 0;

  /**
   * Paneb kirje mõlemasse kihti ja hoiab mälupiiri.
   *
   * KÕIK kirjutamised käivad siit läbi — muidu jääks mõni tee arvestusest
   * välja ja piir oleks olemas ainult paberil.
   */
  #store<T>(key: string, entry: Entry<T>): void {
    const previous = this.#stale.get(key);
    if (previous) this.#bytes -= previous.bytes;

    // `delete` enne `set`-i viib võtme Map-i järjekorras lõppu. Just see teeb
    // järjekorrast kasutusjärjekorra ehk annab meile LRU ilma eraldi
    // andmestruktuurita.
    this.#stale.delete(key);
    this.#stale.set(key, entry);
    this.#fresh.set(key, entry);
    this.#bytes += entry.bytes;

    this.#evict();
  }

  /** Kõige ammu kasutatud kirjed välja, kuni mälupiir on täidetud. */
  #evict(): void {
    if (this.#bytes <= MAX_MEMORY_BYTES) return;
    for (const [key, entry] of this.#stale) {
      this.#stale.delete(key);
      this.#fresh.delete(key);
      this.#bytes -= entry.bytes;
      if (this.#bytes <= MAX_MEMORY_BYTES) break;
    }
  }

  /**
   * Ligikaudne suurus. `JSON.stringify` on siin ainus aus mõõt, mis meil on,
   * ja seda tehakse ainult päris võrgupäringu järel (mitte vahemälutabamusel),
   * seega paar korda minutis — mitte tulises tsüklis.
   */
  #sizeOf(value: unknown): number {
    try {
      return JSON.stringify(value)?.length ?? 0;
    } catch {
      return 0;
    }
  }

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
      // Tabamus viib kirje kasutusjärjekorra lõppu — nii ei tõsteta praegu
      // vaadatavat ala mälupiiri täitumisel välja.
      this.#stale.delete(key);
      this.#stale.set(key, fresh);
      return {
        value: fresh.value,
        cacheOutcome: 'fresh',
        stale: false,
        ageSeconds: (now - fresh.storedAt) / 1000,
      };
    }

    const inFlight = this.#pending.get(key) as Pending<T> | undefined;
    if (inFlight) {
      try {
        const value = await inFlight.promise;
        const entry = this.#fresh.get(key) as Entry<T> | undefined;
        return {
          value,
          cacheOutcome: 'shared',
          stale: false,
          ageSeconds: entry ? (Date.now() - entry.storedAt) / 1000 : 0,
        };
      } catch (err) {
        // Sama loader'it jagav esimene kutsuja jõuab allpool olevasse stale-
        // fallback'i, kuid ootel kutsujad tulid varem siit otse veaga välja.
        // Kaardiklient küsib sama nädalaplokki mitme päeva jaoks paralleelselt,
        // seega kadus limiidi täitumisel osal klientidest kaart ka siis, kui
        // täpselt sama võtme viimane edukas vastus oli olemas.
        const backup = this.#stale.get(key) as Entry<T> | undefined;
        if (backup) {
          this.#stale.delete(key);
          this.#stale.set(key, backup);
          return {
            value: backup.value,
            cacheOutcome: 'stale',
            stale: true,
            ageSeconds: (Date.now() - backup.storedAt) / 1000,
            fallbackError: err,
          };
        }
        throw err;
      }
    }

    const promise = loader()
      .then((value) => {
        const stamp = Date.now();
        this.#store(key, {
          value,
          expiresAt: stamp + ttlSeconds * 1000,
          storedAt: stamp,
          bytes: this.#sizeOf(value),
        });
        this.#dirty = true;
        return value;
      })
      .finally(() => {
        this.#pending.delete(key);
      });

    this.#pending.set(key, { promise });

    try {
      const value = await promise;
      return { value, cacheOutcome: 'loaded', stale: false, ageSeconds: 0 };
    } catch (err) {
      // Allikas kukkus. Kui meil on vana edukas vastus, anname selle.
      const backup = this.#stale.get(key) as Entry<T> | undefined;
      if (backup) {
        // Stale-tabamus on samuti päris kasutus: hoia praegu vaadatav paan
        // LRU-järjekorra lõpus, et täituv cache seda esimesena välja ei viskaks.
        this.#stale.delete(key);
        this.#stale.set(key, backup);
        return {
          value: backup.value,
          cacheOutcome: 'stale',
          stale: true,
          ageSeconds: (Date.now() - backup.storedAt) / 1000,
          fallbackError: err,
        };
      }
      throw err;
    }
  }

  /** Kirjutab väärtuse otse (taustatööde jaoks, mis ise pärivad). */
  set<T>(key: string, ttlSeconds: number, value: T): void {
    const stamp = Date.now();
    this.#store(key, {
      value,
      expiresAt: stamp + ttlSeconds * 1000,
      storedAt: stamp,
      bytes: this.#sizeOf(value),
    });
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
      const parsed = JSON.parse(raw) as PersistedFile | PersistedEntry[];

      // Vana vorming oli paljas massiiv ilma versioonita — see on definitsiooni
      // järgi aegunud kuju ja läheb tervikuna prügikasti.
      if (Array.isArray(parsed) || parsed.version !== CACHE_VERSION) {
        log?.('Vahemälu vorming on muutunud — alustan tühjalt');
        return;
      }

      const entries = parsed.entries;
      const now = Date.now();
      const cutoff = now - MAX_PERSISTED_AGE_MS;
      let loaded = 0;
      let stillFresh = 0;

      for (const e of entries) {
        if (e.storedAt < cutoff) continue;

        const expiresAt = e.expiresAt ?? 0;
        const entry = {
          value: e.value,
          storedAt: e.storedAt,
          expiresAt,
          bytes: this.#sizeOf(e.value),
        };

        this.#stale.set(e.key, entry);
        this.#bytes += entry.bytes;
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

  /**
   * Viskab välja kirjed, mis on liiga vanad, et enam varukoopiaks kõlvata.
   *
   * Mälupiir üksi ei piisaks: seanss võib jääda piirist allapoole ja hoida
   * ometi eilset prognoosi, mida keegi kuvada ei taha. Vanus ja maht on kaks
   * eri probleemi ja vajavad kumbki oma piiri.
   */
  prune(log?: (msg: string) => void): number {
    const cutoff = Date.now() - MAX_STALE_AGE_MS;
    let dropped = 0;
    for (const [key, entry] of this.#stale) {
      if (entry.storedAt >= cutoff) continue;
      this.#stale.delete(key);
      this.#fresh.delete(key);
      this.#bytes -= entry.bytes;
      dropped++;
    }
    if (dropped > 0) log?.(`Vahemälust eemaldatud ${dropped} aegunud kirjet`);
    return dropped;
  }

  /** Kirjutab `stale` kihi kettale. Ohutu kutsuda ka siis, kui midagi ei muutunud. */
  flush(log?: (msg: string) => void): void {
    // Koristus käib kirjutamisega koos: nii ei lähe kettale seda, mis on
    // niikuinii üle vanusepiiri, ja eraldi taimerit pole vaja.
    this.prune(log);
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
      const file: PersistedFile = { version: CACHE_VERSION, entries: out };
      writeFileSync(tmp, JSON.stringify(file), 'utf8');
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
      return {
        value: fresh.value,
        cacheOutcome: 'fresh',
        stale: false,
        ageSeconds: (now - fresh.storedAt) / 1000,
      };
    }
    const backup = this.#stale.get(key) as Entry<T> | undefined;
    if (backup) {
      return {
        value: backup.value,
        cacheOutcome: 'stale',
        stale: true,
        ageSeconds: (now - backup.storedAt) / 1000,
      };
    }
    return null;
  }

  delete(key: string): void {
    const entry = this.#stale.get(key);
    if (entry) this.#bytes -= entry.bytes;
    this.#fresh.delete(key);
    this.#stale.delete(key);
  }

  get size(): number {
    return this.#stale.size;
  }

  /** Ligikaudne mälukulu baitides — `/api/health` näitab seda. */
  get bytes(): number {
    return this.#bytes;
  }
}

export const cache = new Cache();
