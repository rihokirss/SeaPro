import type { FastifyInstance } from 'fastify';

/**
 * Rasterpaanide proxy CORS-ita allikatele.
 *
 * Miks see üldse vajalik on: MapLibre laeb rasterpaane `crossOrigin`-iga,
 * sest WebGL peab pikslitele ligi pääsema, et neist tekstuuri teha. Kui
 * allikas ei saada `Access-Control-Allow-Origin`-it, tõmbab brauser paani
 * ära ja viskab siis minema — kaardil ei ilmu midagi, konsool vaikib ja
 * võrgusakil paistavad päringud edukatena.
 *
 * einavigointiin.fi käitub täpselt nii: `curl` saab paani kätte (curl ei
 * saada `Origin`-it), brauser aga mitte. Mõõdetud: `fetch` -> "Failed to
 * fetch", `mode:'no-cors'` -> opaque, `<img>` ilma crossOrigin-ita -> 256x256,
 * `<img crossOrigin="anonymous">` -> viga. Kihiti tuli 48 paanipäringut ja
 * null pikslit.
 *
 * Sama muster, mida kasutame juba METOC-i ja LainePoisi puhul: allikas käib
 * meie serveri kaudu ja meie lisame päised, mida tema ei anna.
 */

/** Lubatud allikad. Avatud proxy oleks kutse seda meie kaudu kuritarvitada. */
const UPSTREAM: Record<string, string> = {
  'chart-fi': 'https://einavigointiin.fi/map/{z}/{x}/{y}',
};

/** Merekaardid muutuvad harva — nädal on turvaline ja hoiab allika koormust all. */
const MAX_AGE_SECONDS = 7 * 24 * 3600;

/** Ülemine zoom, mida edasi anname. Kaitse lõputu paanipuu vastu. */
const MAX_ZOOM = 20;

export async function registerTileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { source: string; z: string; x: string; y: string } }>(
    '/api/tiles/:source/:z/:x/:y',
    async (req, reply) => {
      const { source, z, x, y } = req.params;
      const template = UPSTREAM[source];
      if (!template) return reply.code(404).send({ error: 'unknown_tile_source', source });

      const zi = Number(z);
      const xi = Number(x);
      const yi = Number(y);
      if (
        !Number.isInteger(zi) ||
        !Number.isInteger(xi) ||
        !Number.isInteger(yi) ||
        zi < 0 ||
        zi > MAX_ZOOM ||
        xi < 0 ||
        yi < 0 ||
        xi >= 2 ** zi ||
        yi >= 2 ** zi
      ) {
        return reply.code(400).send({ error: 'bad_tile_coords' });
      }

      const url = template
        .replace('{z}', String(zi))
        .replace('{x}', String(xi))
        .replace('{y}', String(yi));

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'SeaPro/1.0' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          // 404 on paanikaardil normaalne: allikal lihtsalt pole seal katet.
          // Anname selle edasi nii nagu on, mitte veana — muidu logi ummistub.
          return reply.code(res.status).send();
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return reply
          .header('Content-Type', res.headers.get('content-type') ?? 'image/png')
          .header('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}, immutable`)
          .header('Access-Control-Allow-Origin', '*')
          .send(buf);
      } catch (err) {
        req.log.warn({ err, url }, 'paani proxy ebaõnnestus');
        return reply.code(502).send({ error: 'tile_upstream_failed' });
      }
    },
  );
}
