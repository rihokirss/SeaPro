import { describe, expect, it } from 'vitest';
import { queryWeight } from '../src/providers/openMeteo.js';

/**
 * Open-Meteo kutsekaalu testid.
 *
 * Miks need olemas on: eelarve pidas varem iga päringut ühe kutseks ja iga
 * võrepunkti samuti ühe kutseks — kumbki ei vastanud allika tegelikule
 * valemile. Tagajärg oli, et päevane kvoot sai täis ilma, et meie oma arvestus
 * seda näeks, ja rakendus istus 429-s.
 *
 * Valem on allika enda koodist (`ForecastApiResult.calculateQueryWeight`):
 *   kaal = max(muutujad/10, muutujad/10 × päevad/14) × asukohad, iga asukoht min 1.
 *
 * Kõige olulisem omadus, mida siin kaitstakse: kuni 10 muutujat ja kuni
 * 14 päeva EI MAKSA rohkem kui üks muutuja ja üks päev. Kogu vahemälustrateegia
 * (terve nädal ja kogu muutujate komplekt korraga) toetub sellele.
 */

describe('queryWeight', () => {
  it('ei võta lisatasu kuni 10 muutuja ja 14 päeva eest', () => {
    expect(queryWeight({ locations: 1, variables: 1, days: 1 })).toBe(1);
    expect(queryWeight({ locations: 1, variables: 9, days: 7 })).toBe(1);
    expect(queryWeight({ locations: 1, variables: 10, days: 14 })).toBe(1);
  });

  it('skaleerub muutujate arvuga üle kümne', () => {
    // Allika enda näide: 2 nädalat × 15 muutujat = 1,5 kutset.
    expect(queryWeight({ locations: 1, variables: 15, days: 14 })).toBe(2); // ceil(1.5)
    // ...ja 4 nädalat sama komplektiga = 3,0.
    expect(queryWeight({ locations: 1, variables: 15, days: 28 })).toBe(3);
  });

  it('loeb iga asukoha eraldi ja vähemalt ühe kutsena', () => {
    // Just see teeb võrgustiku kalliks: 16 punkti = 16 kutset, olenemata
    // sellest, kui vähe andmeid iga punkti kohta küsime.
    expect(queryWeight({ locations: 16, variables: 2, days: 1 })).toBe(16);
    // Sama hind katab terve nädala ja kogu muutujate komplekti.
    expect(queryWeight({ locations: 16, variables: 9, days: 7 })).toBe(16);
  });

  it('korrutab mudelid muutujatega', () => {
    // 9 muutujat × 5 mudelit = 45/10 = 4,5 kutset ühe asukoha kohta.
    expect(queryWeight({ locations: 1, variables: 9, models: 5, days: 11 })).toBe(5); // ceil(4.5)
    expect(queryWeight({ locations: 1, variables: 2, models: 5, days: 11 })).toBe(1);
  });
});
