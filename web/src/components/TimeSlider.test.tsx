// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TimeSlider } from './TimeSlider';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('places sunrise inside the hour cell and updates shading when the map moves', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T06:00:00Z'));
  const props = { value: new Date(), onChange: vi.fn(), pastHours: 0, futureHours: 0 };
  const { container, rerender } = render(<TimeSlider {...props} lat={59.44} lon={24.75} />);
  const cell = container.querySelector<HTMLElement>('.timebar__hour')!;
  // Tallinn sunrise is about 06:15 UTC, three quarters into the 05:30–06:30 cell.
  expect(cell.style.backgroundImage).toContain('var(--timebar-night) 0%');
  expect(cell.style.backgroundImage).toMatch(/7[0-9]\.\d+%/);
  rerender(<TimeSlider {...props} lat={59.44} lon={120} />);
  expect(cell.style.backgroundImage).toBe('');
});
