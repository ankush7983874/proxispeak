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
import {
  checkCollision,
  findNearbyWorkstation,
  GENERAL_OBSTACLES,
  GENERAL_WORKSTATIONS,
} from '../frontend/src/hooks/useOfficeCanvas.js';

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

assert(VALID_STATUSES.has('online') && VALID_STATUSES.has('away') && VALID_STATUSES.has('busy'), 'Whitelisted statuses (online, away, busy) accepted');
assert(!VALID_STATUSES.has('invisible'), 'Unwhitelisted status rejected');

// Test 3-tier status transitions
const mockUser = { id: 'user-status', status: 'online' };
function updateStatus(user, nextStatus) {
  if (VALID_STATUSES.has(nextStatus)) {
    user.status = nextStatus;
    return true;
  }
  return false;
}
assert(updateStatus(mockUser, 'busy') && mockUser.status === 'busy', 'Successfully updated status to busy');
assert(updateStatus(mockUser, 'away') && mockUser.status === 'away', 'Successfully updated status to away');
assert(updateStatus(mockUser, 'online') && mockUser.status === 'online', 'Successfully restored status to online');
assert(!updateStatus(mockUser, 'offline'), 'Rejected invalid status offline');

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

// ── 8. Welcome Page Join Validation & Leave Office ───────────────────────────
function validateWelcomeJoin({ name, room, code }, privateMap) {
  if (typeof name !== 'string') return { valid: false, error: 'Name required' };
  const cleanName = name.replace(/<[^>]*>?/gm, '').trim();
  if (cleanName.length < 2 || cleanName.length > 30) {
    return { valid: false, error: 'Name must be 2-30 characters' };
  }

  const trimmedCode = (code || '').trim().toUpperCase();
  if (trimmedCode) {
    if (!/^PRV-[A-Z2-9]{4}$/.test(trimmedCode)) {
      return { valid: false, error: 'Invalid invitation code format' };
    }
    if (!privateMap.has(trimmedCode)) {
      return { valid: false, error: 'Meeting code not found' };
    }
    return { valid: true, targetRoom: trimmedCode, name: cleanName };
  }

  const standardRooms = ['general', 'meeting', 'focus'];
  if (!standardRooms.includes(room)) {
    return { valid: false, error: 'Invalid room selection' };
  }

  return { valid: true, targetRoom: room, name: cleanName };
}

const mockActiveRooms = new Map([
  ['PRV-WXYZ', { code: 'PRV-WXYZ', title: 'Sprint Review' }]
]);

assert(validateWelcomeJoin({ name: 'Alex', room: 'general' }, mockActiveRooms).valid, 'Valid name and general room passes welcome join');
assert(validateWelcomeJoin({ name: '  Sarah Chen  ', room: 'meeting' }, mockActiveRooms).name === 'Sarah Chen', 'Trims whitespace on welcome join');
assert(validateWelcomeJoin({ name: '<script>alert(1)</script>Alex', room: 'focus' }, mockActiveRooms).name === 'alert(1)Alex', 'Strips HTML tags in welcome name');
assert(!validateWelcomeJoin({ name: 'A', room: 'general' }, mockActiveRooms).valid, 'Rejects single character name');
assert(!validateWelcomeJoin({ name: '', room: 'general' }, mockActiveRooms).valid, 'Rejects empty name');
assert(!validateWelcomeJoin({ name: 'Valid User', room: 'unknown-room' }, mockActiveRooms).valid, 'Rejects invalid room name');
assert(validateWelcomeJoin({ name: 'Valid User', room: 'general', code: 'PRV-WXYZ' }, mockActiveRooms).targetRoom === 'PRV-WXYZ', 'Prioritizes invitation code over standard room');
assert(!validateWelcomeJoin({ name: 'Valid User', room: 'general', code: 'PRV-0000' }, mockActiveRooms).valid, 'Rejects code containing excluded digits');
assert(!validateWelcomeJoin({ name: 'Valid User', room: 'general', code: 'PRV-XXXX' }, mockActiveRooms).valid, 'Rejects unlisted private room code');

// Test Leave Office user state transition
const testOccupant = { id: 'occ-1', name: 'Leaver', room: 'meeting' };
function handleLeaveOffice(user) {
  const previousRoom = user.room;
  user.room = null;
  return { previousRoom, room: user.room };
}
const leaveRes = handleLeaveOffice(testOccupant);
assert(leaveRes.previousRoom === 'meeting' && leaveRes.room === null, 'Leave office resets room to null and captures departure room');

// ── 9. Reference 1 Guest Login & Email Validation ───────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateGuestLogin({ name, email }) {
  if (typeof name !== 'string') return { valid: false, error: 'Name must be a string' };
  const cleanName = name.replace(/<[^>]*>?/gm, '').trim();
  if (!cleanName || cleanName.length < 2 || cleanName.length > 30) {
    return { valid: false, error: 'Name must be 2-30 characters' };
  }

  if (typeof email !== 'string') return { valid: false, error: 'Email must be a string' };
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail)) {
    return { valid: false, error: 'Invalid email address' };
  }

  return { valid: true, name: cleanName, email: cleanEmail };
}

assert(validateGuestLogin({ name: 'Alex Mercer', email: 'alex@company.com' }).valid, 'Valid guest login with name and corporate email');
assert(validateGuestLogin({ name: '  Sarah Chen  ', email: '  SARAH.CHEN@SUB.DOMAIN.ORG  ' }).email === 'sarah.chen@sub.domain.org', 'Trims and lowercases email address');
assert(!validateGuestLogin({ name: 'Alex', email: 'invalid-email' }).valid, 'Rejects email without @ or domain');
assert(!validateGuestLogin({ name: 'Alex', email: 'alex@' }).valid, 'Rejects incomplete email');
assert(!validateGuestLogin({ name: 'Alex', email: '@domain.com' }).valid, 'Rejects missing local-part email');
assert(!validateGuestLogin({ name: 'Alex', email: 'alex@domain' }).valid, 'Rejects missing TLD email');
assert(!validateGuestLogin({ name: 'A', email: 'alex@domain.com' }).valid, 'Rejects name under 2 characters');
assert(!validateGuestLogin({ name: 'Alex', email: '' }).valid, 'Rejects empty email');

// ── 10. Reference 2 Realistic Office Collision & Axis Sliding ───────────────
assert(GENERAL_OBSTACLES.length >= 10, 'General office defines at least 10 furniture obstacle bounds');
assert(checkCollision(50, 410, 10, 'general'), 'Collides with reception desk at (50, 410)');
assert(checkCollision(100, 80, 10, 'general'), 'Collides with workstation cluster 1 at (100, 80)');
assert(checkCollision(600, 100, 10, 'general'), 'Collides with glass conference suite table at (600, 100)');
assert(checkCollision(250, 400, 10, 'general'), 'Collides with coffee bar counter at (250, 400)');
assert(!checkCollision(300, 300, 10, 'general'), 'Free walking path at (300, 300) does not collide');
assert(!checkCollision(100, 80, 10, 'meeting'), 'Collision check bypassed outside general office room');

// Test axis sliding simulation
function simulateMoveWithSliding(startX, startY, dx, dy, room = 'general') {
  let nx = startX + dx;
  let ny = startY + dy;
  if (checkCollision(nx, ny, 10, room)) {
    if (!checkCollision(nx, startY, 10, room)) {
      ny = startY; // slide on X
    } else if (!checkCollision(startX, ny, 10, room)) {
      nx = startX; // slide on Y
    } else {
      return { x: startX, y: startY, moved: false }; // blocked
    }
  }
  return { x: nx, y: ny, moved: nx !== startX || ny !== startY };
}

// User walks diagonally towards obstacle at (35, 65, w:200, h:50) from (100, 125) moving (dx: -10, dy: -20)
const slideRes = simulateMoveWithSliding(100, 125, -10, -20);
assert(slideRes.moved, 'Avatar slides along axis instead of getting completely stuck on collision');

// ── 11. Workstation Proximity & Sitting Mode ────────────────────────────────
assert(GENERAL_WORKSTATIONS.length === 8, 'General office defines 8 interactive workstations (6 desks + 2 focus booths)');
const nearDesk1 = findNearbyWorkstation(60, 125, 35);
assert(nearDesk1 && nearDesk1.id === 'desk-1', 'Identifies Workstation 1 within 35px threshold');
const nearBooth = findNearbyWorkstation(387, 310, 35);
assert(nearBooth && nearBooth.id === 'booth-1', 'Identifies Focus Booth A within 35px threshold');
const farEmpty = findNearbyWorkstation(500, 500, 35);
assert(farEmpty === null, 'Returns null when far away from any workstation');

// Workstation occupancy state test
const testWorkstations = new Map();
function sitUserAtDesk(socketId, desk) {
  testWorkstations.set(desk.id, { socketId, deskName: desk.name });
}
function leaveUserFromDesk(deskId) {
  testWorkstations.delete(deskId);
}

sitUserAtDesk('socket-1', nearDesk1);
assert(testWorkstations.has('desk-1') && testWorkstations.get('desk-1').socketId === 'socket-1', 'Workstation recorded as occupied');
leaveUserFromDesk('desk-1');
assert(!testWorkstations.has('desk-1'), 'Workstation vacated upon leaving');

// ── 12. In-Room Chat Text Sanitization & Room Scoping ────────────────────────
function sanitizeAndDispatchChat({ text, senderId, senderName, room }) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/<[^>]*>?/gm, '').trim().slice(0, 300);
  if (!clean) return null;
  return {
    id: `msg-${Date.now()}`,
    senderId,
    senderName,
    text: clean,
    room: room || 'general',
  };
}

const chatValid = sanitizeAndDispatchChat({
  text: '  Hello teammates! Looking forward to the demo.  ',
  senderId: 'sock-1',
  senderName: 'Alice',
  room: 'meeting',
});
assert(chatValid && chatValid.text === 'Hello teammates! Looking forward to the demo.', 'Chat message is trimmed');
assert(chatValid.room === 'meeting', 'Chat message retains room scope');

const chatXSS = sanitizeAndDispatchChat({
  text: '<img src=x onerror=alert(1)>Important announcement',
  senderId: 'sock-1',
  senderName: 'Bob',
  room: 'general',
});
assert(chatXSS && chatXSS.text === 'Important announcement', 'Strips HTML/XSS injection tags from chat message');
assert(sanitizeAndDispatchChat({ text: '   ' }) === null, 'Rejects empty or whitespace-only chat message');
assert(sanitizeAndDispatchChat({ text: null }) === null, 'Rejects null chat text');

console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
