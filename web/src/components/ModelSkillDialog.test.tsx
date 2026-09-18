// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSkillReport, ModelSkillSeriesReport } from '@seapro/shared';
import { I18nContext, makeTranslate } from '../i18n';
import { api } from '../lib/api';
import { ModelSkillDialog, ModelSkillLauncher } from './ModelSkillDialog';

vi.mock('../lib/api', () => ({
  api: {
    modelSkill: vi.fn(),
    modelSkillSeries: vi.fn(),
    modelSkillWind: vi.fn(),
  },
}));

vi.mock('uplot', () => ({
  default: class {
    setSize() {}
    destroy() {}
  },
}));

const report: ModelSkillReport = {
  generatedAt: '2026-08-20T12:00:00Z',
  collectionStartedAt: '2026-08-19T12:00:00Z',
  lastObservationAt: '2026-08-20T11:00:00Z',
  lastForecastAt: '2026-08-20T09:00:00Z',
  days: 30,
  leadHours: 24,
  pointId: null,
  points: [
    { id: 'tallinnamadal', name: 'Tallinnamadal', country: 'EE', observationProviderId: 'metoc' },
    { id: 'helsinki-harmaja', name: 'Helsinki Harmaja', country: 'FI', observationProviderId: 'fmi' },
  ],
  sources: [],
};

const series: ModelSkillSeriesReport = {
  generatedAt: report.generatedAt,
  days: 30,
  leadHours: 24,
  point: report.points[0]!,
  sources: [],
};

function Wrapper({ children }: { children: React.ReactNode }) {
  return <I18nContext.Provider value={{ lang: 'et', t: makeTranslate('et'), setLang: () => {} }}>{children}</I18nContext.Provider>;
}

describe('mudelitäpsuse modaal', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('annab kompaktse menüürea kaudu avaja elemendi tagasi', async () => {
    const onOpen = vi.fn();
    render(<Wrapper><ModelSkillLauncher onOpen={onOpen} /></Wrapper>);
    await userEvent.click(screen.getByRole('button', { name: /mudelite täpsus/i }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0]?.[0]).toBeInstanceOf(HTMLButtonElement);
  });

  it('laeb tuulevaate eraldi ning mudeli peitmine ei tee uut päringut', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.mocked(api.modelSkill).mockResolvedValue(report);
    vi.mocked(api.modelSkillWind).mockResolvedValue({
      generatedAt: report.generatedAt, days: 30, leadHours: 24, pointId: null,
      sources: [{ sourceId: 'windfinder', label: 'Windfinder' }],
      bins: Array.from({ length: 11 }, (_, index) => ({ from: index * 2, to: index === 10 ? null : index * 2 + 2,
        samples: index === 5 ? 12 : 0, stations: index === 5 ? 1 : 0,
        sources: index === 5 ? [{ sourceId: 'windfinder', mae: 2, bias: -1 }] : [],
      })),
    });
    render(<Wrapper><ModelSkillDialog open onClose={() => {}} /></Wrapper>);
    expect(api.modelSkillWind).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: 'Tuulekiirus' }));
    expect(await screen.findByRole('img', { name: 'Täpsus tuulekiiruse järgi' })).toBeTruthy();
    expect(screen.getByText('2.00 m/s')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Windfinder' }));
    expect(api.modelSkillWind).toHaveBeenCalledTimes(1);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Mõõtepunkt' }), 'helsinki-harmaja');
    await waitFor(() => expect(api.modelSkillWind).toHaveBeenLastCalledWith(30, 24, 'helsinki-harmaja', expect.any(AbortSignal)));
  });

  it('vahetab punktivaates jaama ning sulgub Escape-klahviga', async () => {
    vi.mocked(api.modelSkill).mockResolvedValue(report);
    vi.mocked(api.modelSkillSeries).mockResolvedValue(series);
    const onClose = vi.fn();
    render(<Wrapper><ModelSkillDialog open onClose={onClose} /></Wrapper>);

    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Punktid' }));
    const picker = await screen.findByRole('combobox', { name: /mõõtepunkt/i });
    await userEvent.selectOptions(picker, 'helsinki-harmaja');
    await waitFor(() => expect(api.modelSkill).toHaveBeenCalledWith(30, 24, 'helsinki-harmaja', expect.any(AbortSignal)));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('sulgub ainult modaali taustale, mitte sisule klõpsates', () => {
    vi.mocked(api.modelSkill).mockResolvedValue(report);
    const onClose = vi.fn();
    const { container } = render(<Wrapper><ModelSkillDialog open onClose={onClose} /></Wrapper>);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector('.model-skill-dialog__backdrop')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('selgitab viga ja nihet ning Escape sulgeb esmalt popoveri', async () => {
    vi.mocked(api.modelSkill).mockResolvedValue(report);
    const onClose = vi.fn();
    const { container } = render(<Wrapper><ModelSkillDialog open onClose={onClose} /></Wrapper>);
    await userEvent.click(screen.getByLabelText('Selgita statistilisi näitajaid'));
    expect(screen.getByText('Kuidas näitajaid lugeda?')).toBeTruthy();
    expect(screen.getByText(/vastassuunalised eksimused tasakaalustuvad/)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect((container.querySelector('.model-skill-help') as HTMLDetailsElement).open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
