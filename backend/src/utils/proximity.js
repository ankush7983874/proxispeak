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
    // Room isolation: users in different rooms cannot hear each other
    if (user.room && me.room && user.room !== me.room) continue;
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
 * Build MongoDB $near geospatial query for sorted earshot proximity.
 * Requires a 2dsphere index on the location field.
 * Returns results automatically ordered from nearest to farthest.
 *
 * @param {number} x — canvas x pixel
 * @param {number} y — canvas y pixel
 * @param {number} [maxDistancePixels] — maximum search distance (defaults to EARSHOT_PIXELS)
 * @returns MongoDB query object for location field
 */
export function buildNearQuery(x, y, maxDistancePixels = EARSHOT_PIXELS) {
  const lon = x / CANVAS_WIDTH;
  const lat = y / CANVAS_HEIGHT;
  const radiusNormalised = maxDistancePixels / CANVAS_WIDTH;
  return {
    location: {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: [lon, lat],
        },
        $maxDistance: radiusNormalised / 111.32,
      },
    },
  };
}

/**
 * Test whether the 2D line segment (x1, y1) -> (x2, y2) intersects an AABB rect { x, y, w, h }
 */
export function segmentIntersectsRect(x1, y1, x2, y2, rect) {
  const minX = rect.x;
  const maxX = rect.x + rect.w;
  const minY = rect.y;
  const maxY = rect.y + rect.h;

  // Quick bounding box rejection
  if ((x1 < minX && x2 < minX) || (x1 > maxX && x2 > maxX)) return false;
  if ((y1 < minY && y2 < minY) || (y1 > maxY && y2 > maxY)) return false;

  // Endpoint inside rect check
  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;
  if (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY) return true;

  // Liang-Barsky parametric clipping
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

/**
 * Clamp canvas coordinates to valid office bounds.
 */
export function clampPosition(x, y) {
  return {
    x: Math.max(20, Math.min(CANVAS_WIDTH  - 20, x)),
    y: Math.max(20, Math.min(CANVAS_HEIGHT - 20, y)),
  };
}
