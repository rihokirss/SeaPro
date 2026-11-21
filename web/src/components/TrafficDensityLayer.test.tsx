// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { trafficLat, trafficLon, type TrafficBounds, type TrafficDensity } from '@seapro/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { TrafficDensityLayer } from './TrafficDensityLayer';
import { api } from '../lib/api';
import { I18nContext, makeTranslate } from '../i18n';
import { showTrafficDensity } from '../map/layers/trafficDensity';

vi.mock('../lib/api', () => ({ api: { trafficDensity: vi.fn() } }));
vi.mock('../map/layers/trafficDensity', () => ({ showTrafficDensity: vi.fn(), hideTrafficDensity: vi.fn(), TRAFFIC_COLORS: {} }));
afterEach(cleanup);

it('reuses the pan margin and keeps the map and ranking through a slow or failed request', async () => {
  const map = {} as MapLibreMap;
  const requests = vi.mocked(api.trafficDensity);
  const response: TrafficDensity = { coveredDays: 7, from: null, to: null, factor: 1, cells: [
    { x: 150, y: 100, metres: { cargo: 1852 } }, { x: 205, y: 100, metres: { cargo: 3704 } },
  ] };
  requests.mockResolvedValueOnce(response);
  const view = (left: number) => {
    const bbox: TrafficBounds = [trafficLat(120), trafficLon(left), trafficLat(80), trafficLon(left + 100)];
    return <I18nContext.Provider value={{ lang: 'et', t: makeTranslate('et'), setLang: () => {} }}>
      <TrafficDensityLayer map={map} bbox={bbox} />
    </I18nContext.Provider>;
  };
  const { rerender } = render(view(100));
  const all = () => screen.getByRole('button', { name: /Kõik tüübid/ });
  await screen.findByRole('button', { name: /Kõik tüübid/ });
  expect(all().textContent).toContain('1 NM');
  rerender(view(110));
  expect(requests).toHaveBeenCalledTimes(1);
  expect(all().textContent).toContain('3 NM');
  let rejectRequest!: (error: Error) => void;
  requests.mockReturnValueOnce(new Promise((_, reject) => { rejectRequest = reject; }));
  rerender(view(180));
  expect(requests).toHaveBeenCalledTimes(2);
  expect(all()).toBeTruthy();
  expect(showTrafficDensity).toHaveBeenCalledTimes(1);
  await act(async () => rejectRequest(new Error('offline')));
  expect(all()).toBeTruthy();
  expect(screen.getByRole('status').textContent).toMatch(/ebaõnnestus/);
  requests.mockResolvedValueOnce({ ...response, cells: [] });
  fireEvent.click(screen.getByRole('button', { name: makeTranslate('et')('density.retry') }));
  await screen.findByText(makeTranslate('et')('density.empty'));
  expect(all().textContent).toContain('0 NM');
});
