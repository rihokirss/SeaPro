/**
 * Avab Navily kaardi täpselt sadama asukohas. Navily näitab enne sadama
 * valimist ka ümbrust, lähedasi sadamaid ja ankrukohti.
 *
 * Me ei päri ega talleta Navily sadama-ID-sid või nende kataloogiandmeid.
 */
export function navilyUrl(lat: number, lon: number): string {
  return `https://www.navily.com/carte/place/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}
