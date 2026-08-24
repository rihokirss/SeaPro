import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleAfterCompletion } from '../src/background.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('taustatöö ajastus', () => {
  it('ootab intervalli eelmise ringi lõpust, mitte algusest', async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const task = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);

    const stop = scheduleAfterCompletion(task, 300_000);
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(task).toHaveBeenCalledTimes(1);

    finishFirst();
    await first;
    await vi.advanceTimersByTimeAsync(299_999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ei planeeri uut ringi, kui töö peatati poolelioleva päringu ajal', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const task = vi.fn(() => pending);

    const stop = scheduleAfterCompletion(task, 1_000);
    stop();
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(task).toHaveBeenCalledTimes(1);
  });
});
