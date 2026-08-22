import { describe, expect, it } from 'vitest';
import { fetchJson, HttpError, redactUrlSecrets } from '../src/http.js';

describe('HTTP URL-ide saladused', () => {
  it('eemaldab Open-Meteo API võtme veas kasutatavast URL-ist', () => {
    const safe = redactUrlSecrets(
      'https://customer-api.open-meteo.com/v1/forecast?latitude=59.4&apikey=super-secret&hourly=wind_speed_10m',
    );

    expect(safe).not.toContain('super-secret');
    expect(safe).toContain('apikey=%5Bredacted%5D');
    expect(safe).toContain('latitude=59.4');
  });

  it('teisendab 200 OK vigase JSON-i käsitletavaks upstream-veaks', async () => {
    const result = fetchJson('data:application/json,%7B%22latitude%22%3Anan%7D');

    await expect(result).rejects.toMatchObject({
      name: 'HttpError',
      status: 502,
    } satisfies Partial<HttpError>);
  });
});
