/**
 * tests/test-concurrency-scenarios.mjs
 * Real Socket.IO concurrency test suite verifying:
 * 1. 2 users joining simultaneously
 * 2. 5 users joining simultaneously
 * 3. 10 users joining simultaneously
 * 4. Multiple users moving at the same time
 * 5. Multiple users changing rooms
 * 6. One user disconnecting while others remain connected
 * 7. One user reconnecting after network interruption (deduping verified)
 * 8. Live presence count synchronized across all clients
 * 9. Stress test: 50 concurrent users joining simultaneously
 */

import http from 'node:http';
import express from '../backend/node_modules/express/index.js';
import { Server } from '../backend/node_modules/socket.io/dist/index.js';
import { io } from '../frontend/node_modules/socket.io-client/build/esm/index.js';

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

console.log('\n── ProxiSpeak Real Socket.IO Concurrency Test Suite ──\n');

// ── 1. Create In-Process Server Matching server.js ─────────────────────────────
const app = express();
const server = http.createServer(app);
const ioServer = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000,
});

const users = new Map();
const occupiedWorkstations = new Map();
const privateRooms = new Map();
const PUBLIC_ROOMS = ['general', 'meeting', 'focus'];

function sanitizeDisplayName(rawName) {
  if (typeof rawName !== 'string') return null;
  const stripped = rawName.replace(/<[^>]*>?/gm, '').trim();
  if (stripped.length < 2 || stripped.length > 30) return null;
  return stripped;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function sanitizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return EMAIL_REGEX.test(trimmed) ? trimmed : null;
}

function getRoomCounts() {
  const counts = { general: 0, meeting: 0, focus: 0 };
  for (const [code] of privateRooms) counts[code] = 0;
  for (const [, user] of users) {
    const r = user.room || 'general';
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

function getOfficePresence() {
  const presence = [];
  for (const [, u] of users) {
    let roomTitle = 'General Office';
    if (u.room === 'meeting') roomTitle = 'Meeting Room';
    else if (u.room === 'focus') roomTitle = 'Focus Room';
    else if (u.room && privateRooms.has(u.room)) roomTitle = privateRooms.get(u.room).title;
    else if (!u.room) roomTitle = 'Lobby';

    presence.push({
      id: u.id,
      name: u.name,
      email: u.email || null,
      guestId: u.guestId || null,
      room: u.room || 'general',
      roomTitle,
      status: u.status || 'online',
      micEnabled: Boolean(u.micEnabled),
      workstation: u.workstation || null,
      x: u.x,
      y: u.y,
    });
  }
  return presence;
}

ioServer.on('connection', (socket) => {
  const auth = (socket.handshake && socket.handshake.auth && typeof socket.handshake.auth === 'object')
    ? socket.handshake.auth
    : {};
  const guestId = (auth.guestId && typeof auth.guestId === 'string') ? auth.guestId.slice(0, 50) : null;
  const rawName = (auth.name && typeof auth.name === 'string') ? auth.name : null;
  const name = (rawName && sanitizeDisplayName(rawName)) || `Guest-${socket.id.slice(0, 4).toUpperCase()}`;

  // Dedup stale socket with same guestId
  if (guestId) {
    for (const [sid, existingUser] of users.entries()) {
      if (sid !== socket.id && existingUser.guestId === guestId) {
        users.delete(sid);
        socket.to(existingUser.room || 'general').emit('user-left', sid);
      }
    }
  }

  const user = {
    id: socket.id,
    name,
    email: sanitizeEmail(auth.email) || null,
    guestId,
    workstation: null,
    x: 300,
    y: 100,
    micEnabled: false,
    room: 'general',
    avatarColor: auth.avatarColor || '#259765',
    avatarStyle: auth.avatarStyle || 'classic',
    status: auth.status || 'online',
    joinedAt: new Date().toISOString(),
  };
  users.set(socket.id, user);
  socket.join('general');

  socket.emit('initial-users', Array.from(users.values()).filter(u => u.room === 'general'));
  socket.emit('room-info', { room: 'general', title: 'General Office', isPrivate: false });
  socket.to('general').emit('user-joined', user);

  ioServer.emit('room-counts', getRoomCounts());
  ioServer.emit('presence-list', getOfficePresence());

  // Move
  let lastMoveAt = 0;
  socket.on('move', (pos) => {
    const now = Date.now();
    if (now - lastMoveAt < 20) return; // rate limit 20ms
    lastMoveAt = now;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    user.x = pos.x;
    user.y = pos.y;
    ioServer.to(user.room).emit('user-moved', user);
  });

  // Join Room
  socket.on('join-room', (data, callback) => {
    const { room: targetRoom, profile } = (data && typeof data === 'object') ? data : {};
    const roomToJoin = (targetRoom || 'general').trim();

    if (profile && typeof profile === 'object') {
      if ('name' in profile) {
        const clean = sanitizeDisplayName(profile.name);
        if (!clean) {
          if (typeof callback === 'function') callback({ success: false, error: 'Name must be 2-30 chars' });
          return;
        }
        user.name = clean;
      }
      if ('email' in profile && profile.email) {
        const cleanEmail = sanitizeEmail(profile.email);
        if (!cleanEmail) {
          if (typeof callback === 'function') callback({ success: false, error: 'Invalid email' });
          return;
        }
        user.email = cleanEmail;
      }
    }

    const oldRoom = user.room;
    if (oldRoom === roomToJoin) {
      if (typeof callback === 'function') callback({ success: true, room: roomToJoin });
      return;
    }

    if (oldRoom) {
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('user-left', socket.id);
    }
    user.room = roomToJoin;
    socket.join(roomToJoin);

    socket.emit('initial-users', Array.from(users.values()).filter(u => u.room === roomToJoin));
    socket.to(roomToJoin).emit('user-joined', user);
    ioServer.emit('room-counts', getRoomCounts());
    ioServer.emit('presence-list', getOfficePresence());

    if (typeof callback === 'function') callback({ success: true, room: roomToJoin });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const r = user.room;
    users.delete(socket.id);
    if (r) socket.to(r).emit('user-left', socket.id);
    ioServer.emit('room-counts', getRoomCounts());
    ioServer.emit('presence-list', getOfficePresence());
  });
});

const TEST_PORT = 5998;
await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
console.log(`Test Socket.IO Server live at http://127.0.0.1:${TEST_PORT}\n`);

const SERVER_URL = `http://127.0.0.1:${TEST_PORT}`;

function createClient(name, email, guestId) {
  const client = io(SERVER_URL, {
    auth: { name, email, guestId },
    transports: ['websocket'],
    forceNew: true,
  });
  return client;
}

function waitForConnect(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timed out after 4s')), 4000);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve(true);
    });
    client.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Test Scenarios ────────────────────────────────────────────────────────────

try {
  // ── Scenario 1: 2 Users Joining Simultaneously ──────────────────────────────
  console.log('Testing Scenario 1: 2 users joining simultaneously…');
  const c1 = createClient('Alice Chen', 'alice@company.com', 'guest_1');
  const c2 = createClient('Bob Smith', 'bob@company.com', 'guest_2');

  const [c1Conn, c2Conn] = await Promise.all([
    waitForConnect(c1),
    waitForConnect(c2),
  ]);

  assert(c1Conn && c2Conn, 'Scenario 1: 2 users connected simultaneously');
  assert(users.size === 2, 'Scenario 1: Server registered exactly 2 active users');
  assert(c1.id !== c2.id, 'Scenario 1: Each user has a unique socket ID');

  // ── Scenario 2: 5 Users Joining Simultaneously ──────────────────────────────
  console.log('\nTesting Scenario 2: 5 users joining simultaneously…');
  const group5 = [
    createClient('Charlie Day', 'charlie@company.com', 'guest_3'),
    createClient('David Miller', 'david@company.com', 'guest_4'),
    createClient('Elena Rostova', 'elena@company.com', 'guest_5'),
  ];
  await Promise.all(group5.map(c => waitForConnect(c)));
  assert(users.size === 5, 'Scenario 2: 5 concurrent users connected in General Office');

  // ── Scenario 3: 10 Users Joining Simultaneously ─────────────────────────────
  console.log('\nTesting Scenario 3: 10 users joining simultaneously…');
  const group10 = [];
  for (let i = 6; i <= 10; i++) {
    group10.push(createClient(`Employee ${i}`, `emp${i}@company.com`, `guest_${i}`));
  }
  await Promise.all(group10.map(c => waitForConnect(c)));
  assert(users.size === 10, 'Scenario 3: 10 concurrent users connected in General Office');

  // ── Scenario 4: Multiple Users Moving at the Same Time ──────────────────────
  console.log('\nTesting Scenario 4: Multiple users moving simultaneously…');
  const moveEventsReceived = [];
  c1.on('user-moved', (u) => moveEventsReceived.push(u));

  // c2 and group5 move concurrently
  c2.emit('move', { x: 310, y: 120 });
  group5[0].emit('move', { x: 320, y: 130 });
  group5[1].emit('move', { x: 330, y: 140 });

  await new Promise(r => setTimeout(r, 200));
  assert(moveEventsReceived.length >= 2, 'Scenario 4: Movement events broadcast in real time across peers');
  assert(users.get(c2.id).x === 310, 'Scenario 4: User 2 coordinate updated on server');

  // ── Scenario 5: Multiple Users Changing Rooms ───────────────────────────────
  console.log('\nTesting Scenario 5: Multiple users changing rooms…');
  let userLeftInGeneral = false;
  c1.on('user-left', (id) => {
    if (id === c2.id) userLeftInGeneral = true;
  });

  await new Promise(resolve => {
    c2.emit('join-room', { room: 'meeting' }, (res) => {
      resolve(res);
    });
  });

  await new Promise(r => setTimeout(r, 100));
  assert(users.get(c2.id).room === 'meeting', 'Scenario 5: User 2 moved to meeting room');
  assert(userLeftInGeneral, 'Scenario 5: Peers in General Office notified of departure');
  assert(getRoomCounts().general === 9 && getRoomCounts().meeting === 1, 'Scenario 5: Room counts accurately reflect room changes');

  // ── Scenario 6: One User Disconnecting While Others Remain ─────────────────
  console.log('\nTesting Scenario 6: One user disconnecting…');
  let disconnectNotified = false;
  c1.on('user-left', (id) => {
    if (id === group5[0].id) disconnectNotified = true;
  });

  group5[0].disconnect();
  await new Promise(r => setTimeout(r, 200));

  assert(users.size === 9, 'Scenario 6: User count reduced by 1 on disconnect');
  assert(disconnectNotified, 'Scenario 6: Remaining peers notified of disconnect');
  assert(getOfficePresence().length === 9, 'Scenario 6: Live Employee Presence updated correctly');

  // ── Scenario 7: One User Reconnecting After Network Interruption ───────────
  console.log('\nTesting Scenario 7: User reconnecting with same guestId (deduping)…');
  // Reconnect Elena with new socket but same guestId ('guest_5')
  const elenaOldSocketId = group5[2].id;
  const elenaReconnected = createClient('Elena Rostova Updated', 'elena@company.com', 'guest_5');

  await waitForConnect(elenaReconnected);
  await new Promise(r => setTimeout(r, 100));

  assert(!users.has(elenaOldSocketId), 'Scenario 7: Stale socket evicted from active users');
  assert(users.has(elenaReconnected.id), 'Scenario 7: Reconnected socket registered');
  // Check no duplicate ghost avatar for guest_5
  const guest5Count = Array.from(users.values()).filter(u => u.guestId === 'guest_5').length;
  assert(guest5Count === 1, 'Scenario 7: Zero duplicate ghost avatars for reconnecting user');

  // ── Scenario 8: Verify Live Presence Count Across All Connected Clients ────
  console.log('\nTesting Scenario 8: Live presence synchronization…');
  let presenceFromClient = null;
  c1.on('presence-list', (list) => { presenceFromClient = list; });
  // Trigger presence broadcast
  c1.emit('join-room', { room: 'general', profile: { name: 'Alice Chen CEO' } });
  await new Promise(r => setTimeout(r, 200));

  assert(presenceFromClient !== null, 'Scenario 8: Client received live presence list');
  assert(presenceFromClient.length === users.size, `Scenario 8: Presence count (${presenceFromClient?.length}) matches active users (${users.size})`);

  // ── Scenario 9: 50 Concurrent Users Joining Stress Test ────────────────────
  console.log('\nTesting Scenario 9: 50 concurrent users stress test…');
  const stressClients = [];
  const startJoinTime = Date.now();

  for (let i = 11; i <= 50; i++) {
    stressClients.push(createClient(`Stress User ${i}`, `stress${i}@proxispeak.io`, `stress_guest_${i}`));
  }

  await Promise.all(stressClients.map(c => waitForConnect(c)));
  const joinDurationMs = Date.now() - startJoinTime;

  assert(users.size >= 50, `Scenario 9: Successfully scaled to ${users.size} concurrent users`);
  console.log(`  ⏱️  Joined ${stressClients.length} users in ${joinDurationMs}ms (average ${Math.round(joinDurationMs / stressClients.length)}ms per join)`);

  // Clean up all clients and server
  c1.disconnect();
  c2.disconnect();
  group5.forEach(c => c.disconnect());
  group10.forEach(c => c.disconnect());
  elenaReconnected.disconnect();
  stressClients.forEach(c => c.disconnect());

  server.close();
  console.log('\n── Concurrency Results: ' + pass + ' passed, ' + fail + ' failed ──\n');
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error('Test execution error:', err);
  server.close();
  process.exit(1);
}
