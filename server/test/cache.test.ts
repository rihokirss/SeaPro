import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../src/cache.js';

/**
 * Vahemälu hoolduse testid.
 *
 * Miks need olemas on: `stale` kiht on sihilikult ajatu — see ongi varukoopia,
 * mis peab üle elama allika kadumise. Ajatu tähendas aga ka "ei kustu kunagi":
 * iga kaardinihe lõi uue paanivõtme ja ükski vana ei kadunud. Ainus koristus
 * oli PM2 mälupiirist tulenev taaskäivitus keset kasutamist.
 *
 * Need testid kaitsevad kahte piiri, mis selle lõpetavad — maht ja vanus. Kumbki
 * ei asenda teist: seanss võib jääda mahupiirist allapoole ja hoida ometi
 * eilset prognoosi.
 */

const load = <T>(value: T) => (): Promise<T> => Promise.resolve(value);

/** ~1 MB väärtus, et mahupiir oleks testis mõistliku aja jooksul saavutatav. */
const big = (n: number): string => `${n}`.padEnd(1024 * 1024, 'x');

describe('Cache', () => {
  it('hoiab mälupiiri, tõstes välja kõige ammu kasutatud kirje', async () => {
    const cache = new Cache();

    // 96 MB piir, ~1 MB kirjed: 120 kirjet ei tohi kõik alles jääda.
    for (let i = 0; i < 120; i++) {
      await cache.get(`key-${i}`, 3600, load(big(i)));
    }

    expect(cache.bytes).toBeLessThanOrEqual(96 * 1024 * 1024);
    expect(cache.size).toBeLessThan(120);
    // Viimati kirjutatu peab alles olema — muidu tõstaks vahemälu välja just
    // seda, mida kasutaja parasjagu vaatab.
    expect(cache.peek('key-119')).not.toBeNull();
    expect(cache.peek('key-0')).toBeNull();
  });

  it('loeb kasutamist, mitte kirjutamise järjekorda', async () => {
    const cache = new Cache();
    await cache.get('vana-aga-kasutusel', 3600, load(big(1)));

    for (let i = 0; i < 60; i++) {
      await cache.get(`täide-${i}`, 3600, load(big(i)));
      // Iga vahepealse kirje järel puudutame vana võtit: see on täpselt see
      // muster, mis tekib, kui kasutaja vaatab ühte ala ja kerib ümbrust.
      await cache.get('vana-aga-kasutusel', 3600, load(big(1)));
    }
    for (let i = 60; i < 120; i++) {
      await cache.get(`täide-${i}`, 3600, load(big(i)));
      await cache.get('vana-aga-kasutusel', 3600, load(big(1)));
    }

    expect(cache.peek('vana-aga-kasutusel')).not.toBeNull();
  });

  it('viskab välja kirjed, mis on varukoopiaks liiga vanad', async () => {
    const cache = new Cache();
    vi.useFakeTimers();
    try {
      await cache.get('iidne', 3600, load('b'));

      // Ööpäev edasi: eilne prognoos ei ole enam "veidi vanad andmed", vaid
      // eksitav — ka varukoopiana ei kõlba.
      vi.advanceTimersByTime(25 * 3600 * 1000);
      await cache.get('värske', 3600, load('a'));

      expect(cache.prune()).toBe(1);
      expect(cache.peek('iidne')).toBeNull();
      expect(cache.peek('värske')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arvestus jääb õigeks ka ülekirjutamisel', async () => {
    const cache = new Cache();
    await cache.get('sama', 3600, load(big(1)));
    const after1 = cache.bytes;

    cache.set('sama', 3600, big(2));
    // Sama võti ei tohi mahtu kahekordistada — muidu näitaks arvestus
    // väljatõstmise vajadust seal, kus seda ei ole.
    expect(cache.bytes).toBeCloseTo(after1, -3);
    expect(cache.size).toBe(1);
  });
});
