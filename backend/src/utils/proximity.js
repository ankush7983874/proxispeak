/**
 * src/utils/proximity.js  (server-side)
 *
 * Mirrors the coordinate system documented in:
 *   - backend/src/models/Session.js
 *   - frontend/src/utils/proximity.js
 *
 * Canvas pixel (x, y) → GeoJSON [x / CANVAS_WIDTH, y / CANVAS_HEIGHT]
 *
 * Earshot radius: 100 canvas pixels
 * In normalised space: 100 / 800 = 0.125 units (longitude/latitude analogs)
 */

export const CANVAS_WIDTH    = 800;
export const CANVAS_HEIGHT   = 500;
export const EARSHOT_PIXELS  = 100;

// Normalised earshot radius for MongoDB $geoWithin queries
// Uses max(W, H) so the radius is conservative in both axes
export const EARSHOT_NORMALISED = EARSHOT_PIXELS / CANVAS_WIDTH; // 0.125

/**
 * Euclidean distance between two canvas positions (in pixels).
 */
export function canvasDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Returns a list of all users within EARSHOT_PIXELS of `me`.
 * Uses the in-memory users Map for O(n) scan.
 * For large deployments, replace with a $geoWithin MongoDB query.
 *
 * @param {object} me      — { x, y, ... }
 * @param {Map}    usersMap — Map of socketId → user object
 * @returns {Array} nearby users (excluding me), sorted nearest-first
 */
export function getNearbyUsers(me, usersMap) {
  const results = [];
  for (const [, user] of usersMap) {
    if (user.id === me.id) continue;
    const dist = canvasDistance(me, user);
    if (dist <= EARSHOT_PIXELS) {
      results.push({ user, dist });
    }
  }
  return results.sort((a, b) => a.dist - b.dist);
}

/**
 * Build MongoDB $geoWithin center-sphere query for earshot proximity.
 * Use this in routes/proximity endpoints for index-backed queries.
 *
 * @param {number} x — canvas x pixel
 * @param {number} y — canvas y pixel
 * @returns MongoDB query object for location field
 */
export function buildGeoWithinQuery(x, y) {
  const lon = x / CANVAS_WIDTH;
  const lat = y / CANVAS_HEIGHT;
  // $centerSphere: [[lon, lat], radius in radians]
  // We treat our normalised coordinate space as flat degrees, so radius
  // in "degrees" ≈ EARSHOT_NORMALISED. This is a close approximation for
  // small distances on a flat office map.
  return {
    $geoWithin: {
      $centerSphere: [[lon, lat], EARSHOT_NORMALISED / 111.32],
    },
  };
}

/**
 * Clamp canvas coordinates to valid office bounds.
 */
export function clampPosition(x, y) {
  return {
    x: Math.max(20, Math.min(CANVAS_WIDTH  - 20, x)),
    y: Math.max(20, Math.min(CANVAS_HEIGHT - 20, y)),
  };
}
