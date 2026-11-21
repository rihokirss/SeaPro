type LimitWindow = 'day' | 'hour' | 'minute';

const PERIOD_MS = { day: 86_400_000, hour: 3600_000, minute: 60_000 };
const WINDOWS: LimitWindow[] = ['day', 'hour', 'minute'];

interface Counter {
  limit: number;
  spent: number;
  start: number;
}

interface Budget {
  counters: Record<LimitWindow, Counter>;
  cooldownUntil: number;
  cooldownWindow: LimitWindow;
}

export class RateLimitError extends Error {
  constructor(
    readonly source: string,
    readonly retryAfterSeconds: number,
    readonly window: LimitWindow = 'hour',
    readonly localBudget = false,
  ) {
    super(`Päringulimiit "${source}" on täis, proovi ${retryAfterSeconds} s pärast`);
    this.name = 'RateLimitError';
  }
}

function currentSpent(counter: Counter, window: LimitWindow, now: number): number {
  return now < counter.start + PERIOD_MS[window] ? counter.spent : 0;
}

class RateLimiter {
  #budgets = new Map<string, Budget>();

  register(source: string, hourlyLimit: number, dailyLimit = Infinity, minuteLimit = Infinity): void {
    const counter = (limit: number): Counter => ({ limit, spent: 0, start: 0 });
    this.#budgets.set(source, {
      counters: { day: counter(dailyLimit), hour: counter(hourlyLimit), minute: counter(minuteLimit) },
      cooldownUntil: 0,
      cooldownWindow: 'minute',
    });
  }

  /** Sama rakenduse ühine tasuta kvoot, HTTP 429 ooteaeg kummalgi hostil eraldi. */
  shareBudget(source: string, owner: string): void {
    const budget = this.#budgets.get(owner);
    if (!budget) throw new Error(`Päringueelarve "${owner}" puudub`);
    this.#budgets.set(source, { counters: budget.counters, cooldownUntil: 0, cooldownWindow: 'minute' });
  }

  /** Broneerib kõik aknad korraga enne võrku minekut. */
  spend(source: string, cost = 1, now = Date.now()): void {
    const budget = this.#budgets.get(source);
    if (!budget) return;
    if (now < budget.cooldownUntil) {
      throw new RateLimitError(source, Math.ceil((budget.cooldownUntil - now) / 1000), budget.cooldownWindow);
    }
    for (const window of WINDOWS) {
      const counter = budget.counters[window];
      if (currentSpent(counter, window, now) + cost > counter.limit) {
        const seconds = Math.ceil((PERIOD_MS[window] - now % PERIOD_MS[window]) / 1000);
        throw new RateLimitError(source, seconds, window, true);
      }
    }
    for (const window of WINDOWS) {
      const counter = budget.counters[window];
      counter.spent = currentSpent(counter, window, now) + cost;
      counter.start = now - now % PERIOD_MS[window];
    }
  }

  /** Tagastada saab ainult sama akna broneeringu. */
  refund(source: string, cost = 1, reservedAt = Date.now()): void {
    const budget = this.#budgets.get(source);
    if (!budget) return;
    for (const window of WINDOWS) {
      const counter = budget.counters[window];
      if (reservedAt >= counter.start) counter.spent = Math.max(0, counter.spent - cost);
    }
  }

  cooldown(source: string, seconds: number, window: LimitWindow = 'hour'): void {
    const budget = this.#budgets.get(source);
    const until = Date.now() + seconds * 1000;
    if (budget && until >= budget.cooldownUntil) {
      budget.cooldownUntil = until;
      budget.cooldownWindow = window;
    }
  }

  canSpend(source: string, cost = 1): boolean {
    const budget = this.#budgets.get(source);
    if (!budget) return true;
    const now = Date.now();
    return now >= budget.cooldownUntil && WINDOWS.every((window) => {
      const counter = budget.counters[window];
      return currentSpent(counter, window, now) + cost <= counter.limit;
    });
  }

  stats() {
    const now = Date.now();
    return Object.fromEntries(Array.from(this.#budgets, ([source, { counters, cooldownUntil }]) => [source, {
      spent: currentSpent(counters.hour, 'hour', now), limit: counters.hour.limit,
      dailySpent: currentSpent(counters.day, 'day', now), dailyLimit: counters.day.limit,
      minuteSpent: currentSpent(counters.minute, 'minute', now), minuteLimit: counters.minute.limit,
      cooldownSeconds: Math.max(0, Math.ceil((cooldownUntil - now) / 1000)),
    }]));
  }
}

export const rateLimiter = new RateLimiter();

// Suurim kaardivaade kasutab 512 ühikut. Jätame varu ka Open-Meteo 600/min piirini.
rateLimiter.register('open-meteo', 3000, 8000, 560);
rateLimiter.shareBudget('open-meteo-marine', 'open-meteo');
