import { describe, expect, it } from 'vitest';
import {
  chooseNavilyCandidate,
  extractBraveCandidates,
  navilyCandidateScore,
  normalizeNavilyName,
  type NavilySearchCandidate,
} from '../src/navily/scanner.js';

const candidate = (
  title: string,
  slug: string,
  id = 12710,
): NavilySearchCandidate => ({
  title,
  slug,
  id,
  url: `https://www.navily.com/port/${slug}/${id}`,
});

describe('Navily lingiskanner', () => {
  it('normaliseerib täpitähed samamoodi nagu klient', () => {
    expect(normalizeNavilyName('Kakumäe   Jahisadam')).toBe('kakumae jahisadam');
  });

  it('loeb Brave HTML-ist ainult Navily port-tulemused ja eemaldab duplikaadid', () => {
    const html =
      'title:"Marina Pirita Top on Navily",url:"https://www.navily.com/port/pirita-top/12710",' +
      'title:"Pilt",url:"https://www.navily.com/images/pirita.jpg",' +
      'title:"Marina Pirita Top on Navily",url:"https://www.navily.com/port/pirita-top/12710"';
    expect(extractBraveCandidates(html)).toEqual([
      candidate('Marina Pirita Top on Navily', 'pirita-top'),
    ]);
  });

  it('lubab Navily turundusnime lisasõnu', () => {
    expect(navilyCandidateScore('Pirita sadam', candidate('Marina Pirita Top on Navily', 'pirita-top')))
      .toBe(1);
    expect(
      navilyCandidateScore(
        'Kakumäe jahisadam',
        candidate('Marina Haven Kakumäe on Navily', 'haven-kakumae', 13752),
      ),
    ).toBe(1);
  });

  it('ei vali kahe sama tugeva kandidaadi vahel', () => {
    const result = chooseNavilyCandidate('Tallinn sadam', [
      candidate('Port of Tallinn Old City Marina on Navily', 'old-city-marina', 1),
      candidate('Tallinn Olympic Harbour on Navily', 'tallinn-olympic-harbour', 2),
    ]);
    expect(result.candidate).toBeUndefined();
    expect(result.ambiguous).toBe(true);
  });

  it('lükkab nõrga nimevaste tagasi', () => {
    const result = chooseNavilyCandidate('Virtsu sadam', [
      candidate('Marina Kuivastu on Navily', 'kuivastu', 3),
    ]);
    expect(result.candidate).toBeUndefined();
    expect(result.score).toBe(0);
  });
});
