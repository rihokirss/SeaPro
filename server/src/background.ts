import { listProviders } from './providers/registry.js';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const timers: NodeJS.Timeout[] = [];

/**
 * Taustatööd hoiavad välisallikate vastused mälus soojas.
 *
 * Põhjus: METOC-i portaal vajab 36 jaama kohta 36 eraldi POST-päringut. Kui
 * seda teha brauseri iga avamise peale, tähendaks kümme kasutajat 360 päringut
 * ühele vanale PHP 5.3 serverile. Taustal tõmbame need ÜHE korra intervalli
 * kohta, olenemata kasutajate arvust.
 */
export function startBackgroundJobs(log: Logger): void {
  for (const provider of listProviders()) {
    if (!provider.warm || !provider.caps.enabled) continue;

    const intervalSeconds = provider.warmIntervalSeconds ?? 300;
    const id = provider.caps.id;

    const run = async (): Promise<void> => {
      try {
        await provider.warm!();
      } catch (err) {
        // Allikas maas = ootuspärane. Vahemälu hoiab viimast edukat vastust,
        // seega kasutaja näeb ikka andmeid, ainult vanemaid.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Taustapäring "${id}" ebaõnnestus: ${msg}`);
      }
    };

    void run();
    const timer = setInterval(() => void run(), intervalSeconds * 1000);
    timer.unref();
    timers.push(timer);

    log.info(`Taustapäring "${id}" iga ${intervalSeconds} s`);
  }
}

export function stopBackgroundJobs(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
