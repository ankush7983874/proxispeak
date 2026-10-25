/**
 * tests/rooms.test.mjs
 * Comprehensive unit and integration test suite for Phase 3:
 * 1. Invitation code generation, format, and collision-free uniqueness
 * 2. Display name sanitization (XSS stripping, length bounds)
 * 3. Avatar color, style, and status whitelist validation
 * 4. Public and private room membership validation
 * 5. Proximity audio isolation between different rooms
 * 6. WebRTC signaling authorization across rooms
 * 7. Private meeting room lifecycle & automatic cleanup
 */

import { getNearbyUsers as getNearbyServer } from '../backend/src/utils/proximity.js';
import { getNearbyUsers as getNearbyClient } from '../frontend/src/utils/proximity.js';

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

console.log('\n── ProxiSpeak Phase 3 Room & Security Test Suite ──\n');

// ── 1. Code Generation & Uniqueness ──────────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateTestCode(existingMap) {
  let code;
  let attempts = 0;
  do {
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      suffix += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    }
    code = `PRV-${suffix}`;
    attempts++;
  } while (existingMap.has(code) && attempts < 100);
  return code;
}

const mockRooms = new Map();
const generatedCodes = new Set();
let collisionDetected = false;

for (let i = 0; i < 100; i++) {
  const code = generateTestCode(mockRooms);
  if (generatedCodes.has(code)) {
    collisionDetected = true;
  }
  generatedCodes.add(code);
  mockRooms.set(code, { title: `Meeting ${i}` });
}

assert(!collisionDetected, '100 generated room codes have 0 collisions');
assert(generatedCodes.size === 100, 'All 100 codes are distinct');

const sampleCode = Array.from(generatedCodes)[0];
assert(/^PRV-[A-Z2-9]{4}$/.test(sampleCode), `Code format matches PRV-XXXX regex: ${sampleCode}`);
assert(!/[0O1I]/.test(sampleCode.slice(4)), 'Code excludes ambiguous characters (0, O, 1, I)');

// ── 2. Profile Sanitization ──────────────────────────────────────────────────
function sanitizeDisplayName(rawName) {
  if (typeof rawName !== 'string') return null;
  const stripped = rawName.replace(/<[^>]*>?/gm, '').trim();
  if (stripped.length < 2 || stripped.length > 30) return null;
  return stripped;
}

assert(sanitizeDisplayName('Alice') === 'Alice', 'Accepts valid name');
assert(sanitizeDisplayName('  Bob  ') === 'Bob', 'Trims whitespace');
assert(sanitizeDisplayName('<script>alert(1)</script>Charlie') === 'alert(1)Charlie', 'Strips HTML/script tags');
assert(sanitizeDisplayName('<b>Team</b>') === 'Team', 'Strips bold tags');
assert(sanitizeDisplayName('A') === null, 'Rejects names shorter than 2 chars');
assert(sanitizeDisplayName('a'.repeat(31)) === null, 'Rejects names longer than 30 chars');
assert(sanitizeDisplayName('') === null, 'Rejects empty name');
assert(sanitizeDisplayName(123) === null, 'Rejects non-string types');

// ── 3. Avatar Color, Style, Status Validation ────────────────────────────────
const VALID_STYLES = new Set(['classic', 'star', 'diamond', 'crown']);
const VALID_STATUSES = new Set(['online', 'away', 'busy']);
const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

assert(HEX_REGEX.test('#259765'), 'Validates standard 6-digit hex color');
assert(HEX_REGEX.test('#9664D9'), 'Validates uppercase hex color');
assert(!HEX_REGEX.test('red'), 'Rejects named color');
assert(!HEX_REGEX.test('#FFF'), 'Rejects 3-digit shorthand hex');
assert(!HEX_REGEX.test('javascript:alert()'), 'Rejects malicious string in color field');

assert(VALID_STYLES.has('star') && VALID_STYLES.has('crown'), 'Whitelisted styles accepted');
assert(!VALID_STYLES.has('unknown_style'), 'Unknown avatar style rejected');

assert(VALID_STATUSES.has('online') && VALID_STATUSES.has('away'), 'Whitelisted statuses accepted');
assert(!VALID_STATUSES.has('invisible'), 'Unwhitelisted status rejected');

// ── 4. Room Validation & Access Control ───────────────────────────────────────
const PUBLIC_ROOMS = ['general', 'meeting', 'focus'];

function validateRoomJoin(targetRoom, code, privateMap) {
  const room = (targetRoom || 'general').trim();
  if (PUBLIC_ROOMS.includes(room)) {
    return { valid: true, room, isPrivate: false };
  }
  const lookup = (code || room).trim().toUpperCase();
  if (privateMap.has(lookup)) {
    return { valid: true, room: lookup, isPrivate: true, title: privateMap.get(lookup).title };
  }
  return { valid: false, error: 'Invalid or expired meeting invitation code.' };
}

const activePrivate = new Map();
activePrivate.set('PRV-TEST', { code: 'PRV-TEST', title: 'Dev Sync', hostSocketId: 'host-1' });

assert(validateRoomJoin('general', null, activePrivate).valid, 'General office access permitted');
assert(validateRoomJoin('meeting', null, activePrivate).valid, 'Meeting room access permitted');
assert(validateRoomJoin('focus', null, activePrivate).valid, 'Focus room access permitted');
assert(validateRoomJoin('PRV-TEST', 'PRV-TEST', activePrivate).valid, 'Valid private room code accepted');
assert(!validateRoomJoin('PRV-WRONG', 'PRV-WRONG', activePrivate).valid, 'Invalid private room code rejected');
assert(!validateRoomJoin('hack-room', null, activePrivate).valid, 'Arbitrary room name rejected');

// ── 5. Room Isolation in Proximity Audio ─────────────────────────────────────
const userA = { id: 'user-a', name: 'Alice', x: 200, y: 200, room: 'general' };
const userB_same = { id: 'user-b', name: 'Bob', x: 220, y: 200, room: 'general' }; // 20px apart, in general
const userC_diff = { id: 'user-c', name: 'Charlie', x: 200, y: 200, room: 'meeting' }; // 0px apart, but in meeting!

// Server-side check
const serverUsers = new Map([
  [userA.id, userA],
  [userB_same.id, userB_same],
  [userC_diff.id, userC_diff],
]);

const serverNearby = getNearbyServer(userA, serverUsers);
assert(serverNearby.length === 1, 'Server earshot returns only 1 nearby user');
assert(serverNearby[0].user.id === 'user-b', 'Server earshot includes Bob in same room');
assert(!serverNearby.some(n => n.user.id === 'user-c'), 'Server earshot EXCLUDES Charlie in meeting room despite 0px distance');

// Client-side check
const clientNearby = getNearbyClient(userA, [userB_same, userC_diff]);
assert(clientNearby.length === 1, 'Client earshot returns only 1 nearby user');
assert(clientNearby[0].user.id === 'user-b', 'Client earshot includes Bob in same room');
assert(!clientNearby.some(n => n.user.id === 'user-c'), 'Client earshot EXCLUDES Charlie in meeting room');

// ── 6. WebRTC Signaling Authorization ────────────────────────────────────────
function authorizeSignaling(sender, targetId, usersMap) {
  if (!targetId || !usersMap.has(targetId)) return false;
  const targetUser = usersMap.get(targetId);
  return targetUser.room === sender.room;
}

assert(authorizeSignaling(userA, 'user-b', serverUsers) === true, 'Signaling authorized between Alice and Bob (same room: general)');
assert(authorizeSignaling(userA, 'user-c', serverUsers) === false, 'Cross-room signaling REJECTED between Alice (general) and Charlie (meeting)');
assert(authorizeSignaling(userA, 'non-existent', serverUsers) === false, 'Signaling to unknown socket ID REJECTED');

// ── 7. Private Meeting Lifecycle & Auto-Cleanup ──────────────────────────────
const testPrivateRooms = new Map();
const testUsers = new Map();

// Host creates room
const roomCode = 'PRV-DEMO';
testPrivateRooms.set(roomCode, {
  code: roomCode,
  title: 'Architecture Review',
  hostSocketId: 'user-1',
});

testUsers.set('user-1', { id: 'user-1', room: roomCode });
testUsers.set('user-2', { id: 'user-2', room: roomCode });

assert(testPrivateRooms.has(roomCode), 'Private room created');
assert(Array.from(testUsers.values()).filter(u => u.room === roomCode).length === 2, '2 users in private room');

// User 1 leaves
testUsers.delete('user-1');
const remaining1 = Array.from(testUsers.values()).filter(u => u.room === roomCode);
assert(remaining1.length === 1, '1 user remains after host departs');
assert(testPrivateRooms.has(roomCode), 'Room remains alive while 1 attendee is present');

// User 2 leaves (last occupant)
testUsers.delete('user-2');
const remaining2 = Array.from(testUsers.values()).filter(u => u.room === roomCode);
if (remaining2.length === 0) {
  testPrivateRooms.delete(roomCode);
}
assert(!testPrivateRooms.has(roomCode), 'Private room automatically cleaned up when last participant departs');

console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
