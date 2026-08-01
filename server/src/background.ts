import { aisstream } from './ais/aisstream.js';
import { digitraffic } from './ais/digitraffic.js';
import { vessels } from './ais/registry.js';
import { transpordiamet } from './ais/transpordiamet.js';
import { config } from './config.js';
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

  startAis(log);
}

/**
 * AIS-i taustatööd.
 *
 * Digitraffic on REST ja vajab küsimist; aisstream ning Transpordiamet on
 * WebSocketid ja lükkavad ise. Kõik kirjutavad samasse registrisse, seega ühe
 * kadumine jätab teised tööle.
 */
function startAis(log: Logger): void {
  const pollAis = async (): Promise<void> => {
    try {
      const n = await digitraffic.poll();
      log.info(`AIS Digitraffic: ${n} laeva piirkonnas`);
    } catch (err) {
      log.warn(`AIS Digitraffic ebaõnnestus: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  void pollAis();
  const poll = setInterval(() => void pollAis(), Math.max(30, config.ttl.ais) * 1000);
  poll.unref();
  timers.push(poll);

  // Vananenud positsioonid kustuvad mälust, muidu kasvaks register piiramatult.
  const prune = setInterval(() => vessels.prune(), 5 * 60 * 1000);
  prune.unref();
  timers.push(prune);

  if (aisstream.enabled) {
    aisstream.start((msg) => log.info(msg));
  } else {
    log.info('aisstream on välja lülitatud (AISSTREAM_KEY puudub)');
  }

  transpordiamet.start((msg) => log.info(msg));
}

export function stopBackgroundJobs(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  aisstream.stop();
  transpordiamet.stop();
}
