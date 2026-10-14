/**
 * proximity.js  (client-side)
 *
 * Canvas coordinate system:
 *   Office canvas: 800 × 500 pixels (logical units stored on server).
 *   Earshot radius: 100 pixels (configurable via EARSHOT_RADIUS).
 *
 * MongoDB coordinate mapping (documented):
 *   Canvas pixel (x, y) → GeoJSON [x / 800, y / 500]
 *   This normalises positions to the range [0, 1] for both axes so that
 *   geospatial distance calculations operate on a consistent unit scale.
 *   1 unit in the normalised space = full canvas width/height.
 *   The EARSHOT_RADIUS_GEO = 100 / 800 ≈ 0.125 (normalised units).
 *   This mapping is mirrored exactly in backend/src/utils/proximity.js.
 */

export const CANVAS_WIDTH   = 800;
export const CANVAS_HEIGHT  = 500;
export const EARSHOT_RADIUS = 100; // canvas pixels

/**
 * Euclidean distance between two canvas positions.
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @returns {number} distance in canvas pixels
 */
export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Filter a list of users to those within earshot of `me`.
 * @param {{ x: number, y: number }} me
 * @param {Array<{ x: number, y: number }>} others
 * @param {number} [radius]
 * @returns {Array<{ user: object, dist: number }>} sorted nearest-first
 */
export function getNearbyUsers(me, others, radius = EARSHOT_RADIUS) {
  return others
    .map((user) => ({ user, dist: distance(me, user) }))
    .filter(({ dist }) => dist <= radius)
    .sort((a, b) => a.dist - b.dist);
}

/**
 * Map a canvas distance to an audio gain value [0, 1].
 * At distance 0 → gain 1.0 (full volume).
 * At distance >= radius → gain 0.0 (silent).
 * Uses a squared (power) curve for natural-sounding falloff.
 *
 * @param {number} dist   Distance in canvas pixels
 * @param {number} [radius]
 * @returns {number} gain between 0 and 1
 */
export function volumeFromDistance(dist, radius = EARSHOT_RADIUS) {
  if (dist >= radius) return 0;
  if (dist <= 0)      return 1;
  const t = 1 - dist / radius; // linear 0→1 as dist goes radius→0
  return t * t;                 // squared for perceptual smoothness
}
