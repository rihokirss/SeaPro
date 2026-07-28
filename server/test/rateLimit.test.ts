import { describe, expect, it } from 'vitest';
import { RateLimitError, rateLimiter } from '../src/rateLimit.js';

/**
 * Päringueelarve testid.
 *
 * Miks need olemas on: eelarve täitumine ON juhtunud ja tagajärg oli halvim
 * võimalik — server vastas 500-ga, klient neelas selle vaikselt alla ja
 * kasutaja jaoks näis, nagu rakendus lakkas lihtsalt uuenemast. Vea TÜÜP
 * peab olema eristatav, et UI saaks öelda "limiit täis, tuleb X min pärast"
 * mitte "midagi läks valesti".
 */

describe('rateLimiter', () => {
  it('lubab kulutada eelarve piires', () => {
    rateLimiter.register('test-a', 10);
    expect(() => rateLimiter.spend('test-a', 4)).not.toThrow();
    expect(() => rateLimiter.spend('test-a', 6)).not.toThrow();
  });

  it('viskab eristatava vea, kui eelarve saab täis', () => {
    rateLimiter.register('test-b', 5);
    rateLimiter.spend('test-b', 5);

    // Tüüpi on vaja, et UI oskaks seda seisundina, mitte veana kuvada.
    expect(() => rateLimiter.spend('test-b', 1)).toThrow(RateLimitError);
  });

  it('ütleb, millal järgmine aken algab', () => {
    rateLimiter.register('test-c', 1);
    rateLimiter.spend('test-c', 1);

    try {
      rateLimiter.spend('test-c', 1);
      expect.unreachable('oleks pidanud viskama');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const e = err as RateLimitError;
      // Aken järgib täistundi, seega järelejäänud aeg mahub alati tundi.
      expect(e.retryAfterSeconds).toBeGreaterThan(0);
      expect(e.retryAfterSeconds).toBeLessThanOrEqual(3600);
      expect(e.source).toBe('test-c');
    }
  });

  it('keeldub kulutusest, mis ületaks piiri, mitte ei luba osaliselt', () => {
    rateLimiter.register('test-d', 10);
    rateLimiter.spend('test-d', 8);

    // Võrgustikupäring on jagamatu: kas kõik 64 punkti või mitte ühtegi.
    expect(() => rateLimiter.spend('test-d', 5)).toThrow(RateLimitError);
    // Ebaõnnestunud kulutus ei tohi eelarvet vähendada.
    expect(() => rateLimiter.spend('test-d', 2)).not.toThrow();
  });

  it('canSpend ei muuda seisu', () => {
    rateLimiter.register('test-e', 3);
    expect(rateLimiter.canSpend('test-e', 3)).toBe(true);
    expect(rateLimiter.canSpend('test-e', 3)).toBe(true);
    expect(rateLimiter.canSpend('test-e', 4)).toBe(false);
    expect(() => rateLimiter.spend('test-e', 3)).not.toThrow();
  });

  it('peatab ka päevase kvoodi täitumisel, kuigi tunnis oleks ruumi', () => {
    // Open-Meteo lubab 5000 kutset tunnis, aga ainult 10 000 päevas. Ainult
    // tunniarvestus tähendas, et päevane kvoot sai täis paari tunniga ja
    // ülejäänud päev oli 429 — täpselt see, mis rakendust limiiti ajas.
    rateLimiter.register('test-f', 1000, 10);
    rateLimiter.spend('test-f', 10);

    try {
      rateLimiter.spend('test-f', 1);
      expect.unreachable('oleks pidanud viskama');
    } catch (err) {
      const e = err as RateLimitError;
      expect(e).toBeInstanceOf(RateLimitError);
      // UI peab saama öelda, et oodata tuleb kesköö, mitte täistunnini.
      expect(e.window).toBe('day');
      expect(e.retryAfterSeconds).toBeGreaterThan(0);
      expect(e.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    }

    expect(rateLimiter.canSpend('test-f', 1)).toBe(false);
  });

  it('tagastab ebaõnnestunud kulutuse ka päevasest eelarvest', () => {
    rateLimiter.register('test-g', 100, 10);
    rateLimiter.spend('test-g', 10);
    rateLimiter.refund('test-g', 10);

    // Ilma päevase tagastuseta oleks üks katkenud päring kvoodist igaveseks
    // maha võtnud — ka siis, kui vastust ei tulnudki.
    expect(rateLimiter.canSpend('test-g', 10)).toBe(true);
  });

  it('registreerimata allikal pole piirangut', () => {
    expect(() => rateLimiter.spend('tundmatu', 1_000_000)).not.toThrow();
  });
});
