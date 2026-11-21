// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SearchResult } from '@seapro/shared';
import { api } from '../lib/api';
import { SearchBox } from './SearchBox';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('switches an existing query to vessel search and ignores a late place response', async () => {
  let resolvePlaces!: (data: { results: SearchResult[] }) => void;
  vi.spyOn(api, 'search').mockReturnValue(new Promise(resolve => { resolvePlaces = resolve; }));
  const vessel = { name: 'Test ferry', mmsi: 999000123, stale: true, lat: 59, lon: 24,
    timestamp: '2026-01-01T08:00:00Z', source: 'digitraffic' as const };
  const search = vi.spyOn(api, 'searchVessels').mockResolvedValue({
    results: [{ kind: 'vessel', name: vessel.name, vessel }], historyAvailable: true,
  });
  const onVessel = vi.fn(), onGoTo = vi.fn();
  render(<SearchBox onVessel={onVessel} onGoTo={onGoTo} />);
  fireEvent.change(screen.getByPlaceholderText('Otsi kohta või sadamat…'), { target: { value: 'Test' } });
  fireEvent.submit(screen.getByRole('search'));
  expect(search).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Otsingu liik'), { target: { value: 'vessels' } });
  const hit = await screen.findByRole('option', { name: /Test ferry/ });
  await act(async () => resolvePlaces({ results: [] }));
  fireEvent.click(hit);
  expect(onVessel).toHaveBeenCalledWith(vessel);
  expect(onGoTo).not.toHaveBeenCalled();
  expect(screen.queryByRole('listbox')).toBeNull();
});
