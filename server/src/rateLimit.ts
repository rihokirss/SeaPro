import { config } from './config.js';

/**
 * Väljaminevate päringute eelarve allika kohta.
 *
 * Miks see olemas on: Open-Meteo tasuta kasutus lubab 5000 kutset tunnis ja
 * loeb mitmepunktilise päringu IGA PUNKTI eraldi kutseks. 64-punktiline
 * võrgustik on seega 64 kutset. Arenduses jooksis limiit täis paari tunniga
 * ja kogu tuulekiht kadus — kasutaja jaoks näeks see välja nagu katkine
 * rakendus, ilma igasuguse vihjeta põhjusest.
 *
 * Eelarve hoiab meid limiidist allpool ISE, enne kui allikas meid blokeerib.
 * Kui eelarve saab otsa, viskame vea kohe (ilma võrgupäringuta) ja vahemälu
 * annab kutsujale viimase eduka vastuse. Nii degradeerub rakendus sujuvalt
 * "veidi vanad andmed" suunas, mitte "andmed puuduvad" suunas.
 */

interface Budget {
  /** Kutseid tunnis, mille me endale lubame. */
  limit: number;
  /**
   * Kutseid ööpäevas, mille me endale lubame.
   *
   * Miks eraldi: Open-Meteo tasuta limiit on 5000 kutset TUNNIS, aga ainult
   * 10 000 kutset PÄEVAS. Ainult tunnieelarve jälgimine tähendas, et päevane
   * kvoot sai täis paari-kolme aktiivse tunniga ja ülejäänud päev oli 429 —
   * täpselt see, mis rakendust pidevalt limiiti ajas.
   */
  dailyLimit: number;
  spent: number;
  dailySpent: number;
  windowStart: number;
  dayStart: number;
  /**
   * Millal allikas ise meid uuesti lubab.
   *
   * Kui allikas vastab 429-ga, on tema arvestus meie omast ees ja edasine
   * pärimine on mõttetu — see ainult koormab teda ja meie eelarvet. Seni
   * lõpetame päringud kohe, ilma võrku puutumata.
   */
  cooldownUntil: number;
  /**
   * Millal tohib jahtumise ajal ÜKS proovipäring läbi lasta.
   *
   * Jäik jahtumine kuni täistunnini eeldab, et allikas taastub täpselt siis.
   * Tegelikkuses võib ta taastuda varem — näiteks kui IP vahetub või limiit
   * käib mõne muu arvestuse järgi. Ilma proovita jääks rakendus istuma ja
   * ütlema "oota", kuigi andmed oleksid juba saadaval.
   */
  probeAfter: number;
}

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Kui tihti tohib jahtumise ajal proovipäringut teha. */
const PROBE_INTERVAL_MS = 60_000;

export class RateLimitError extends Error {
  constructor(
    readonly source: string,
    readonly retryAfterSeconds: number,
    readonly window: 'hour' | 'day' = 'hour',
  ) {
    super(
      `Päringueelarve "${source}" on ${window === 'day' ? 'ööpäevaks' : 'tunniks'} täis, ` +
        `järgmine aken ${retryAfterSeconds} s pärast`,
    );
    this.name = 'RateLimitError';
  }
}

class RateLimiter {
  #budgets = new Map<string, Budget>();

  /**
   * Registreerib allika eelarve.
   *
   * `limit` peaks jääma ALLA allika tegeliku piiri — jätame varu, sest
   * vahemälu ei ole täiuslik ja mitu serveri protsessi võivad jagada sama
   * välist IP-d.
   */
  register(source: string, limit: number, dailyLimit = Infinity): void {
    const now = Date.now();
    this.#budgets.set(source, {
      limit,
      dailyLimit,
      spent: 0,
      dailySpent: 0,
      windowStart: now,
      dayStart: Math.floor(now / DAY_MS) * DAY_MS,
      cooldownUntil: 0,
      probeAfter: 0,
    });
  }

  /**
   * Võtab eelarvest `cost` kutset. Viskab, kui eelarve on täis.
   * Kutsu ENNE päringut, mitte pärast — mõte on päring ära jätta.
   */
  spend(source: string, cost = 1): void {
    const budget = this.#budgets.get(source);
    if (!budget) return; // Registreerimata allikal pole piirangut.

    const now = Date.now();

    // Allikas ütles ise, et aitab — ära puuduta võrku enne, kui aeg möödub.
    // Erand: aeg-ajalt laseme ÜHE proovipäringu läbi, et märgata varasemat
    // taastumist. Õnnestumisel kutsub kutsuja `recovered()` ja jahtumine kaob.
    if (budget.cooldownUntil > now) {
      if (now < budget.probeAfter) {
        throw new RateLimitError(source, Math.ceil((budget.cooldownUntil - now) / 1000));
      }
      budget.probeAfter = now + PROBE_INTERVAL_MS;
    }

    // Aken järgib tegelikku täistundi, sest Open-Meteo lähtestab samamoodi.
    const currentWindow = Math.floor(now / HOUR_MS) * HOUR_MS;
    if (budget.windowStart < currentWindow) {
      budget.windowStart = currentWindow;
      budget.spent = 0;
    }

    // Päevane aken järgib UTC-kesköö, samamoodi nagu allika oma.
    const currentDay = Math.floor(now / DAY_MS) * DAY_MS;
    if (budget.dayStart < currentDay) {
      budget.dayStart = currentDay;
      budget.dailySpent = 0;
    }

    if (budget.dailySpent + cost > budget.dailyLimit) {
      const retryAfter = Math.ceil((currentDay + DAY_MS - now) / 1000);
      throw new RateLimitError(source, retryAfter, 'day');
    }

    if (budget.spent + cost > budget.limit) {
      const retryAfter = Math.ceil((currentWindow + HOUR_MS - now) / 1000);
      throw new RateLimitError(source, retryAfter);
    }

    budget.spent += cost;
    budget.dailySpent += cost;
  }

  /**
   * Tagastab kulutatud eelarve, kui päring EBAÕNNESTUS.
   *
   * Eelarve mõte on hoida meid allika limiidist eemal. Ebaõnnestunud päringu
   * eest tasumine tähendaks, et me piirame end kiiremini ega saa vastu midagi
   * — halvim mõlemast maailmast.
   */
  refund(source: string, cost = 1): void {
    const budget = this.#budgets.get(source);
    if (!budget) return;
    budget.spent = Math.max(0, budget.spent - cost);
    budget.dailySpent = Math.max(0, budget.dailySpent - cost);
  }

  /**
   * Märgib, et allikas ise keeldus (HTTP 429). Peatab päringud kuni aja
   * möödumiseni.
   */
  cooldown(source: string, seconds: number): void {
    const budget = this.#budgets.get(source);
    if (!budget) return;
    const now = Date.now();
    budget.cooldownUntil = Math.max(budget.cooldownUntil, now + seconds * 1000);
    budget.probeAfter = now + PROBE_INTERVAL_MS;
  }

  /** Allikas vastas edukalt — jahtumine pole enam põhjendatud. */
  recovered(source: string): void {
    const budget = this.#budgets.get(source);
    if (!budget || budget.cooldownUntil === 0) return;
    budget.cooldownUntil = 0;
    budget.probeAfter = 0;
  }

  /** Kas eelarves on veel ruumi? Kasulik enne kalli päringu koostamist. */
  canSpend(source: string, cost = 1): boolean {
    const budget = this.#budgets.get(source);
    if (!budget) return true;
    const now = Date.now();

    const currentDay = Math.floor(now / DAY_MS) * DAY_MS;
    const dailySpent = budget.dayStart < currentDay ? 0 : budget.dailySpent;
    if (dailySpent + cost > budget.dailyLimit) return false;

    const currentWindow = Math.floor(now / HOUR_MS) * HOUR_MS;
    if (budget.windowStart < currentWindow) return true;
    return budget.spent + cost <= budget.limit;
  }

  stats(): Record<
    string,
    { spent: number; limit: number; dailySpent: number; dailyLimit: number; cooldownSeconds: number }
  > {
    const out: Record<
      string,
      {
        spent: number;
        limit: number;
        dailySpent: number;
        dailyLimit: number;
        cooldownSeconds: number;
      }
    > = {};
    const now = Date.now();
    for (const [source, b] of this.#budgets) {
      out[source] = {
        spent: b.spent,
        limit: b.limit,
        dailySpent: b.dailySpent,
        dailyLimit: b.dailyLimit,
        cooldownSeconds: b.cooldownUntil > now ? Math.ceil((b.cooldownUntil - now) / 1000) : 0,
      };
    }
    return out;
  }
}

export const rateLimiter = new RateLimiter();

if (!config.openMeteoApiKey) {
  // Open-Meteo tasuta limiidid: 5000 kutset tunnis JA 10 000 kutset ööpäevas.
  // Võtame 3000 ja 8000 — varu jätab ruumi vahemälu möödalaskudele ja hoiab
  // meid allika blokeeringust eemal.
  //
  // Päevane piir on praktikas see, mis maksma jääb: 3000 kutset tunnis lubaks
  // päevase kvoodi ära kulutada nelja tunniga ja ülejäänud 20 tundi oleks 429.
  // Prognoosi- ja mere-API on eri hostid ERALDI kvoodiga, seega eraldi eelarved.
  rateLimiter.register('open-meteo', 3000, 8000);
  rateLimiter.register('open-meteo-marine', 3000, 8000);
}
