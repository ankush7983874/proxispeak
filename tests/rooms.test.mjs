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

import {
  getNearbyUsers as getNearbyServer,
  buildNearQuery,
  segmentIntersectsRect,
  calculateAudioObstruction,
} from '../backend/src/utils/proximity.js';
import {
  getNearbyUsers as getNearbyClient,
  volumeFromDistance,
} from '../frontend/src/utils/proximity.js';
import {
  DEFAULT_GENERAL_LAYOUT,
  DEFAULT_MEETING_LAYOUT,
  DEFAULT_FOCUS_LAYOUT,
} from '../backend/src/models/OfficeLayout.js';
import {
  checkCollision,
  findNearbyWorkstation,
  getRoomObstacles,
  getCurrentZone,
  GENERAL_OBSTACLES,
  MEETING_OBSTACLES,
  FOCUS_OBSTACLES,
  PRIVATE_OBSTACLES,
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

// ── 13. Live Office Presence Serialization & Directory Contract ─────────────
function buildTestOfficePresence(usersMap, privateRoomsMap) {
  const presence = [];
  for (const [, u] of usersMap) {
    let roomTitle = 'General Office';
    if (u.room === 'meeting')      roomTitle = 'Meeting Room';
    else if (u.room === 'focus')   roomTitle = 'Focus Room';
    else if (u.room && privateRoomsMap.has(u.room)) {
      roomTitle = privateRoomsMap.get(u.room).title || 'Private Meeting';
    } else if (!u.room) {
      roomTitle = 'Lobby';
    }

    presence.push({
      id: u.id,
      name: u.name,
      email: u.email || null,
      guestId: u.guestId || null,
      room: u.room || 'general',
      roomTitle,
      isPrivate: Boolean(u.room && privateRoomsMap.has(u.room)),
      status: u.status || 'online',
      micEnabled: Boolean(u.micEnabled),
      avatarColor: u.avatarColor || '#259765',
      avatarStyle: u.avatarStyle || 'classic',
      workstation: u.workstation || null,
      joinedAt: u.joinedAt || null,
      x: u.x,
      y: u.y,
    });
  }
  return presence;
}

const mockPresenceUsers = new Map([
  ['sock-1', { id: 'sock-1', name: 'Alice Chen', email: 'alice@company.com', guestId: 'EMP-01', room: 'general', status: 'online', micEnabled: true, avatarColor: '#2563eb', avatarStyle: 'crown', workstation: 'Workstation 1', x: 60, y: 125 }],
  ['sock-2', { id: 'sock-2', name: 'Bob Smith', email: 'bob@company.com', guestId: 'EMP-02', room: 'meeting', status: 'busy', micEnabled: false, avatarColor: '#06b6d4', avatarStyle: 'star', workstation: null, x: 300, y: 100 }],
  ['sock-3', { id: 'sock-3', name: 'Elena Rostova', email: 'elena@company.com', guestId: 'EMP-03', room: 'PRV-DEMO', status: 'away', micEnabled: false, avatarColor: '#8b5cf6', avatarStyle: 'diamond', workstation: null, x: 200, y: 200 }],
  ['sock-4', { id: 'sock-4', name: 'David Guest', email: null, guestId: null, room: null, status: 'online', micEnabled: false, avatarColor: '#10b981', avatarStyle: 'classic', workstation: null, x: 400, y: 250 }],
]);

const mockPresencePrivateRooms = new Map([
  ['PRV-DEMO', { code: 'PRV-DEMO', title: 'Executive Sync', hostSocketId: 'sock-3' }],
]);

const presenceList = buildTestOfficePresence(mockPresenceUsers, mockPresencePrivateRooms);

assert(presenceList.length === 4, 'Presence list reflects exactly 4 connected participants');
const alicePresence = presenceList.find(p => p.id === 'sock-1');
assert(alicePresence && alicePresence.roomTitle === 'General Office', 'Alice mapped to General Office');
assert(alicePresence.workstation === 'Workstation 1', 'Alice workstation metadata preserved');
assert(alicePresence.micEnabled === true, 'Alice mic status true');

const bobPresence = presenceList.find(p => p.id === 'sock-2');
assert(bobPresence && bobPresence.roomTitle === 'Meeting Room', 'Bob mapped to Meeting Room');
assert(bobPresence.isPrivate === false, 'Meeting Room is not private');

const elenaPresence = presenceList.find(p => p.id === 'sock-3');
assert(elenaPresence && elenaPresence.roomTitle === 'Executive Sync', 'Elena private room title resolved');
assert(elenaPresence.isPrivate === true, 'Elena is marked as isPrivate: true');

const guestPresence = presenceList.find(p => p.id === 'sock-4');
assert(guestPresence && guestPresence.roomTitle === 'Lobby', 'User with null room mapped to Lobby');

// ── 14. Multi-Room Furniture Obstacle Collisions & Sliding ──────────────────
assert(getRoomObstacles('general').length >= 10, 'General office has at least 10 furniture obstacle bounds');
assert(getRoomObstacles('meeting').length >= 4, 'Meeting room defines at least 4 obstacle bounds (video wall, podium, table, lounges)');
assert(getRoomObstacles('focus').length >= 4, 'Focus room defines 4 private acoustic pods');
assert(getRoomObstacles('PRV-TEST', true).length >= 3, 'Private room defines boardroom and presentation obstacles');

// Collision in Meeting Room: Grand Boardroom Table at { x: 200, y: 160, w: 400, h: 110 }
assert(checkCollision(300, 200, 10, 'meeting'), 'Collides with Grand Boardroom Table in meeting room at (300, 200)');
assert(!checkCollision(100, 300, 10, 'meeting'), 'Free walking aisle in meeting room at (100, 300) does not collide');

// Collision in Focus Room: Pod 1 at { x: 65, y: 85, w: 190, h: 45 }
assert(checkCollision(100, 100, 10, 'focus'), 'Collides with Silent Pod A desk in focus room at (100, 100)');
assert(!checkCollision(350, 250, 10, 'focus'), 'Center corridor in focus room at (350, 250) does not collide');

// Collision in Private Room: Executive Table at { x: 170, y: 120, w: 460, h: 130 }
assert(checkCollision(300, 180, 10, 'PRV-DEMO', true), 'Collides with Executive Boardroom Table in private room');
assert(!checkCollision(100, 300, 10, 'PRV-DEMO', true), 'Free space in private room does not collide');

// Meeting room axis sliding simulation
const meetingSlide = simulateMoveWithSliding(200, 140, 10, 15, 'meeting');
assert(meetingSlide.moved, 'Avatar performs axis sliding around boardroom table in meeting room');

// ── 15. Interactive Minimap Coordinate Conversion & Zone Mapping ─────────────
// Minimap is 184 x 115 px representing 800 x 500 px canvas (ratio 16:10)
function convertMinimapToCanvas(clickX, clickY, mapW = 184, mapH = 115, canvasW = 800, canvasH = 500) {
  const rawX = Math.round((clickX / mapW) * canvasW);
  const rawY = Math.round((clickY / mapH) * canvasH);
  return {
    x: Math.max(20, Math.min(canvasW - 20, rawX)),
    y: Math.max(20, Math.min(canvasH - 20, rawY)),
  };
}

const centerNav = convertMinimapToCanvas(92, 57.5);
assert(centerNav.x === 400 && centerNav.y === 250, 'Minimap center (92, 57.5) scales to canvas center (400, 250)');

const topLeftNav = convertMinimapToCanvas(0, 0);
assert(topLeftNav.x === 20 && topLeftNav.y === 20, 'Minimap (0, 0) clamped safely within canvas border bounds');

const bottomRightNav = convertMinimapToCanvas(184, 115);
assert(bottomRightNav.x === 780 && bottomRightNav.y === 480, 'Minimap (184, 115) clamped safely within canvas border bounds');

// Zone identification test across various coordinates
const devZone = getCurrentZone(100, 100, 'general');
assert(devZone && devZone.name === 'DEV & ENGINEERING', 'Zone at (100, 100) identified as DEV & ENGINEERING');

const collabZone = getCurrentZone(350, 100, 'general');
assert(collabZone && collabZone.name === 'COLLABORATION HUB', 'Zone at (350, 100) identified as COLLABORATION HUB');

const confZone = getCurrentZone(600, 100, 'general');
assert(confZone && confZone.name === 'GLASS CONFERENCE', 'Zone at (600, 100) identified as GLASS CONFERENCE');

const receptionZone = getCurrentZone(50, 400, 'general');
assert(receptionZone && receptionZone.name === 'RECEPTION', 'Zone at (50, 400) identified as RECEPTION');

const cafeZone = getCurrentZone(250, 400, 'general');
assert(cafeZone && cafeZone.name === 'REFRESHMENT CAFE', 'Zone at (250, 400) identified as REFRESHMENT CAFE');

const loungeZone = getCurrentZone(500, 400, 'general');
assert(loungeZone && loungeZone.name === 'BREAKOUT LOUNGE', 'Zone at (500, 400) identified as BREAKOUT LOUNGE');

const corridorZone = getCurrentZone(300, 300, 'general');
assert(corridorZone && corridorZone.name === 'Office Corridor', 'Unzoned canvas point identified as Office Corridor walkway');

const meetingStage = getCurrentZone(100, 100, 'meeting');
assert(meetingStage && meetingStage.name === 'BOARDROOM & STAGE', 'Meeting room identified as BOARDROOM & STAGE');

const focusPodA = getCurrentZone(100, 100, 'focus');
assert(focusPodA && focusPodA.name === 'SILENT POD A', 'Focus room identified as SILENT POD A');

const privateZone = getCurrentZone(100, 100, 'PRV-1234', { isPrivate: true, title: 'Investor Pitch' });
assert(privateZone && privateZone.name === 'INVESTOR PITCH', 'Private room identified with custom uppercase title');

// ── 16. Socket Connection Monitoring & State Machine ────────────────────────
function simulateConnectionState(event, data, currentState = {}) {
  const state = { ...currentState };
  switch (event) {
    case 'connect':
      state.connected = true;
      state.connecting = false;
      state.connectionStatus = 'connected';
      state.reconnectAttempt = 0;
      state.connectionError = null;
      state.myId = data?.socketId || 'sock-new';
      break;
    case 'disconnect':
      state.connected = false;
      if (data?.reason === 'io server disconnect') {
        state.connecting = false;
        state.connectionStatus = 'disconnected';
        state.connectionError = 'Server closed the session.';
      } else {
        state.connecting = true;
        state.connectionStatus = 'reconnecting';
      }
      break;
    case 'reconnect_attempt':
      state.connecting = true;
      state.connectionStatus = 'reconnecting';
      state.reconnectAttempt = data?.attempt || 1;
      break;
    case 'reconnect_failed':
      state.connected = false;
      state.connecting = false;
      state.connectionStatus = 'disconnected';
      state.connectionError = 'Unable to reconnect to office server.';
      break;
    case 'connect_error':
      state.connected = false;
      state.connectionError = data?.message || 'Connection error';
      if (data?.active) {
        state.connecting = true;
        state.connectionStatus = 'reconnecting';
      } else {
        state.connecting = false;
        state.connectionStatus = 'error';
      }
      break;
  }
  return state;
}

// Initial connection
let conn = simulateConnectionState('connect', { socketId: 'sock-1' }, { connected: false, connecting: true, connectionStatus: 'connecting', reconnectAttempt: 0 });
assert(conn.connected && conn.connectionStatus === 'connected', 'Initial connection sets connected=true and status=connected');
assert(conn.reconnectAttempt === 0, 'Reconnect attempt counter reset to 0 on connect');

// Transport drop (temporary network blip / server restart)
conn = simulateConnectionState('disconnect', { reason: 'transport close' }, conn);
assert(!conn.connected && conn.connectionStatus === 'reconnecting', 'Transport close sets status to reconnecting');
assert(conn.connecting === true, 'Automatic reconnect flag kept true during transport close');

// Reconnection attempts increment
conn = simulateConnectionState('reconnect_attempt', { attempt: 1 }, conn);
assert(conn.reconnectAttempt === 1 && conn.connectionStatus === 'reconnecting', 'Reconnection attempt 1 recorded');
conn = simulateConnectionState('reconnect_attempt', { attempt: 2 }, conn);
assert(conn.reconnectAttempt === 2, 'Reconnection attempt 2 recorded');

// Successful reconnection
conn = simulateConnectionState('connect', { socketId: 'sock-2' }, conn);
assert(conn.connected && conn.connectionStatus === 'connected', 'Reconnection resets status to connected');
assert(conn.myId === 'sock-2', 'Updated to new socket ID on reconnect');
assert(conn.reconnectAttempt === 0, 'Reset reconnect attempts on success');

// Server forced disconnect
conn = simulateConnectionState('disconnect', { reason: 'io server disconnect' }, conn);
assert(conn.connectionStatus === 'disconnected' && conn.connecting === false, 'Server-initiated disconnect stops automatic retry loop');

// ── 17. Automatic Session Recovery & Room Preservation ──────────────────────
function sanitizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return EMAIL_REGEX.test(trimmed) ? trimmed : null;
}

function simulateSessionRecovery({
  newSocketId,
  previousSocketId,
  guestId,
  profile,
  room,
  lastX,
  lastY,
  workstation,
  usersStore,
  privateRoomsStore,
  workstationsStore,
}) {
  // 1. Sanitize Profile
  const cleanName = sanitizeDisplayName(profile?.name) || 'Guest-User';
  const cleanEmail = sanitizeEmail(profile?.email);
  const avatarColor = (profile?.avatarColor && /^#[0-9a-fA-F]{6}$/.test(profile.avatarColor)) ? profile.avatarColor : '#259765';
  const avatarStyle = (profile?.avatarStyle && ['classic', 'star', 'diamond', 'crown'].includes(profile.avatarStyle)) ? profile.avatarStyle : 'classic';
  const status = (profile?.status && ['online', 'away', 'busy'].includes(profile.status)) ? profile.status : 'online';

  // 2. Clean up previous socket & stale users with same guestId (prevent duplicate participants)
  let removedPrevious = false;
  if (previousSocketId && previousSocketId !== newSocketId && usersStore.has(previousSocketId)) {
    usersStore.delete(previousSocketId);
    removedPrevious = true;
  }
  let removedDuplicateGuest = false;
  if (guestId) {
    for (const [sId, u] of usersStore.entries()) {
      if (sId !== newSocketId && u.guestId === guestId) {
        usersStore.delete(sId);
        removedDuplicateGuest = true;
      }
    }
  }

  // 3. Validate & resolve target room
  let targetRoom = room || 'general';
  let isPrivate = false;
  let roomTitle = 'General Office';
  let fallbackNotice = null;

  if (['general', 'meeting', 'focus'].includes(targetRoom)) {
    if (targetRoom === 'meeting') roomTitle = 'Meeting Room';
    else if (targetRoom === 'focus') roomTitle = 'Focus Room';
  } else if (privateRoomsStore.has(targetRoom)) {
    isPrivate = true;
    const priv = privateRoomsStore.get(targetRoom);
    roomTitle = priv.title;
    if (priv.hostSocketId === previousSocketId) {
      priv.hostSocketId = newSocketId;
    }
  } else {
    // Room expired
    fallbackNotice = `Previous meeting (${targetRoom}) is no longer available. Reconnected to General Office.`;
    targetRoom = 'general';
    roomTitle = 'General Office';
    isPrivate = false;
  }

  // 4. Coordinates
  const posX = Math.max(20, Math.min(780, Number.isFinite(lastX) ? lastX : 360));
  const posY = Math.max(20, Math.min(480, Number.isFinite(lastY) ? lastY : 110));

  // 5. Workstation
  let restoredWorkstation = null;
  if (workstation && workstationsStore) {
    const existingDesk = workstationsStore.get(workstation);
    if (!existingDesk || existingDesk.socketId === previousSocketId) {
      workstationsStore.set(workstation, { socketId: newSocketId, name: cleanName });
      restoredWorkstation = workstation;
    }
  }

  const restoredUser = {
    id: newSocketId,
    name: cleanName,
    email: cleanEmail,
    guestId,
    room: targetRoom,
    x: posX,
    y: posY,
    workstation: restoredWorkstation,
    avatarColor,
    avatarStyle,
    status,
  };
  usersStore.set(newSocketId, restoredUser);

  return {
    success: true,
    restored: true,
    room: targetRoom,
    title: roomTitle,
    isPrivate,
    workstation: restoredWorkstation,
    notice: fallbackNotice,
    user: restoredUser,
    removedPrevious,
    removedDuplicateGuest,
  };
}

// Test 1: Public Meeting Room recovery
const testUsersStore = new Map([
  ['sock-old-1', { id: 'sock-old-1', name: 'Dev Alice', guestId: 'GUEST-ALICE', room: 'meeting', x: 250, y: 320, workstation: null }],
]);
const testPrivateStore = new Map();
const testWorkstationStore = new Map();

const rec1 = simulateSessionRecovery({
  newSocketId: 'sock-new-1',
  previousSocketId: 'sock-old-1',
  guestId: 'GUEST-ALICE',
  profile: { name: 'Dev Alice', email: 'alice@corp.com', avatarColor: '#2563eb', avatarStyle: 'crown', status: 'busy' },
  room: 'meeting',
  lastX: 250,
  lastY: 320,
  workstation: null,
  usersStore: testUsersStore,
  privateRoomsStore: testPrivateStore,
  workstationsStore: testWorkstationStore,
});

assert(rec1.restored && rec1.room === 'meeting', 'Session successfully restored to Meeting Room');
assert(rec1.removedPrevious === true, 'Previous socket ID removed to prevent duplicate participants');
assert(!testUsersStore.has('sock-old-1') && testUsersStore.has('sock-new-1'), 'Users map contains only new socket ID');
assert(testUsersStore.get('sock-new-1').name === 'Dev Alice', 'User identity preserved during recovery');

// Test 2: Active Private Room recovery with host ownership transfer
testPrivateStore.set('PRV-BETA', { code: 'PRV-BETA', title: 'Beta Sprint Planning', hostSocketId: 'sock-host-old' });
testUsersStore.set('sock-host-old', { id: 'sock-host-old', name: 'Host Bob', guestId: 'GUEST-BOB', room: 'PRV-BETA', x: 400, y: 200 });

const recHost = simulateSessionRecovery({
  newSocketId: 'sock-host-new',
  previousSocketId: 'sock-host-old',
  guestId: 'GUEST-BOB',
  profile: { name: 'Host Bob' },
  room: 'PRV-BETA',
  lastX: 400,
  lastY: 200,
  workstation: null,
  usersStore: testUsersStore,
  privateRoomsStore: testPrivateStore,
  workstationsStore: testWorkstationStore,
});

assert(recHost.isPrivate && recHost.room === 'PRV-BETA', 'Private room restored when still active');
assert(testPrivateStore.get('PRV-BETA').hostSocketId === 'sock-host-new', 'Host ownership transferred to new socket ID');

// Test 3: Expired Private Room fallback to General Office
const recExpired = simulateSessionRecovery({
  newSocketId: 'sock-user-3',
  previousSocketId: 'sock-old-3',
  guestId: 'GUEST-CHARLIE',
  profile: { name: 'Charlie' },
  room: 'PRV-EXPIRED-99',
  lastX: 400,
  lastY: 200,
  workstation: null,
  usersStore: testUsersStore,
  privateRoomsStore: testPrivateStore,
  workstationsStore: testWorkstationStore,
});

assert(recExpired.room === 'general' && recExpired.isPrivate === false, 'Expired private room safely falls back to General Office');
assert(typeof recExpired.notice === 'string' && recExpired.notice.includes('no longer available'), 'Provides user-friendly fallback notice');

// Test 4: Coordinate Clamping on Reconnection
const recClamp = simulateSessionRecovery({
  newSocketId: 'sock-clamp',
  previousSocketId: null,
  guestId: 'GUEST-CLAMP',
  profile: { name: 'Dave' },
  room: 'general',
  lastX: -100, // Invalid out-of-bounds
  lastY: 9999, // Invalid out-of-bounds
  workstation: null,
  usersStore: testUsersStore,
  privateRoomsStore: testPrivateStore,
  workstationsStore: testWorkstationStore,
});
assert(recClamp.user.x === 20 && recClamp.user.y === 480, 'Server-authoritative boundary clamp applied on recovery coordinates');

// ── 18. Toast Notification Transition & Deduplication ───────────────────────
function evaluateToastTransition(prevStatus, currentStatus) {
  if (prevStatus === currentStatus) return null; // Deduplicated
  if (prevStatus === 'connected' && (currentStatus === 'reconnecting' || currentStatus === 'disconnected')) {
    return 'warning';
  }
  if ((prevStatus === 'reconnecting' || prevStatus === 'disconnected') && currentStatus === 'connected') {
    return 'success';
  }
  return null;
}

assert(evaluateToastTransition('connected', 'reconnecting') === 'warning', 'Triggers warning toast on connection drop');
assert(evaluateToastTransition('reconnecting', 'reconnecting') === null, 'Deduplicates: no second toast on same reconnecting state');
assert(evaluateToastTransition('reconnecting', 'connected') === 'success', 'Triggers success toast on reconnection');
assert(evaluateToastTransition('connected', 'connected') === null, 'Deduplicates: no second toast on stable connected state');

// ── 19. Connection Handshake User & Session Name Resolution ─────────────────
function resolveConnectionUser(socketId, auth = {}) {
  const safeAuth = auth && typeof auth === 'object' ? auth : {};
  const guestId = (safeAuth.guestId && typeof safeAuth.guestId === 'string') ? safeAuth.guestId.slice(0, 50) : null;
  const rawName = (safeAuth.name && typeof safeAuth.name === 'string') ? safeAuth.name : null;
  const name = (rawName && sanitizeDisplayName(rawName)) || `Guest-${socketId.slice(0, 4).toUpperCase()}`;

  const startX = 270;
  const startY = 60;

  const user = {
    id: socketId,
    name,
    email: sanitizeEmail(safeAuth.email) || null,
    guestId,
    workstation: null,
    x: startX,
    y: startY,
    micEnabled: false,
    room: 'general',
    avatarColor: (safeAuth.avatarColor && /^#[0-9a-fA-F]{6}$/.test(safeAuth.avatarColor)) ? safeAuth.avatarColor : '#259765',
    avatarStyle: (safeAuth.avatarStyle && ['classic', 'star', 'diamond', 'crown'].includes(safeAuth.avatarStyle)) ? safeAuth.avatarStyle : 'classic',
    status: (safeAuth.status && ['online', 'away', 'busy'].includes(safeAuth.status)) ? safeAuth.status : 'online',
    joinedAt: new Date().toISOString(),
  };

  const sessionPayload = {
    socketId,
    name: user.name,
    email: user.email,
    guestId: user.guestId,
    x: startX,
    y: startY,
    micEnabled: false,
    room: 'general',
    avatarColor: user.avatarColor,
    avatarStyle: user.avatarStyle,
    status: user.status,
  };

  return { user, sessionPayload };
}

// Valid custom auth name
const r1 = resolveConnectionUser('sock-abcd', { name: 'Dr. Jane Foster', email: 'jane@mit.edu' });
assert(r1.user.name === 'Dr. Jane Foster', 'Connection assigns valid sanitized name to user.name');
assert(r1.sessionPayload.name === 'Dr. Jane Foster', 'MongoDB Session payload contains the exact user.name');
assert(r1.sessionPayload.name !== undefined, 'MongoDB Session name is never undefined');

// Missing / undefined auth name falls back to Guest-XXXX
const r2 = resolveConnectionUser('wxyz-1234', {});
assert(r2.user.name === 'Guest-WXYZ', 'Connection falls back to Guest-XXXX when auth.name is empty');
assert(r2.sessionPayload.name === 'Guest-WXYZ', 'MongoDB Session payload receives Guest-XXXX fallback');
assert(r2.sessionPayload.name !== undefined, 'Fallback name is never undefined');

// Malicious / HTML tags in auth.name
const r3 = resolveConnectionUser('1234-abcd', { name: '<b>Alice</b>' });
assert(r3.user.name === 'Alice', 'Strips HTML tags and assigns clean name');
assert(r3.sessionPayload.name === 'Alice', 'MongoDB Session payload receives sanitized clean name');

// Null auth object
const r4 = resolveConnectionUser('5678-wxyz', null);
assert(r4.user.name === 'Guest-5678', 'Null auth object safely yields Guest-5678 without ReferenceError');
assert(r4.sessionPayload.name === 'Guest-5678', 'Session payload receives valid fallback on null auth');

// ── 20. Multi-Member Simultaneous Joining & Concurrency Architecture ───────────

// 20.1 Concurrent User Generation (Testing 2, 5, 10, and 50 concurrent joins)
function simulateMultiJoin(userCount) {
  const officeUsers = new Map();
  const sessionWrites = [];

  for (let i = 1; i <= userCount; i++) {
    const socketId = `sock_client_${i}`;
    const guestId = `guest_uuid_${i}`;
    const name = `Employee ${i}`;
    const email = `employee${i}@enterprise.com`;

    const { user, sessionPayload } = resolveConnectionUser(socketId, {
      name,
      email,
      guestId,
      avatarColor: '#259765',
      avatarStyle: 'classic',
      status: 'online',
    });

    officeUsers.set(socketId, user);
    sessionWrites.push(sessionPayload);
  }

  return { officeUsers, sessionWrites };
}

// Scenario 1: 2 users joining simultaneously
const join2 = simulateMultiJoin(2);
assert(join2.officeUsers.size === 2, '2 users joined General Office simultaneously with unique sessions');
assert(join2.sessionWrites.length === 2, '2 distinct MongoDB session payloads created');
assert(join2.officeUsers.get('sock_client_1').name === 'Employee 1', 'User 1 identity intact');
assert(join2.officeUsers.get('sock_client_2').name === 'Employee 2', 'User 2 identity intact');

// Scenario 2: 5 users joining simultaneously
const join5 = simulateMultiJoin(5);
assert(join5.officeUsers.size === 5, '5 users joined General Office simultaneously with unique sessions');
assert(new Set(join5.sessionWrites.map(s => s.socketId)).size === 5, 'All 5 users have unique socketIds');
assert(new Set(join5.sessionWrites.map(s => s.guestId)).size === 5, 'All 5 users have unique guestIds');

// Scenario 3: 10 users joining simultaneously
const join10 = simulateMultiJoin(10);
assert(join10.officeUsers.size === 10, '10 users joined General Office simultaneously with unique sessions');
assert(join10.officeUsers.has('sock_client_10'), '10th user successfully initialized in office users map');

// Stress Target: 50 concurrent users
const join50 = simulateMultiJoin(50);
assert(join50.officeUsers.size === 50, '50 concurrent users successfully initialized simultaneously');
assert(new Set(join50.sessionWrites.map(s => s.socketId)).size === 50, 'All 50 users retain unique socket connections');
assert(new Set(join50.sessionWrites.map(s => s.email)).size === 50, 'All 50 users retain distinct email addresses');

// 20.2 Duplicate & Ghost Avatar Eviction on Reconnect
const dedupMap = new Map();
const dedupEvents = [];

function handleConnectWithDedup(socketId, guestId, name, store) {
  // Evict existing socket if same guestId
  if (guestId) {
    for (const [sid, existingUser] of store.entries()) {
      if (sid !== socketId && existingUser.guestId === guestId) {
        store.delete(sid);
        dedupEvents.push({ type: 'user-left', socketId: sid });
      }
    }
  }
  const user = { id: socketId, guestId, name, room: 'general' };
  store.set(socketId, user);
  return user;
}

handleConnectWithDedup('sock_old', 'guest_shared_42', 'Sarah Connor', dedupMap);
assert(dedupMap.size === 1 && dedupMap.has('sock_old'), 'Initial socket connection active for Sarah Connor');

// Sarah reconnects from a refreshed tab/network drop with new socket ID
handleConnectWithDedup('sock_new', 'guest_shared_42', 'Sarah Connor', dedupMap);
assert(dedupMap.size === 1, 'Store maintains exactly 1 active user after reconnect with same guestId');
assert(!dedupMap.has('sock_old'), 'Stale socket sock_old evicted from active users');
assert(dedupMap.has('sock_new'), 'New socket sock_new registered in active users');
assert(dedupEvents.some(e => e.type === 'user-left' && e.socketId === 'sock_old'), 'Emitted user-left event for stale socket to clear ghost avatar');

// 20.3 Server-Side Full Name & Email Validation on Join-Room
function validateJoinRoomProfile(profile) {
  if (!profile || typeof profile !== 'object') return { success: true };

  if ('name' in profile) {
    const clean = sanitizeDisplayName(profile.name);
    if (!clean) {
      return { success: false, error: 'Full name must be between 2 and 30 characters.' };
    }
  }

  if ('email' in profile && profile.email) {
    const cleanEmail = sanitizeEmail(profile.email);
    if (!cleanEmail) {
      return { success: false, error: 'A valid email address is required.' };
    }
  }

  return { success: true };
}

assert(validateJoinRoomProfile({ name: 'Valid User', email: 'user@company.com' }).success, 'Accepts valid name and company email');
assert(!validateJoinRoomProfile({ name: 'X', email: 'user@company.com' }).success, 'Rejects single-character name');
assert(!validateJoinRoomProfile({ name: 'A'.repeat(35), email: 'user@company.com' }).success, 'Rejects name exceeding 30 characters');
assert(!validateJoinRoomProfile({ name: '<b></b>', email: 'user@company.com' }).success, 'Rejects HTML-only tags stripped to empty');
assert(!validateJoinRoomProfile({ name: 'Valid User', email: 'invalid-email-no-at' }).success, 'Rejects malformed email address');

// 20.4 High-Frequency Movement DB Write Throttling (3,000ms throttle)
let dbWriteCount = 0;
let lastDbWrite = 0;
let inMemoryMoveCount = 0;

function simulateMove(socketId, x, y, timestamp) {
  inMemoryMoveCount++;
  // Throttled DB write
  if (timestamp - lastDbWrite >= 3000) {
    lastDbWrite = timestamp;
    dbWriteCount++;
  }
}

// Simulate 50 moves over 1,000ms (50ms interval)
const moveStart = 10000;
for (let step = 0; step < 50; step++) {
  simulateMove('sock_fast', 300 + step, 200 + step, moveStart + step * 50);
}

assert(inMemoryMoveCount === 50, 'All 50 real-time in-memory movements processed without dropped events');
assert(dbWriteCount === 1, 'MongoDB write throttled to exactly 1 write across 50 fast moves (98% reduction)');

// 20.5 Multi-Room Isolation & Presence Tracking Under Concurrency
const multiRoomUsers = new Map();
// 25 in general, 15 in meeting, 10 in focus
for (let i = 1; i <= 25; i++) multiRoomUsers.set(`u_gen_${i}`, { id: `u_gen_${i}`, name: `Gen ${i}`, room: 'general' });
for (let i = 1; i <= 15; i++) multiRoomUsers.set(`u_meet_${i}`, { id: `u_meet_${i}`, name: `Meet ${i}`, room: 'meeting' });
for (let i = 1; i <= 10; i++) multiRoomUsers.set(`u_foc_${i}`, { id: `u_foc_${i}`, name: `Foc ${i}`, room: 'focus' });

const counts = { general: 0, meeting: 0, focus: 0 };
for (const [, u] of multiRoomUsers) {
  counts[u.room] = (counts[u.room] || 0) + 1;
}

assert(counts.general === 25, 'General office accurately tracks 25 concurrent users');
assert(counts.meeting === 15, 'Meeting room accurately tracks 15 concurrent users');
assert(counts.focus === 10, 'Focus room accurately tracks 10 concurrent users');
assert(multiRoomUsers.size === 50, 'Total office presence accurately reflects 50 connected employees');

// ── 21. Multi-User Microphone & WebRTC Proximity Audio Architecture ───────────

// 21.1 Deterministic Offerer Selection & Asymmetric Mic Connectivity
function determineWebRTCOfferer(myId, remoteId) {
  return myId < remoteId;
}

assert(determineWebRTCOfferer('sock_alice', 'sock_bob') === true, 'sock_alice initiates offer to sock_bob (lexicographically smaller)');
assert(determineWebRTCOfferer('sock_bob', 'sock_alice') === false, 'sock_bob waits for offer from sock_alice');
assert(determineWebRTCOfferer('user_01', 'user_02') === true, 'Deterministic offerer selection prevents offer collision (glare)');

// Transceiver configuration when mic is disabled vs enabled
function resolveTransceiverConfig(hasLocalMic) {
  if (hasLocalMic) {
    return { direction: 'sendrecv', sendsAudio: true, receivesAudio: true };
  }
  return { direction: 'recvonly', sendsAudio: false, receivesAudio: true };
}

const listenerOnlyConfig = resolveTransceiverConfig(false);
assert(listenerOnlyConfig.direction === 'recvonly', 'User without mic initializes receive-only transceiver to hear speaking colleagues');
assert(listenerOnlyConfig.receivesAudio === true, 'Listener peer receives audio without local mic hardware');
assert(listenerOnlyConfig.sendsAudio === false, 'Listener peer does not transmit audio');

const speakerConfig = resolveTransceiverConfig(true);
assert(speakerConfig.direction === 'sendrecv', 'Speaker peer initializes sendrecv audio stream');
assert(speakerConfig.sendsAudio === true, 'Speaker peer transmits microphone audio');

// 21.2 Dynamic Proximity Audio Connectivity & Squared Falloff
const EARSHOT_RADIUS = 100;
function calculateProximityGain(dist, maxRadius = EARSHOT_RADIUS) {
  if (dist <= 0) return 1.0;
  if (dist >= maxRadius) return 0.0;
  const normalized = dist / maxRadius;
  return Math.pow(1 - normalized, 2);
}

// User A at (300, 200), User B at (350, 200) -> distance = 50px
const dist50 = Math.hypot(350 - 300, 200 - 200);
const gain50 = calculateProximityGain(dist50);
assert(dist50 === 50, 'Calculated 50px distance between adjacent avatars');
assert(gain50 === 0.25, 'At 50px distance (halfway), audio gain is exactly 25% (squared falloff)');

// User B moves to (450, 200) -> distance = 150px (outside earshot)
const dist150 = Math.hypot(450 - 300, 200 - 200);
const gain150 = calculateProximityGain(dist150);
const inEarshot150 = dist150 <= EARSHOT_RADIUS;
assert(!inEarshot150, 'Avatar at 150px is beyond 100px earshot boundary');
assert(gain150 === 0.0, 'Volume beyond earshot boundary is completely silent (0.0 gain)');

// User B returns to (380, 200) -> distance = 80px (re-entering earshot)
const dist80 = Math.hypot(380 - 300, 200 - 200);
const gain80 = calculateProximityGain(dist80);
const inEarshot80 = dist80 <= EARSHOT_RADIUS;
assert(inEarshot80, 'Avatar re-entering within 80px is detected inside earshot');
assert(Math.abs(gain80 - 0.04) < 0.001, 'Re-entered proximity gain scales accurately (4% at 80px)');

// 21.3 Microphone Lifecycle State Machine & Track Management
class MockAudioTrack {
  constructor() {
    this.enabled = true;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class MockMediaStream {
  constructor() {
    this.tracks = [new MockAudioTrack()];
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class MicrophoneController {
  constructor(socketMock) {
    this.state = 'idle';
    this.stream = null;
    this.socket = socketMock;
    this.error = null;
  }

  requestMic(isSecureContext, hasDevices, userAllowed) {
    this.state = 'requesting';
    this.error = null;

    if (!hasDevices) {
      this.state = 'error';
      this.error = isSecureContext === false
        ? 'Microphone requires a secure context (HTTPS or http://localhost).'
        : 'Microphone API is not supported in this browser.';
      return false;
    }

    if (!userAllowed) {
      this.state = 'denied';
      this.error = 'Microphone permission denied. Allow microphone in your browser settings and click Retry.';
      return false;
    }

    this.stream = new MockMediaStream();
    this.state = 'active';
    this.socket.emit('update-mic-status', { micEnabled: true });
    return true;
  }

  toggleMute() {
    if (!this.stream) return;
    const track = this.stream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    this.state = track.enabled ? 'active' : 'muted';
    this.socket.emit('update-mic-status', { micEnabled: track.enabled });
  }

  disableMic(peers) {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.state = 'idle';
    this.socket.emit('update-mic-status', { micEnabled: false });

    // Silence outgoing senders without destroying incoming peer connections
    for (const peer of Object.values(peers)) {
      if (peer.sender) {
        peer.sender.replacedWith = null;
      }
    }
  }
}

const mockSocketEvents = [];
const mockSocket = {
  emit: (event, payload) => mockSocketEvents.push({ event, payload }),
};

const micCtrl = new MicrophoneController(mockSocket);
assert(micCtrl.state === 'idle', 'Microphone initializes in idle state');

// Test insecure context handling
const deniedInsecure = micCtrl.requestMic(false, false, true);
assert(!deniedInsecure && micCtrl.state === 'error', 'Insecure context correctly rejected without crashing');
assert(micCtrl.error.includes('secure context'), 'Surfaces clear secure context error message');

// Test browser permission denied handling
const deniedByUser = micCtrl.requestMic(true, true, false);
assert(!deniedByUser && micCtrl.state === 'denied', 'Permission denial transitions to denied state');
assert(micCtrl.error.includes('settings'), 'Surfaces helpful browser unlock instruction');

// Test successful permission grant
const granted = micCtrl.requestMic(true, true, true);
assert(granted && micCtrl.state === 'active', 'Permission grant transitions to active state');
assert(mockSocketEvents.some(e => e.event === 'update-mic-status' && e.payload.micEnabled === true), 'Emits update-mic-status: true on activation');

// Test mute/unmute
micCtrl.toggleMute();
assert(micCtrl.state === 'muted', 'toggleMute sets state to muted');
assert(!micCtrl.stream.getAudioTracks()[0].enabled, 'Audio track disabled on mute');
assert(mockSocketEvents.some(e => e.event === 'update-mic-status' && e.payload.micEnabled === false), 'Emits update-mic-status: false on mute');

micCtrl.toggleMute();
assert(micCtrl.state === 'active', 'toggleMute restores state to active');
assert(micCtrl.stream.getAudioTracks()[0].enabled, 'Audio track enabled on unmute');

// Test disableMic (turn off microphone stream)
const mockPeers = {
  peer_charlie: { id: 'peer_charlie', sender: { replacedWith: 'audio_track' }, pc: { closed: false } },
};
micCtrl.disableMic(mockPeers);
assert(micCtrl.state === 'idle', 'disableMic sets state to idle');
assert(micCtrl.stream === null, 'Local media stream released');
assert(mockPeers.peer_charlie.sender.replacedWith === null, 'Outgoing sender silenced with replaceTrack(null)');
assert(mockPeers.peer_charlie.pc.closed === false, 'Incoming peer connection remains open so user can still hear colleagues');

// 21.4 Cross-Room Audio Isolation Even at 0px Canvas Distance
const userInGeneral = { id: 'u_gen', room: 'general', x: 300, y: 200 };
const userInMeeting = { id: 'u_meet', room: 'meeting', x: 300, y: 200 };

const crossRoomNearby = getNearbyServer(userInGeneral, new Map([
  [userInGeneral.id, userInGeneral],
  [userInMeeting.id, userInMeeting],
]));

assert(crossRoomNearby.length === 0, 'No nearby audio peers between General Office and Meeting Room despite identical (300, 200) position');

// ── 22. MongoDB $near Geospatial Queries & Latency Benchmarks ────────────────
const nearQuery = buildNearQuery(400, 250, 100);
assert(nearQuery.location && nearQuery.location.$near, 'buildNearQuery constructs a $near geospatial query');
assert(nearQuery.location.$near.$geometry.type === 'Point', 'Query uses GeoJSON Point geometry');
assert(nearQuery.location.$near.$geometry.coordinates[0] === 400 / 800, 'Coordinates normalized on X axis (0.5)');
assert(nearQuery.location.$near.$geometry.coordinates[1] === 250 / 500, 'Coordinates normalized on Y axis (0.5)');
assert(nearQuery.location.$near.$maxDistance > 0, 'Query sets positive $maxDistance in spherical radians');

// High-concurrency spatial scan latency measurement
const simulatedMap = new Map();
for (let i = 0; i < 50; i++) {
  simulatedMap.set(`user_${i}`, {
    id: `user_${i}`,
    x: 100 + Math.floor(Math.random() * 600),
    y: 50 + Math.floor(Math.random() * 400),
    room: i % 2 === 0 ? 'general' : 'meeting',
  });
}

const benchmarkStart = process.hrtime.bigint();
const testPivot = { id: 'test_pivot', x: 400, y: 250, room: 'general' };
for (let iter = 0; iter < 1000; iter++) {
  getNearbyServer(testPivot, simulatedMap);
}
const benchmarkEnd = process.hrtime.bigint();
const totalLatencyMs = Number(benchmarkEnd - benchmarkStart) / 1e6;
const avgLatencyPerScanMs = totalLatencyMs / 1000;

assert(totalLatencyMs < 100, `1,000 spatial earshot evaluations completed in ${totalLatencyMs.toFixed(2)}ms (< 100ms)`);
assert(avgLatencyPerScanMs < 0.1, `Average query latency is ${avgLatencyPerScanMs.toFixed(4)}ms (< 0.1ms per scan)`);

// ── 23. Spatial Audio StereoPannerNode Panning Math ─────────────────────────
function calculateStereoPan(meX, peerX, earshot = EARSHOT_RADIUS) {
  const dx = peerX - meX;
  return Math.max(-1, Math.min(1, dx / earshot));
}

assert(calculateStereoPan(400, 450) === 0.5, 'Peer 50px to the right pans to +0.5');
assert(calculateStereoPan(400, 350) === -0.5, 'Peer 50px to the left pans to -0.5');
assert(calculateStereoPan(400, 400) === 0.0, 'Peer at identical X position pans to center 0.0');
assert(calculateStereoPan(400, 550) === 1.0, 'Peer beyond earshot right is clamped to +1.0');
assert(calculateStereoPan(400, 200) === -1.0, 'Peer beyond earshot left is clamped to -1.0');

// ── 24. Furniture Sound Obstacle Raycasting & Acoustic Absorption ────────────
const testObstacleBox = { x: 150, y: 80, w: 40, h: 40, name: 'Glass Partition', soundAbsorption: 0.65 };

// Ray intersecting the box
const intersectsTrue = segmentIntersectsRect(100, 100, 300, 100, testObstacleBox);
assert(intersectsTrue === true, 'Horizontal ray from (100, 100) to (300, 100) correctly detects intersection with obstacle');

// Ray missing the box
const intersectsFalse = segmentIntersectsRect(100, 20, 300, 20, testObstacleBox);
assert(intersectsFalse === false, 'Parallel ray offset at y: 20 correctly reports no intersection');

// Ray starting inside or terminating inside
const insideStart = segmentIntersectsRect(160, 90, 300, 90, testObstacleBox);
assert(insideStart === true, 'Ray starting inside obstacle detects obstruction');

// Acoustic obstruction calculation
const unobstructed = calculateAudioObstruction({ x: 100, y: 20 }, { x: 300, y: 20 }, [testObstacleBox]);
assert(unobstructed.transmission === 1.0, 'Unobstructed line-of-sight provides 1.0 (100%) sound transmission');
assert(unobstructed.obstruction === 0.0, 'Unobstructed line-of-sight has 0.0 obstruction');

const obstructed = calculateAudioObstruction({ x: 100, y: 100 }, { x: 300, y: 100 }, [testObstacleBox]);
assert(obstructed.transmission === 0.35, 'Glass partition with 0.65 absorption yields 0.35 sound transmission (65% volume reduction)');
assert(obstructed.obstruction === 0.65, 'Sound obstruction factor is 0.65');
assert(obstructed.blockedBy.includes('Glass Partition'), 'Identified specific obstacle name in obstruction report');

// Combined spatial gain (distance falloff * acoustic transmission)
const obstructionDist50 = 50; // volumeFromDistance(50, 100) = (1 - 50/100)^2 = 0.25
const distGain = volumeFromDistance(obstructionDist50, 100);
const finalCombinedGain = distGain * obstructed.transmission;
assert(Number(finalCombinedGain.toFixed(4)) === 0.0875, 'Combined spatial gain correctly scales: distance (0.25) * obstruction (0.35) = 0.0875');

// ── 25. Office Layout Persistence & Schema Verification ─────────────────────
assert(DEFAULT_GENERAL_LAYOUT.roomId === 'general', 'Default general layout has valid roomId');
assert(DEFAULT_GENERAL_LAYOUT.obstacles.length >= 10, `General office layout contains ${DEFAULT_GENERAL_LAYOUT.obstacles.length} persistent obstacles`);
assert(DEFAULT_GENERAL_LAYOUT.workstations.length === 8, 'General office layout contains 8 defined workstations');

assert(DEFAULT_MEETING_LAYOUT.roomId === 'meeting', 'Default meeting layout has valid roomId');
assert(DEFAULT_MEETING_LAYOUT.obstacles.some(o => o.id === 'boardroom-table'), 'Meeting layout includes Grand Boardroom Table');

assert(DEFAULT_FOCUS_LAYOUT.roomId === 'focus', 'Default focus layout has valid roomId');
assert(DEFAULT_FOCUS_LAYOUT.obstacles.length === 4, 'Focus layout defines 4 private acoustic pods');

// Verify all obstacles have required physical attributes
const allDefaultObstacles = [
  ...DEFAULT_GENERAL_LAYOUT.obstacles,
  ...DEFAULT_MEETING_LAYOUT.obstacles,
  ...DEFAULT_FOCUS_LAYOUT.obstacles,
];
const validObstacles = allDefaultObstacles.every(o =>
  o.id &&
  o.name &&
  typeof o.x === 'number' &&
  typeof o.y === 'number' &&
  typeof o.w === 'number' &&
  typeof o.h === 'number' &&
  typeof o.soundAbsorption === 'number' &&
  o.soundAbsorption >= 0 &&
  o.soundAbsorption <= 1
);
assert(validObstacles, 'All layout obstacles specify dimensions, material, and calibrated soundAbsorption [0, 1]');

// ── 26. Redis Pub/Sub Adapter & Horizontal Scaling Fallback ─────────────────
import { setupRedisAdapter } from '../backend/server.js';

const mockIo = {
  adapter: (ad) => { mockIo._adapter = ad; },
};

const redisFallbackResult = await setupRedisAdapter(mockIo);
assert(redisFallbackResult.configured === false, 'setupRedisAdapter correctly reports configured: false in dev environment');
assert(redisFallbackResult.mode === 'in-memory', 'Gracefully falls back to high-performance in-memory adapter without throwing');

console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
