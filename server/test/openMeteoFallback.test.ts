import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/http.js';
import { OpenMeteoEndpointPolicy } from '../src/providers/openMeteo.js';

function httpError(status: number): HttpError {
  return new HttpError(`HTTP ${status}`, status, 'https://example.test');
}

describe('OpenMeteoEndpointPolicy', () => {
  it('kasutab võtmega kommertsendpointi ja lisab võtme ainult sinna', () => {
    const policy = new OpenMeteoEndpointPolicy('test-key');
    const params = new URLSearchParams({ latitude: '59' });

    expect(policy.mode()).toBe('commercial');
    expect(policy.endpoint('forecast')).toBe('https://customer-api.open-meteo.com/v1/forecast');
    expect(policy.requestUrl('forecast', params)).toContain('apikey=test-key');
    expect(params.has('apikey')).toBe(false);
  });

  it.each([401, 402, 403])(
    'lülitub ligipääsuvea %i järel püsivalt tasuta endpointi',
    (status) => {
      const policy = new OpenMeteoEndpointPolicy('test-key');
      const attempted = policy.endpoint('marine');

      expect(policy.activateFreeFallback('marine', attempted, httpError(status))).toBe('activated');
      expect(policy.mode()).toBe('free-fallback');
      expect(policy.endpoint('marine')).toBe('https://marine-api.open-meteo.com/v1/marine');
      expect(policy.requestUrl('marine', new URLSearchParams())).not.toContain('apikey=');

      // Juba teele läinud samaaegne kliendipäring võib samuti tasuta API-st
      // vastuse lõpuni võtta, aga uut režiimivahetust ega logirida ei tekita.
      expect(policy.activateFreeFallback('marine', attempted, httpError(status))).toBe(
        'already-active',
      );
    },
  );

  it.each([400, 429, 500])('ei vaheta ajutise või päringuvea %i tõttu režiimi', (status) => {
    const policy = new OpenMeteoEndpointPolicy('test-key');
    const attempted = policy.endpoint('forecast');

    expect(policy.activateFreeFallback('forecast', attempted, httpError(status))).toBe(false);
    expect(policy.mode()).toBe('commercial');
  });

  it('kasutab võtmeta kohe tasuta endpointi', () => {
    const policy = new OpenMeteoEndpointPolicy('');

    expect(policy.mode()).toBe('free');
    expect(policy.endpoint('forecast')).toBe('https://api.open-meteo.com/v1/forecast');
  });
});
