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
    .filter((user) => !user.room || !me.room || user.room === me.room)
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

/**
 * Test whether the 2D line segment (x1, y1) -> (x2, y2) intersects an AABB rect { x, y, w, h }
 */
export function segmentIntersectsRect(x1, y1, x2, y2, rect) {
  const minX = rect.x;
  const maxX = rect.x + rect.w;
  const minY = rect.y;
  const maxY = rect.y + rect.h;

  if ((x1 < minX && x2 < minX) || (x1 > maxX && x2 > maxX)) return false;
  if ((y1 < minY && y2 < minY) || (y1 > maxY && y2 > maxY)) return false;

  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;
  if (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY) return true;

  const dx = x2 - x1;
  const dy = y2 - y1;

  let t0 = 0.0;
  let t1 = 1.0;

  const p = [-dx, dx, -dy, dy];
  const q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }

  return t0 <= t1;
}

/**
 * Calculates acoustic transmission and obstruction between two points given room obstacles.
 * Returns { transmission: number, obstruction: number, blockedBy: string[] }
 * Transmission ranges from 1.0 (unobstructed) to min 0.08 (heavily muffled).
 */
export function calculateAudioObstruction(p1, p2, obstacles = []) {
  if (!p1 || !p2 || !Array.isArray(obstacles) || obstacles.length === 0) {
    return { transmission: 1.0, obstruction: 0.0, blockedBy: [] };
  }

  let totalTransmission = 1.0;
  const blockedBy = [];

  for (const obs of obstacles) {
    if (segmentIntersectsRect(p1.x, p1.y, p2.x, p2.y, obs)) {
      const absorption = typeof obs.soundAbsorption === 'number' ? obs.soundAbsorption : 0.35;
      totalTransmission *= (1 - absorption);
      blockedBy.push(obs.name || obs.id || 'obstacle');
    }
  }

  const finalTransmission = Math.max(0.08, totalTransmission);
  return {
    transmission: Number(finalTransmission.toFixed(3)),
    obstruction: Number((1 - finalTransmission).toFixed(3)),
    blockedBy,
  };
}
