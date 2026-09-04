import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from '../src/http.js';
import { fetchOfficialNavigation } from '../src/navigation/arcgis.js';
import { NavigationSnapshots, navigationSnapshots } from '../src/navigation/snapshots.js';
import { registerApiRoutes } from '../src/routes/api.js';

const xml = `<SOAP-ENV:Envelope><Navimarks>
  <Navimark><Name>Narva-Jõesuu tuletorn</Name><EstNo>001</EstNo><TypeName>Tuletorn</TypeName>
    <Latitude>3568086370</Latitude><Longitude>1682421960</Longitude></Navimark>
  <Navimark><Name>Testi alumine märk</Name><EstNo>002</EstNo><TypeName>Tulepaak, sihi alumine</TypeName>
    <Latitude>3540000000</Latitude><Longitude>1440000000</Longitude>
    <LeadingLines><LeadingLine><LineName>Testi siht</LineName><Bearing>180</Bearing><FrontFwBegin>100</FrontFwBegin><FrontFwEnd>1000</FrontFwEnd>
      <LeadingLineAtoNs><LeadingLineAton><LdgLnAtonEstNo>002</LdgLnAtonEstNo><LdgLnAtonOrderNo>1</LdgLnAtonOrderNo></LeadingLineAton>
      <LeadingLineAton><LdgLnAtonEstNo>003</LdgLnAtonEstNo><LdgLnAtonOrderNo>2</LdgLnAtonOrderNo></LeadingLineAton></LeadingLineAtoNs>
    </LeadingLine></LeadingLines></Navimark>
  <Navimark><Name>Testi ülemine märk</Name><EstNo>003</EstNo><TypeName>Tulepaak, sihi ülemine</TypeName>
    <Latitude>3540060000</Latitude><Longitude>1440000000</Longitude></Navimark>
  </Navimarks></SOAP-ENV:Envelope>`;

describe('Eesti navigatsioonimärkide varuallikas', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'seapro-nma-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    const store = new NavigationSnapshots(directory);
    vi.spyOn(navigationSnapshots, 'get').mockImplementation(store.get.bind(store));
    vi.spyOn(http, 'fetchJson').mockRejectedValue(new Error('403 Forbidden'));
    vi.spyOn(http, 'fetchText').mockResolvedValue(xml);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it('annab API-s XML-i märgid ja märgib puuduva laevateede kihi veaks', async () => {
    const app = Fastify();
    await registerApiRoutes(app);
    try {
      // Alla Soome teenuse lõunapiiri, et kontrollida ainult Eesti varuallikat.
      const response = await app.inject('/api/navigation?bbox=58.9,23.9,59.1,24.1&include=official');
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toEqual(['official']);
      expect(body.aids).toHaveLength(2);
      expect(body.aids[0]).toMatchObject({ id: 'aton:nma:002', lat: 59, lon: 24, registryStale: false });
      expect(body.fairways).toHaveLength(1);
      expect(body.fairways[0]).toMatchObject({ id: 'leading-line:nma:002:003', name: 'Testi siht' });
    } finally {
      await app.close();
    }
  });

  it('kasutab pärast restarti ja mõlema allika kadumist täiskoopiat ka uues kaardialas', async () => {
    const initial = await fetchOfficialNavigation([58.9, 23.9, 59.1, 24.1]);
    expect(initial.aids.map((aid) => aid.atonCode)).toEqual(['002', '003']);
    const fetchedAt = initial.aids[0]!.registryFetchedAt;
    vi.setSystemTime(Date.now() + 90 * 86_400_000);
    const restarted = new NavigationSnapshots(directory);
    vi.mocked(navigationSnapshots.get).mockImplementation(restarted.get.bind(restarted));
    vi.mocked(http.fetchText).mockRejectedValue(new Error('NMA offline'));
    const result = await fetchOfficialNavigation([59.4, 28, 59.5, 28.1]);
    expect(result.aids).toHaveLength(1);
    expect(result.aids[0]).toMatchObject({
      atonCode: '001', registryFetchedAt: fetchedAt, registryStale: true,
    });
  });

  it('ei salvesta katkist XML-i eduka tühja registrina', async () => {
    vi.mocked(http.fetchText).mockResolvedValue(xml.replace('</SOAP-ENV:Envelope>', ''));
    await expect(fetchOfficialNavigation([58, 22, 60, 29])).rejects.toThrow('vastus on vigane');
  });
});
