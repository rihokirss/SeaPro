import { describe, expect, it, vi } from 'vitest';
import { HisRequestGate } from '../src/hisRequests.js';
import { HttpError } from '../src/http.js';

describe('HIS-i päringupiir', () => {
  it('saadab päringud ükshaaval', async () => {
    const gate = new HisRequestGate(0);
    let finishFirst!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const secondLoader = vi.fn(async () => 'teine');
    const second = gate.run(secondLoader);

    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    expect(secondLoader).not.toHaveBeenCalled();
    finishFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe('teine');
  });

  it('peatab 403 järel järgmised välised päringud', async () => {
    const gate = new HisRequestGate(0, 60_000);
    const loader = vi.fn(async () => { throw new HttpError('HTTP 403 Forbidden', 403, 'https://example.com'); });

    await expect(gate.run(loader)).rejects.toMatchObject({ status: 403 });
    await expect(gate.run(loader)).rejects.toThrow('403 järel');
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
