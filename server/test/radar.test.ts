import { describe, expect, it } from 'vitest';
import { parseRadarTimeline } from '../src/radar.js';

const layer = (name: string, times: string) => `
  <Layer queryable="1">
    <Name>${name}</Name>
    <Title>${name}</Title>
    <Dimension name="time" default="2026-08-02T12:00:00Z" units="ISO8601">${times}</Dimension>
  </Layer>`;

describe('radari WMS ajajoon', () => {
  it('eristab vaatlused tuleviku nowcast-kaadritest', () => {
    const xml = `<WMS_Capabilities><Layer>
      ${layer('cmp_cap', '2026-08-02T11:55:00Z,2026-08-02T12:00:00Z')}
      ${layer('nowcasting', '2026-08-02T12:00:00Z,2026-08-02T12:05:00Z,2026-08-02T13:30:00Z')}
    </Layer></WMS_Capabilities>`;

    expect(parseRadarTimeline(xml)).toEqual({
      observations: ['2026-08-02T11:55:00Z', '2026-08-02T12:00:00Z'],
      forecasts: ['2026-08-02T12:05:00Z', '2026-08-02T13:30:00Z'],
      latestObservation: '2026-08-02T12:00:00Z',
      latestForecast: '2026-08-02T13:30:00Z',
    });
  });

  it('annab teenuse formaadimuutusest arusaadava vea', () => {
    expect(() => parseRadarTimeline('<WMS_Capabilities />')).toThrow(/cmp_cap/);
  });
});
