/**
 * tests/proximity.test.mjs
 * Unit tests for client & server proximity algorithms, volume attenuation curves,
 * coordinate normalisation, and bounds clamping.
 */
import { distance, getNearbyUsers, volumeFromDistance, EARSHOT_RADIUS, CANVAS_WIDTH, CANVAS_HEIGHT } from '../frontend/src/utils/proximity.js';
import {
  canvasDistance,
  getNearbyUsers as getNearbyServer,
  buildGeoWithinQuery,
  clampPosition,
  EARSHOT_PIXELS,
  EARSHOT_NORMALISED
} from '../backend/src/utils/proximity.js';

let pass = 0;
let fail = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS  ${message}`);
    pass++;
  } else {
    console.error(`  ❌ FAIL  ${message}`);
    fail++;
  }
}

console.log('\n── ProxiSpeak Phase 2 Unit Tests ──\n');

// 1. Distance formula
assert(distance({ x: 0, y: 0 }, { x: 30, y: 40 }) === 50, 'Client distance() 3-4-5 triangle');
assert(canvasDistance({ x: 100, y: 100 }, { x: 100, y: 200 }) === 100, 'Server canvasDistance() vertical 100px');

// 2. Volume attenuation curve
assert(volumeFromDistance(0) === 1, 'Volume at 0 distance is 1.0 (100%)');
assert(volumeFromDistance(50, 100) === 0.25, 'Volume at half distance (50px / 100px) is 0.25 (25%) using squared curve');
assert(volumeFromDistance(100, 100) === 0, 'Volume at earshot boundary (100px) is 0.0');
assert(volumeFromDistance(150, 100) === 0, 'Volume beyond earshot (>100px) is 0.0');
assert(volumeFromDistance(-10, 100) === 1, 'Volume at negative distance is clamped to 1.0');

// 3. Nearby users filtering (Client)
const me = { id: 'me', x: 200, y: 200 };
const others = [
  { id: 'user1', name: 'Alice', x: 230, y: 240 }, // distance = 50px (in range)
  { id: 'user2', name: 'Bob', x: 200, y: 280 },   // distance = 80px (in range)
  { id: 'user3', name: 'Charlie', x: 200, y: 350 }, // distance = 150px (out of range)
];

const clientNearby = getNearbyUsers(me, others, EARSHOT_RADIUS);
assert(clientNearby.length === 2, `Client getNearbyUsers returned 2 users within ${EARSHOT_RADIUS}px`);
assert(clientNearby[0].user.id === 'user1', 'Client getNearbyUsers sorted nearest first (Alice @ 50px)');
assert(clientNearby[1].user.id === 'user2', 'Client getNearbyUsers second nearest (Bob @ 80px)');

// 4. Nearby users filtering (Server)
const usersMap = new Map();
usersMap.set('me', me);
others.forEach(u => usersMap.set(u.id, u));

const serverNearby = getNearbyServer(me, usersMap);
assert(serverNearby.length === 2, `Server getNearbyUsers returned 2 users within ${EARSHOT_PIXELS}px`);
assert(serverNearby[0].user.id === 'user1', 'Server getNearbyUsers sorted nearest first');

// 5. Normalised coordinate scale
assert(EARSHOT_NORMALISED === 100 / 800, 'Normalised earshot is 0.125 units');

// 6. Server clamping
const clampedNegative = clampPosition(-50, -20);
assert(clampedNegative.x === 20 && clampedNegative.y === 20, 'Clamps negative coordinates to min bounds (20, 20)');

const clampedExcess = clampPosition(1000, 800);
assert(clampedExcess.x === CANVAS_WIDTH - 20 && clampedExcess.y === CANVAS_HEIGHT - 20, 'Clamps excess coordinates to max bounds (780, 480)');

// 7. GeoJSON query construction
const geoQuery = buildGeoWithinQuery(400, 250);
assert(geoQuery.$geoWithin && geoQuery.$geoWithin.$centerSphere, 'buildGeoWithinQuery generates $centerSphere query');
const [coords, rad] = geoQuery.$geoWithin.$centerSphere;
assert(coords[0] === 400 / 800 && coords[1] === 250 / 500, 'GeoJSON query normalises coordinates to [0.5, 0.5]');
assert(rad > 0, 'GeoJSON query provides positive radius');

console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
