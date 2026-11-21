export type RequestPriority = 'foreground' | 'background';

/** Piirab ühe allika poole korraga teel olevaid päringuid. */
export class PriorityGate {
  #active = 0;
  readonly #foreground: Array<() => void> = [];
  readonly #background: Array<() => void> = [];

  constructor(readonly concurrency: number) {}

  async run<T>(priority: RequestPriority, task: () => Promise<T>): Promise<T> {
    await this.#acquire(priority);
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(priority: RequestPriority): Promise<void> {
    if (this.#active < this.concurrency) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      (priority === 'foreground' ? this.#foreground : this.#background).push(resolve);
    });
  }

  #release(): void {
    const next = this.#foreground.shift() ?? this.#background.shift();
    if (next) {
      next();
      return;
    }
    this.#active--;
  }
}
