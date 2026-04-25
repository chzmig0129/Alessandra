/**
 * Shared geo utilities — haversine distance and Google Maps URL builders.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Haversine distance in kilometres between two lat/lng points.
 * Implementation mirrored from src/domains/puntos-violeta/queries.ts.
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Returns a Google Maps directions URL from origin to destination.
 * Coordinates are formatted with 6 decimal places.
 *
 * Example output:
 *   https://www.google.com/maps/dir/?api=1&origin=19.432600,-99.133200&destination=20.670000,-103.350000&travelmode=driving
 */
export function googleMapsDirectionsUrl(
  origin: LatLng,
  destination: LatLng,
  mode: 'driving' | 'walking' | 'transit' = 'driving',
): string {
  const o = `${origin.lat.toFixed(6)},${origin.lng.toFixed(6)}`;
  const d = `${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=${mode}`;
}

/**
 * Returns a Google Maps pin URL for a single point (no directions).
 *
 * Example output:
 *   https://www.google.com/maps/search/?api=1&query=19.432600,-99.133200
 */
export function googleMapsPinUrl(point: LatLng): string {
  return `https://www.google.com/maps/search/?api=1&query=${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}
