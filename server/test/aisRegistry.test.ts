import { describe, expect, it } from 'vitest';
import { VesselRegistry } from '../src/ais/registry.js';

describe('AIS VesselRegistry', () => {
  it('liidab sama MMSI metaandmed väljade kaupa eri allikatest', () => {
    const registry = new VesselRegistry();
    const timestamp = new Date().toISOString();

    registry.upsertPosition({
      mmsi: 276123456,
      lat: 59.45,
      lon: 24.58,
      timestamp,
      source: 'transpordiamet',
    });
    registry.upsertMeta(276123456, {
      name: 'TEST BOAT',
      flag: 'EST',
      lengthM: 12,
    });
    registry.upsertMeta(276123456, {
      callSign: 'ES1234',
      destination: 'KAKUMAE',
      draughtM: 1.4,
    });
    // Hilisem puuduv väärtus ei tohi varem saadud nime kustutada.
    registry.upsertMeta(276123456, { name: undefined, imo: 9876543 });

    expect(registry.query([59.4, 24.5, 59.5, 24.7])).toEqual([
      expect.objectContaining({
        mmsi: 276123456,
        source: 'transpordiamet',
        name: 'TEST BOAT',
        flag: 'EST',
        lengthM: 12,
        callSign: 'ES1234',
        destination: 'KAKUMAE',
        draughtM: 1.4,
        imo: 9876543,
      }),
    ]);
  });

  it('hoiab eri provideritest saadud positsioonidest värskeima', () => {
    const registry = new VesselRegistry();
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();

    registry.upsertPosition({
      mmsi: 230123456,
      lat: 59.9,
      lon: 24.9,
      timestamp: newer,
      source: 'digitraffic',
    });
    registry.upsertPosition({
      mmsi: 230123456,
      lat: 58,
      lon: 22,
      timestamp: older,
      source: 'aisstream',
    });

    expect(registry.query([59, 24, 61, 26])).toEqual([
      expect.objectContaining({ lat: 59.9, lon: 24.9, source: 'digitraffic' }),
    ]);
  });
});
