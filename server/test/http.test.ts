import { describe, expect, it } from 'vitest';
import { redactUrlSecrets } from '../src/http.js';

describe('HTTP URL-ide saladused', () => {
  it('eemaldab Open-Meteo API võtme veas kasutatavast URL-ist', () => {
    const safe = redactUrlSecrets(
      'https://customer-api.open-meteo.com/v1/forecast?latitude=59.4&apikey=super-secret&hourly=wind_speed_10m',
    );

    expect(safe).not.toContain('super-secret');
    expect(safe).toContain('apikey=%5Bredacted%5D');
    expect(safe).toContain('latitude=59.4');
  });
});
