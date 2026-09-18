import { describe, expect, it } from 'vitest';
import { decodeDigitrafficMqtt } from '../src/ais/digitraffic.js';

describe('Digitraffic MQTT', () => {
  it('decodes a location topic and AIS sentinel values', () => {
    const event = decodeDigitrafficMqtt('vessels-v2/230123456/location', JSON.stringify({
      time: 1_700_000_000,
      lat: 60.1,
      lon: 24.9,
      sog: 102.2,
      cog: 360,
      heading: 511,
      navStat: 5,
    }));

    expect(event).toEqual({
      kind: 'position',
      value: {
        mmsi: 230123456,
        lat: 60.1,
        lon: 24.9,
        sog: undefined,
        cog: undefined,
        heading: undefined,
        navStat: 5,
        timestamp: '2023-11-14T22:13:20.000Z',
        source: 'digitraffic',
      },
    });
  });

  it('decodes metadata dimensions and draught', () => {
    const event = decodeDigitrafficMqtt('vessels-v2/230123456/metadata', JSON.stringify({
      timestamp: 1_700_000_000_000,
      name: ' TEST SHIP ',
      callSign: ' OJ1234 ',
      type: 70,
      draught: 54,
      refA: 100,
      refB: 20,
      refC: 8,
      refD: 7,
    }));

    expect(event).toEqual({
      kind: 'metadata',
      value: {
        mmsi: 230123456,
        value: expect.objectContaining({
          name: 'TEST SHIP',
          callSign: 'OJ1234',
          shipType: 70,
          draughtM: 5.4,
          lengthM: 120,
          beamM: 15,
          toBow: 100,
          toStern: 20,
          toPort: 8,
          toStarboard: 7,
        }),
      },
    });
  });

  it('ignores status and malformed vessel topics', () => {
    expect(decodeDigitrafficMqtt('vessels-v2/status', '{}')).toBeNull();
    expect(decodeDigitrafficMqtt('vessels-v2/not-an-mmsi/location', '{}')).toBeNull();
  });
});
