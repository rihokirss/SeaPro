import { config } from './config.js';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    /**
     * Vastuse keha 429 korral. Allikad ütlevad just siin, KUMMA limiidi vastu
     * jooksti — Open-Meteo eristab tunni- ja päevalimiiti ning ainult keha
     * põhjal saab valida õige ooteaja. Ilma selleta ootaks päevalimiidi puhul
     * järgmise täistunnini ja prooviks siis terve päeva asjatult edasi.
     */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface FetchOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  /** POST keha, `application/x-www-form-urlencoded`-ina (METOC ootab just seda). */
  form?: Record<string, string>;
  timeoutMs?: number;
  /** Mitu korda proovida uuesti võrgu/5xx vea korral. Vaikimisi 2. */
  retries?: number;
}

const DEFAULT_TIMEOUT = 15_000;

/** Eemaldab saladused URL-ist enne, kui URL veasse või logisse jõuab. */
export function redactUrlSecrets(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.searchParams.has('apikey')) url.searchParams.set('apikey', '[redacted]');
    return url.toString();
  } catch {
    return raw.replace(/([?&]apikey=)[^&\s]*/gi, '$1[redacted]');
  }
}

/**
 * Ühine väljaminev HTTP-klient.
 *
 * Kõik allikapäringud käivad siit läbi, et User-Agent oleks ühtne ja
 * tuvastatav — met.no ToS nõuab seda ja vastab anonüümsele päringule 403-ga.
 */
export async function request(url: string, opts: FetchOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  let lastError: unknown;
  const safeUrl = redactUrlSecrets(url);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'User-Agent': config.userAgent,
        // Digitraffic vastab 406-ga, kui gzip pole lubatud. Undici seab selle
        // ise, aga kirjutame välja, et see nõue oleks koodist nähtav.
        'Accept-Encoding': 'gzip, deflate',
        ...opts.headers,
      };

      let body: string | undefined;
      if (opts.form) {
        body = new URLSearchParams(opts.form).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const res = await fetch(url, {
        method: opts.method ?? (opts.form ? 'POST' : 'GET'),
        headers,
        body,
        signal: controller.signal,
        redirect: 'follow',
      });

      // 429 = oleme allikat üle koormanud. Kordamine teeb ainult hullemaks;
      // vahemälu annab kutsujale viimase eduka vastuse.
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const body = await res.text().catch(() => '');
        throw new HttpError(
          `Päringulimiit ületatud (429)${retryAfter ? `, proovi ${retryAfter} s pärast` : ''}` +
            (body ? `: ${body.slice(0, 200)}` : ''),
          429,
          safeUrl,
          body,
        );
      }

      // 4xx on püsiv viga — kordamine ei aita ja koormab allikat asjatult.
      if (!res.ok && res.status < 500) {
        throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, safeUrl);
      }
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, safeUrl);
      }

      return res;
    } catch (err) {
      lastError = err;

      if (err instanceof HttpError && err.status < 500) throw err;
      if (attempt === retries) break;

      // Eksponentsiaalne ootamine: 400 ms, 800 ms.
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new HttpError(`Päring ebaõnnestus (${retries + 1} katset): ${reason}`, 0, safeUrl);
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await request(url, opts);
  return await res.text();
}
