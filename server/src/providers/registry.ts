import type { ProviderCapabilities } from '@seapro/shared';
import type { WeatherProvider } from './types.js';
import { openMeteo } from './openMeteo.js';
import { metNo } from './metNo.js';
import { metoc } from './metocTaltech.js';
import { lainepoiss } from './lainepoiss.js';
import { ilmateenistus } from './ilmateenistus.js';
import { windfinder } from './windfinder.js';

/**
 * Kõik providerid ühes kohas. Uue allika lisamine = üks rida siia.
 * Järjekord määrab UI vaikimisi järjestuse — prognoosid enne, mõõtmised pärast.
 */
const ALL: WeatherProvider[] = [openMeteo, metNo, windfinder, metoc, lainepoiss, ilmateenistus];

const byId = new Map<string, WeatherProvider>(ALL.map((p) => [p.caps.id, p]));

export function getProvider(id: string): WeatherProvider | undefined {
  return byId.get(id);
}

export function listProviders(): WeatherProvider[] {
  return ALL;
}

export function listCapabilities(): ProviderCapabilities[] {
  return ALL.map((p) => p.caps);
}

/** Providerid, mis on tegelikult kasutatavad (nt aisstream ilma võtmeta ei ole). */
export function enabledProviders(): WeatherProvider[] {
  return ALL.filter((p) => p.caps.enabled);
}

/**
 * Kas provider katab selle punkti? METOC ja LainePoiss on Eesti-kesksed;
 * pole mõtet neilt Norra ranniku kohta küsida.
 */
export function coversPoint(p: WeatherProvider, lat: number, lon: number): boolean {
  const b = p.caps.bbox;
  if (!b) return true;
  const [south, west, north, east] = b;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}
