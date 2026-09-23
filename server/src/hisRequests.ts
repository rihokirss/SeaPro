import { HttpError } from './http.js';

/** HIS-i päringud on staatilised: ära saada paanide kihte korraga teenusesse. */
const MIN_INTERVAL_MS = 1_000;
const FORBIDDEN_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

export class HisRequestGate {
  #tail: Promise<void> = Promise.resolve();
  #nextRequestAt = 0;
  #forbiddenUntil = 0;

  constructor(
    private readonly intervalMs = MIN_INTERVAL_MS,
    private readonly forbiddenCooldownMs = FORBIDDEN_COOLDOWN_MS,
  ) {}

  async run<T>(loader: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.#tail;
    this.#tail = turn;
    await previous;
    try {
      if (Date.now() < this.#forbiddenUntil) {
        throw new Error('HIS-i 403 järel on päringud ajutiselt peatatud');
      }
      const delay = this.#nextRequestAt - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      this.#nextRequestAt = Date.now() + this.intervalMs;
      try {
        return await loader();
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          this.#forbiddenUntil = Date.now() + this.forbiddenCooldownMs;
        }
        throw error;
      }
    } finally {
      release();
    }
  }
}

export const hisRequests = new HisRequestGate();
