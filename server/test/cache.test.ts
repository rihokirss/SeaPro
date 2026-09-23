import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../src/cache.js';

/**
 * Vahemälu hoolduse testid.
 *
 * Miks need olemas on: dünaamiline `stale` kiht peab allika lühikese katkestuse
 * üle elama, kuid ei tohi eilset ilma lõputult hoida. Aeglaselt muutuva
 * Overpassi ja HIS-i viimane edukas koopia peab seevastu püsima eduka asenduseni.
 *
 * Need testid kaitsevad kahte piiri, mis selle lõpetavad — maht ja vanus. Kumbki
 * ei asenda teist: seanss võib jääda mahupiirist allapoole ja hoida ometi
 * eilset prognoosi.
 */

const load = <T>(value: T) => (): Promise<T> => Promise.resolve(value);

/** ~1 MB väärtus, et mahupiir oleks testis mõistliku aja jooksul saavutatav. */
const big = (n: number): string => `${n}`.padEnd(1024 * 1024, 'x');

describe('Cache', () => {
  it('lubab productionu routingukihi jaoks mahupiiri seadistada', async () => {
    const cache = new Cache({ maxMemoryBytes: 3 * 1024 * 1024 });
    for (let i = 0; i < 5; i++) await cache.get(`custom-${i}`, 3600, load(big(i)));

    expect(cache.bytes).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(cache.peek('custom-4')).not.toBeNull();
    expect(cache.peek('custom-0')).toBeNull();
  });

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

  it('säilitab üle ööpäeva vana kirje, kui selle pikem TTL veel kehtib', async () => {
    const cache = new Cache();
    vi.useFakeTimers();
    try {
      await cache.get('nädalane-staatika', 7 * 24 * 3600, load('route'));
      vi.advanceTimersByTime(25 * 3600 * 1000);

      expect(cache.prune()).toBe(0);
      expect(cache.peek('nädalane-staatika')).toMatchObject({ stale: false, value: 'route' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'routing:openstreetmap-overpass:v3:59,24,60,25',
    'routing:transpordiamet-his:v2:59,24,60,25',
  ])('säilitab aegunud staatilise paani kuni eduka asenduseni: %s', async (key) => {
    const cache = new Cache({ maxMemoryBytes: 1024 });
    vi.useFakeTimers();
    try {
      await cache.get(key, 3600, load('viimane edukas paan'));
      vi.advanceTimersByTime(30 * 24 * 3600 * 1000);

      expect(cache.prune()).toBe(0);
      // Püsiv koopia jääb alles ka tavalisest mälupiirist kõrgemal.
      await cache.get('tavaline', 3600, load(big(1)));
      expect(cache.peek(key)).toMatchObject({ stale: true, value: 'viimane edukas paan' });
      const failingLoader = vi.fn(() => Promise.reject(new Error('Allikas maas')));
      const failed = await cache.get(key, 3600, failingLoader);
      expect(failed).toMatchObject({ stale: true, value: 'viimane edukas paan' });
      expect(failingLoader).toHaveBeenCalledOnce();
      await Promise.resolve();
      await Promise.resolve();
      const refreshed = await cache.get(key, 3600, load('uus paan'));
      expect(refreshed).toMatchObject({ stale: true, value: 'viimane edukas paan' });
      await Promise.resolve();
      expect(cache.peek(key)).toMatchObject({ stale: false, value: 'uus paan' });
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

  it('annab loaderi vea korral stale-vastuse ka paralleelsetele ootajatele', async () => {
    const cache = new Cache();
    await cache.get('ühine', 0, load('viimane edukas vastus'));

    let rejectLoader!: (reason: Error) => void;
    const failingLoader = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectLoader = reject;
        }),
    );

    const first = cache.get('ühine', 60, failingLoader);
    const waiting = cache.get('ühine', 60, failingLoader);
    rejectLoader(new Error('Open-Meteo limiit'));

    const [a, b] = await Promise.all([first, waiting]);
    expect(a).toMatchObject({ value: 'viimane edukas vastus', stale: true });
    expect(b).toMatchObject({ value: 'viimane edukas vastus', stale: true });
    expect(a.fallbackError).toBeInstanceOf(Error);
    expect(b.fallbackError).toBeInstanceOf(Error);
    expect(failingLoader).toHaveBeenCalledTimes(1);
  });
});
