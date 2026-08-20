import { describe, expect, it } from 'vitest';
import { OVERPASS_ENDPOINTS } from '../src/overpass.js';

describe('Overpassi avalikud peeglid', () => {
  it('kasutab Kumi kolimise järel private.coffee aadressi', () => {
    expect(OVERPASS_ENDPOINTS).toContain('https://overpass.private.coffee/api/interpreter');
    expect(OVERPASS_ENDPOINTS)
      .toContain('https://maps.mail.ru/osm/tools/overpass/api/interpreter');
    expect(OVERPASS_ENDPOINTS.some((endpoint) => endpoint.includes('overpass.kumi.systems')))
      .toBe(false);
  });
});
