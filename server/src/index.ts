import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { cache } from './cache.js';
import { config, warnAboutConfig } from './config.js';
import { registerApiRoutes } from './routes/api.js';
import { startBackgroundJobs, stopBackgroundJobs } from './background.js';
import { usageMeter } from './usage.js';

const here = dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport:
      config.nodeEnv === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  },
  // Kaatris on ühendus aeglane; ära katkesta päringut liiga vara.
  requestTimeout: 60_000,
});

usageMeter.loadFromDisk((msg) => app.log.info(msg));
usageMeter.startPersisting(60, (msg) => app.log.debug(msg));

// Brauser saadab juhusliku anonüümse seansi-ID. Loeme ainult API-päringuid;
// staatilised failid ja aluskaardi rasterpaanid ei paisuta kasutajanumbrit.
app.addHook('onRequest', async (req) => {
  if (!req.url.startsWith('/api/')) return;
  const raw = req.headers['x-seapro-session'];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;
  usageMeter.recordApiRequest(sessionId);
});

await registerApiRoutes(app);

// Frontend. Arenduses serveerib seda Vite (:5173) ja siit ei tule midagi —
// toodangus on web/dist olemas ja server annab selle ise välja.
const webDist = resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    index: ['index.html'],
    setHeaders(response, pathName) {
      // PMTilesi paane loetakse sama faili eri byte-range'idena. Lühike
      // brauserivahemälu väldib ühe kaardiseansi jooksul samade lõikude
      // korduvat allalaadimist, aga lubab andmefaili ühe päevaga uuendada.
      if (pathName.endsWith('.pmtiles')) {
        response.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      }
    },
  });

  // SPA fallback: iga tundmatu tee, mis pole /api, saab index.html-i.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Tundmatu API otspunkt' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.info(`Frontendi ehitust pole (${webDist}) — arendusrežiimis kasuta Vite'i :5173`);
}

warnAboutConfig((msg) => app.log.warn(msg));

// Eelmise käivituse vastused varukoopiaks; hoiab välispäringute arvu madalal
// ja annab kohe midagi näidata, kui mõni allikas on parasjagu maas.
cache.loadFromDisk((msg) => app.log.info(msg));
cache.startPersisting(120, (msg) => app.log.debug(msg));

if (config.backgroundPoll) {
  startBackgroundJobs(app.log);
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} — sulgen`);
  stopBackgroundJobs();
  // Kirjuta vahemälu kettale enne väljumist, et taaskäivitus algaks soojalt.
  cache.stopPersisting();
  cache.flush((msg) => app.log.info(msg));
  usageMeter.stopPersisting();
  usageMeter.flush((msg) => app.log.info(msg));
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
