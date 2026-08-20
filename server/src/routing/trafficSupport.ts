import type { TrafficScheme } from '@seapro/shared';
import type {
  Position,
  RoutingCorridor,
  RoutingFeatureSource,
  RoutingRestriction,
} from './sourceTypes.js';

export interface TrafficRoutingSupport {
  corridors: RoutingCorridor[];
  restrictions: RoutingRestriction[];
}

/** Muudab kuvamiskihi TSS-objektid staatiliseks, suunateadlikuks routingutoeks. */
export function trafficSchemesToRoutingVectors(
  schemes: readonly TrafficScheme[],
  stamp: RoutingFeatureSource,
): TrafficRoutingSupport {
  const corridors: RoutingCorridor[] = [];
  const restrictions: RoutingRestriction[] = [];

  for (const scheme of schemes) {
    // Sihtjoon ja soovitusliku tee keskjoon kuuluvad kuvamis- või põhigraafi,
    // mitte graafiväliste ühenduste ohutuskihi hulka.
    if (scheme.kind === 'navigation_line'
      || scheme.kind === 'recommended_route_centreline'
      || scheme.kind === 'recommended_track') continue;
    const base = {
      id: `openstreetmap-overpass:traffic:${scheme.id}`,
      geometry: scheme.geometry,
      name: scheme.name,
      ...stamp,
    };
    if (scheme.kind === 'separation_zone'
      || scheme.kind === 'separation_boundary'
      || scheme.kind === 'separation_line'
      || scheme.kind === 'separation_crossing'
      || scheme.kind === 'separation_roundabout'
      || scheme.kind === 'inshore_traffic_zone'
      || scheme.kind === 'precautionary_area') {
      restrictions.push({
        ...base,
        kind: 'separation_zone',
        category: scheme.kind,
        ...(scheme.orientation !== undefined ? { directionDegrees: scheme.orientation } : {}),
      });
      continue;
    }

    for (const [partIndex, geometry] of trafficLaneParts(scheme)) {
      const directionDegrees = scheme.orientation ?? lineDirectionDegrees(geometry);
      const twoWay = scheme.kind === 'two-way_route';
      corridors.push({
        ...base,
        id: partIndex === 0 ? base.id : `${base.id}:${partIndex}`,
        geometry,
        kind: 'traffic_lane',
        geometryRole: geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'
          ? 'area'
          : 'centreline',
        direction: twoWay ? 'two_way' : directionDegrees === undefined ? 'unknown' : 'one_way',
        ...(directionDegrees !== undefined ? { directionDegrees } : {}),
        official: false,
        category: scheme.kind,
      });
    }
  }
  return { corridors, restrictions };
}

function trafficLaneParts(scheme: TrafficScheme): Array<[number, TrafficScheme['geometry']]> {
  if (scheme.geometry.type !== 'MultiLineString') return [[0, scheme.geometry]];
  return scheme.geometry.coordinates.map((coordinates, index) => [
    index,
    { type: 'LineString', coordinates },
  ]);
}

/** OpenSeaMapi rajanooled järgivad joone sõlmede järjekorda. */
function lineDirectionDegrees(geometry: TrafficScheme['geometry']): number | undefined {
  if (geometry.type !== 'LineString') return undefined;
  const from = geometry.coordinates[0];
  const to = geometry.coordinates.at(-1);
  if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return undefined;
  return bearing(from, to);
}

function bearing(from: Position, to: Position): number {
  const meanLatitude = (from[1] + to[1]) * Math.PI / 360;
  const east = (to[0] - from[0]) * Math.cos(meanLatitude);
  const north = to[1] - from[1];
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}
