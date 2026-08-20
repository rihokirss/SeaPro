/**
 * Avalikud globaalse katvusega Overpassi peeglid.
 *
 * Hoidmine ühes kohas väldib olukorda, kus routing ja kaardikiht kasutavad
 * eri serveriloendeid. Kumi vana host kolis 2026. aastal private.coffee alla.
 */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
] as const;
