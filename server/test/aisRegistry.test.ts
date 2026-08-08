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

  it('täidab suunata värske positsiooni teise provideri hiljuti raporteeritud suunaga', () => {
    const registry = new VesselRegistry();
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();

    registry.upsertPosition({
      mmsi: 276123456,
      lat: 59.45,
      lon: 24.58,
      timestamp: newer,
      source: 'transpordiamet',
    });
    // Saabub hiljem, kuid tema AIS-ajatempel on vanem. Positsioon ei tohi
    // tagasi hüpata, samas on kahe minuti sees raporteeritud suund veel kasulik.
    registry.upsertPosition({
      mmsi: 276123456,
      lat: 59.44,
      lon: 24.57,
      cog: 214.5,
      heading: 216,
      timestamp: older,
      source: 'aisstream',
    });

    expect(registry.query([59.4, 24.5, 59.5, 24.7])).toEqual([
      expect.objectContaining({
        lat: 59.45,
        lon: 24.58,
        cog: 214.5,
        heading: 216,
        source: 'transpordiamet',
      }),
    ]);
  });

  it('ei kasuta üle kahe minuti vanust suunda', () => {
    const registry = new VesselRegistry();

    registry.upsertPosition({
      mmsi: 276123456,
      lat: 59.44,
      lon: 24.57,
      cog: 214.5,
      timestamp: new Date(Date.now() - 121_000).toISOString(),
      source: 'aisstream',
    });
    registry.upsertPosition({
      mmsi: 276123456,
      lat: 59.45,
      lon: 24.58,
      timestamp: new Date().toISOString(),
      source: 'transpordiamet',
    });

    expect(registry.query([59.4, 24.5, 59.5, 24.7])[0]).not.toHaveProperty('cog');
  });

  it('ei asenda värskeima positsiooni enda suunda vahemälust', () => {
    const registry = new VesselRegistry();

    registry.upsertPosition({
      mmsi: 276123456,
      lat: 59.44,
      lon: 24.57,
      heading: 90,
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      source: 'aisstream',
    });
    registry.upsertPosition({
      mmsi: 276123456,
      lat: 59.45,
      lon: 24.58,
      cog: 180,
      timestamp: new Date().toISOString(),
      source: 'transpordiamet',
    });

    expect(registry.query([59.4, 24.5, 59.5, 24.7])[0]).toEqual(
      expect.objectContaining({ cog: 180, source: 'transpordiamet' }),
    );
    expect(registry.query([59.4, 24.5, 59.5, 24.7])[0]).not.toHaveProperty('heading');
  });

  it('eelistab seisval laeval teise provideri heading-ut eksitavale COG-ile', () => {
    const registry = new VesselRegistry();

    registry.upsertPosition({
      mmsi: 276415000,
      lat: 59.458277,
      lon: 24.717947,
      sog: 0,
      heading: 213,
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      source: 'digitraffic',
    });
    registry.upsertPosition({
      mmsi: 276415000,
      lat: 59.458277,
      lon: 24.717947,
      sog: 0,
      cog: 5,
      timestamp: new Date().toISOString(),
      source: 'transpordiamet',
    });

    const vessel = registry.query([59.4, 24.5, 59.5, 24.8])[0];
    expect(vessel).toEqual(expect.objectContaining({ heading: 213, sog: 0 }));
    expect(vessel).not.toHaveProperty('cog');
  });

  it('ei väljasta seisva laeva COG-i, kui päris heading puudub', () => {
    const registry = new VesselRegistry();

    registry.upsertPosition({
      mmsi: 276158000,
      lat: 59.458433,
      lon: 24.71715,
      sog: 0.1,
      cog: 37,
      timestamp: new Date().toISOString(),
      source: 'transpordiamet',
    });

    const vessel = registry.query([59.4, 24.5, 59.5, 24.8])[0];
    expect(vessel).not.toHaveProperty('cog');
    expect(vessel).not.toHaveProperty('heading');
  });
});
