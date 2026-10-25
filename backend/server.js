/**
 * server.js — ProxiSpeak backend
 *
 * Stack: Node.js + Express + Socket.IO + MongoDB (Mongoose)
 *
 * Architecture:
 *  ─ In-memory Map (users) for ultra-fast position lookups during Socket.IO events.
 *  ─ MongoDB Session documents for persistence, geospatial queries, and TTL cleanup.
 *  ─ Socket.IO carries WebRTC signaling (offer / answer / ICE candidate).
 *  ─ Server is authoritative for position clamping; client positions are never
 *    trusted as-is.
 *
 * Socket.IO events (server → client):
 *   initial-users          — array of all current users sent to a new connection
 *   user-joined            — single user object broadcast when someone connects
 *   user-moved             — updated user position broadcast on every move
 *   user-left              — socket ID broadcast when someone disconnects
 *   proximity-update       — array of nearby user IDs sent to each mover
 *   user-mic-status        — { id, micEnabled } broadcast on mic state change
 *   webrtc-offer           — forwarded WebRTC offer {from, offer}
 *   webrtc-answer          — forwarded WebRTC answer {from, answer}
 *   webrtc-ice-candidate   — forwarded ICE candidate {from, candidate}
 *
 * Socket.IO events (client → server):
 *   move                   — { x, y } move request
 *   update-mic-status      — { micEnabled: boolean }
 *   webrtc-offer           — { target, offer }
 *   webrtc-answer          — { target, answer }
 *   webrtc-ice-candidate   — { target, candidate }
 */

import 'dotenv/config';
import express    from 'express';
import cors       from 'cors';
import http       from 'node:http';
import { Server } from 'socket.io';

import { connectDB, getDBStatus, disconnectDB } from './src/config/db.js';
import { Session }                               from './src/models/Session.js';
import { clampPosition, getNearbyUsers, EARSHOT_PIXELS } from './src/utils/proximity.js';

// ── Config ──────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT  || '5000', 10);
const FRONTEND_URL = process.env.FRONTEND_URL   || 'http://localhost:5173';
const MONGODB_URI  = process.env.MONGODB_URI    || '';
const MOVE_RATE_MS = Math.floor(1000 / parseInt(process.env.MOVE_RATE_LIMIT || '20', 10));

// TURN server configuration (optional — only needed behind restrictive NATs)
const TURN_URL        = process.env.TURN_URL        || '';
const TURN_USERNAME   = process.env.TURN_USERNAME   || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

// Build ICE servers list — always include public STUN; add TURN if configured
function buildIceServers() {
  const servers = [
    { urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()) },
  ];
  if (TURN_URL) {
    servers.push({
      urls: TURN_URL,
      username:   TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
  }
  return servers;
}

// ── Express setup ────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors({
  origin: FRONTEND_URL,
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// ── Socket.IO setup ──────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
  },
  pingTimeout:  30000,
  pingInterval: 10000,
});

// ── In-memory user & room stores ─────────────────────────────────────────────
// { [socketId]: { id, name, x, y, micEnabled, room, avatarColor, avatarStyle, status } }
const users = new Map();

// Public rooms supported by the virtual office
const PUBLIC_ROOMS = ['general', 'meeting', 'focus'];

// Private rooms: Map of code -> { code, title, hostSocketId, createdAt }
const privateRooms = new Map();

// Avatar style & status allowed lists
const VALID_STYLES   = new Set(['classic', 'star', 'diamond', 'crown']);
const VALID_STATUSES = new Set(['online', 'away', 'busy']);

// ── Utility: structured log ──────────────────────────────────────────────────
function log(level, message) {
  const ts = new Date().toISOString();
  console[level](`[${ts}] ${message}`);
}

// ── Utility: room counts ─────────────────────────────────────────────────────
function getRoomCounts() {
  const counts = { general: 0, meeting: 0, focus: 0 };
  for (const [code] of privateRooms) {
    counts[code] = 0;
  }
  for (const [, user] of users) {
    const r = user.room || 'general';
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

// ── Utility: generate random private room code ───────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude ambiguous 0/O, 1/I
  let code;
  let attempts = 0;
  do {
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code = `PRV-${suffix}`;
    attempts++;
  } while (privateRooms.has(code) && attempts < 100);
  return code;
}

// ── Utility: sanitize display name ───────────────────────────────────────────
function sanitizeDisplayName(rawName) {
  if (typeof rawName !== 'string') return null;
  const stripped = rawName.replace(/<[^>]*>?/gm, '').trim();
  if (stripped.length < 2 || stripped.length > 30) return null;
  return stripped;
}

// ── Utility: cleanup empty private room ──────────────────────────────────────
function cleanupPrivateRoomIfEmpty(roomCode) {
  if (!roomCode || PUBLIC_ROOMS.includes(roomCode)) return;
  const hasOccupants = Array.from(users.values()).some((u) => u.room === roomCode);
  if (!hasOccupants && privateRooms.has(roomCode)) {
    privateRooms.delete(roomCode);
    log('log', `[PRIVATE-ROOM] Deleted empty room ${roomCode}`);
  }
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'ProxiSpeak server is running',
    connectedUsers: users.size,
    rooms: getRoomCounts(),
    activePrivateRooms: privateRooms.size,
    database: getDBStatus(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/ice-servers
 * Returns ICE server configuration for WebRTC clients.
 * TURN credentials are included only when configured via env vars.
 */
app.get('/api/ice-servers', (_req, res) => {
  res.json({ iceServers: buildIceServers() });
});

/**
 * GET /api/users/nearby?x=400&y=250
 * Returns users within earshot of the given canvas position.
 * Uses MongoDB $geoWithin when DB is available; falls back to in-memory scan.
 */
app.get('/api/users/nearby', async (req, res) => {
  const x = parseFloat(req.query.x);
  const y = parseFloat(req.query.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ success: false, error: 'x and y query params are required' });
  }

  try {
    const db = getDBStatus();
    if (db.connected) {
      const lon = x / 800;
      const lat = y / 500;
      const radius = EARSHOT_PIXELS / 800; // normalised

      const sessions = await Session.find({
        location: {
          $geoWithin: {
            $centerSphere: [[lon, lat], radius / 111.32],
          },
        },
      }).select('socketId name x y -_id').lean();

      return res.json({ success: true, nearby: sessions, source: 'mongodb' });
    }

    // Fallback: in-memory scan
    const pivot = { x, y };
    const nearby = [];
    for (const [, user] of users) {
      const dx = user.x - x;
      const dy = user.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= EARSHOT_PIXELS) {
        nearby.push(user);
      }
    }
    return res.json({ success: true, nearby, source: 'memory' });
  } catch (err) {
    log('error', `[API] /api/users/nearby error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', async (socket) => {
  // Generate a display name server-side — client can update via update-profile
  const name = `Guest-${socket.id.slice(0, 4).toUpperCase()}`;

  // Spawn at a random position inside the collaboration area
  const startX = 270 + Math.floor(Math.random() * 180);
  const startY = 60  + Math.floor(Math.random() * 60);

  const user = {
    id: socket.id,
    name,
    x: startX,
    y: startY,
    micEnabled: false,
    room: 'general',
    avatarColor: '#259765',
    avatarStyle: 'classic',
    status: 'online',
  };
  users.set(socket.id, user);

  // Join default public room
  socket.join('general');

  // Persist to MongoDB (non-blocking; log error but don't crash)
  const db = getDBStatus();
  if (db.connected) {
    Session.create({
      socketId:    socket.id,
      name,
      x:           startX,
      y:           startY,
      micEnabled:  false,
      room:        'general',
      avatarColor: user.avatarColor,
      avatarStyle: user.avatarStyle,
      status:      user.status,
      location:    Session.makeLocation(startX, startY),
    }).catch((err) => log('warn', `[DB] Session create failed: ${err.message}`));
  }

  // Send initial room state to the newly connected user
  const initialRoomUsers = Array.from(users.values()).filter((u) => u.room === 'general');
  socket.emit('initial-users', initialRoomUsers);
  socket.emit('room-info', {
    room: 'general',
    title: 'General Office',
    isPrivate: false,
  });

  // Broadcast presence & updated global room counts
  socket.to('general').emit('user-joined', user);
  io.emit('room-counts', getRoomCounts());

  log('log', `[CONNECT] ${name} (${socket.id}) joined general — ${users.size} total`);

  // ── Move event (room-scoped) ───────────────────────────────────────────
  let lastMoveAt = 0;

  socket.on('move', async (position) => {
    // Rate limit
    const now = Date.now();
    if (now - lastMoveAt < MOVE_RATE_MS) return;
    lastMoveAt = now;

    // Validate input
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;

    // Server-authoritative clamp
    const { x, y } = clampPosition(position.x, position.y);
    user.x = x;
    user.y = y;

    // Broadcast updated position ONLY to users in the same room
    io.to(user.room).emit('user-moved', user);

    // Compute proximity within the current room and notify this user
    const nearby = getNearbyUsers(user, users);
    socket.emit('proximity-update', nearby.map((n) => n.user.id));

    // Persist updated position to MongoDB (non-blocking)
    if (db.connected) {
      Session.updateOne(
        { socketId: socket.id },
        {
          $set: {
            x, y,
            location: Session.makeLocation(x, y),
            lastSeen: new Date(),
          },
        }
      ).catch((err) => log('warn', `[DB] Session update failed: ${err.message}`));
    }
  });

  // ── Room Navigation ──────────────────────────────────────────────────────

  socket.on('join-room', ({ room: targetRoom, code, profile }) => {
    let roomToJoin = (targetRoom || 'general').trim();
    let roomTitle = 'General Office';
    let isPrivate = false;
    let hostSocketId = null;

    if (PUBLIC_ROOMS.includes(roomToJoin)) {
      if (roomToJoin === 'meeting')      roomTitle = 'Meeting Room';
      else if (roomToJoin === 'focus')   roomTitle = 'Focus Room';
      else                               roomTitle = 'General Office';
    } else {
      // Must be a private room with invitation code
      const lookupCode = (code || roomToJoin).trim().toUpperCase();
      if (!privateRooms.has(lookupCode)) {
        socket.emit('room-error', { message: 'Invalid or expired meeting invitation code.' });
        return;
      }
      const priv = privateRooms.get(lookupCode);
      roomToJoin = priv.code;
      roomTitle = priv.title;
      isPrivate = true;
      hostSocketId = priv.hostSocketId;
    }

    const oldRoom = user.room || 'general';
    if (oldRoom === roomToJoin) return; // already in this room

    // Leave previous room & notify peers in that room
    socket.leave(oldRoom);
    socket.to(oldRoom).emit('user-left', socket.id);
    cleanupPrivateRoomIfEmpty(oldRoom);

    // Update user record
    user.room = roomToJoin;
    user.x = 270 + Math.floor(Math.random() * 180);
    user.y = 60  + Math.floor(Math.random() * 60);

    // Optional profile update on join
    if (profile && typeof profile === 'object') {
      if (profile.name) {
        const clean = sanitizeDisplayName(profile.name);
        if (clean) user.name = clean;
      }
      if (profile.avatarColor && /^#[0-9a-fA-F]{6}$/.test(profile.avatarColor)) {
        user.avatarColor = profile.avatarColor;
      }
      if (profile.avatarStyle && VALID_STYLES.has(profile.avatarStyle)) {
        user.avatarStyle = profile.avatarStyle;
      }
      if (profile.status && VALID_STATUSES.has(profile.status)) {
        user.status = profile.status;
      }
    }

    socket.join(roomToJoin);

    // Send new room state to the user
    const currentRoomUsers = Array.from(users.values()).filter((u) => u.room === roomToJoin);
    socket.emit('initial-users', currentRoomUsers);
    socket.emit('room-info', {
      room: roomToJoin,
      title: roomTitle,
      isPrivate,
      code: isPrivate ? roomToJoin : null,
      hostSocketId,
    });

    // Notify other users in the new room
    socket.to(roomToJoin).emit('user-joined', user);

    // Update room counts across all clients
    io.emit('room-counts', getRoomCounts());

    log('log', `[ROOM-JOIN] ${user.name} moved from ${oldRoom} to ${roomToJoin}`);

    if (db.connected) {
      Session.updateOne(
        { socketId: socket.id },
        {
          $set: {
            room: roomToJoin,
            x: user.x,
            y: user.y,
            lastSeen: new Date(),
          },
        }
      ).catch((err) => log('warn', `[DB] Session room update failed: ${err.message}`));
    }
  });

  socket.on('create-private-room', ({ title }) => {
    const cleanTitle = (title && typeof title === 'string')
      ? title.replace(/<[^>]*>?/gm, '').trim().slice(0, 40)
      : 'Private Meeting';
    const code = generateRoomCode();

    privateRooms.set(code, {
      code,
      title: cleanTitle || 'Private Meeting',
      hostSocketId: socket.id,
      createdAt: new Date(),
    });

    const oldRoom = user.room || 'general';
    socket.leave(oldRoom);
    socket.to(oldRoom).emit('user-left', socket.id);
    cleanupPrivateRoomIfEmpty(oldRoom);

    user.room = code;
    user.x = 350 + Math.floor(Math.random() * 100);
    user.y = 200 + Math.floor(Math.random() * 100);

    socket.join(code);

    socket.emit('room-info', {
      room: code,
      title: cleanTitle || 'Private Meeting',
      isPrivate: true,
      code,
      hostSocketId: socket.id,
    });
    socket.emit('initial-users', [user]);

    io.emit('room-counts', getRoomCounts());
    log('log', `[PRIVATE-ROOM] Created ${code} ("${cleanTitle}") by ${user.name}`);

    if (db.connected) {
      Session.updateOne(
        { socketId: socket.id },
        {
          $set: {
            room: code,
            x: user.x,
            y: user.y,
            lastSeen: new Date(),
          },
        }
      ).catch((err) => log('warn', `[DB] Session room update failed: ${err.message}`));
    }
  });

  socket.on('leave-private-room', () => {
    const oldRoom = user.room;
    if (!oldRoom || PUBLIC_ROOMS.includes(oldRoom)) return;

    socket.leave(oldRoom);
    socket.to(oldRoom).emit('user-left', socket.id);
    cleanupPrivateRoomIfEmpty(oldRoom);

    user.room = 'general';
    user.x = 270 + Math.floor(Math.random() * 180);
    user.y = 60  + Math.floor(Math.random() * 60);

    socket.join('general');

    const generalUsers = Array.from(users.values()).filter((u) => u.room === 'general');
    socket.emit('initial-users', generalUsers);
    socket.emit('room-info', {
      room: 'general',
      title: 'General Office',
      isPrivate: false,
    });

    socket.to('general').emit('user-joined', user);
    io.emit('room-counts', getRoomCounts());

    log('log', `[ROOM-LEAVE] ${user.name} left ${oldRoom} returned to general`);
  });

  // ── Avatar & Profile Customization ───────────────────────────────────────

  socket.on('update-profile', (data) => {
    if (!data || typeof data !== 'object') return;
    let changed = false;

    if (data.name) {
      const cleanName = sanitizeDisplayName(data.name);
      if (cleanName && cleanName !== user.name) {
        user.name = cleanName;
        changed = true;
      }
    }

    if (data.avatarColor && /^#[0-9a-fA-F]{6}$/.test(data.avatarColor)) {
      user.avatarColor = data.avatarColor;
      changed = true;
    }

    if (data.avatarStyle && VALID_STYLES.has(data.avatarStyle)) {
      user.avatarStyle = data.avatarStyle;
      changed = true;
    }

    if (data.status && VALID_STATUSES.has(data.status)) {
      user.status = data.status;
      changed = true;
    }

    if (changed) {
      // Broadcast updated profile to everyone in the user's room
      io.to(user.room).emit('user-profile-updated', {
        id: socket.id,
        name: user.name,
        avatarColor: user.avatarColor,
        avatarStyle: user.avatarStyle,
        status: user.status,
      });

      if (db.connected) {
        Session.updateOne(
          { socketId: socket.id },
          {
            $set: {
              name: user.name,
              avatarColor: user.avatarColor,
              avatarStyle: user.avatarStyle,
              status: user.status,
              lastSeen: new Date(),
            },
          }
        ).catch((err) => log('warn', `[DB] Session profile update failed: ${err.message}`));
      }
    }
  });

  // ── Mic status broadcast (room-scoped) ───────────────────────────────────

  socket.on('update-mic-status', (data) => {
    if (!data || typeof data.micEnabled !== 'boolean') return;
    user.micEnabled = data.micEnabled;
    // Broadcast mic state ONLY to users in the same room
    socket.to(user.room).emit('user-mic-status', { id: socket.id, micEnabled: data.micEnabled });

    if (db.connected) {
      Session.updateOne(
        { socketId: socket.id },
        { $set: { micEnabled: data.micEnabled, lastSeen: new Date() } }
      ).catch((err) => log('warn', `[DB] Session micEnabled update failed: ${err.message}`));
    }
  });

  // ── WebRTC Signaling (room-scoped & validated) ───────────────────────────
  // Validation: Target peer must exist AND be currently inside the same room.
  // This prevents cross-room audio eavesdropping.

  socket.on('webrtc-offer', ({ target, offer }) => {
    if (!target || !offer) return;
    const targetUser = users.get(target);
    if (!targetUser || targetUser.room !== user.room) {
      log('warn', `[SIGNAL] Rejected cross-room or invalid offer from ${socket.id} to ${target}`);
      return;
    }
    socket.to(target).emit('webrtc-offer', { from: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ target, answer }) => {
    if (!target || !answer) return;
    const targetUser = users.get(target);
    if (!targetUser || targetUser.room !== user.room) return;
    socket.to(target).emit('webrtc-answer', { from: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ target, candidate }) => {
    if (!target || !candidate) return;
    const targetUser = users.get(target);
    if (!targetUser || targetUser.room !== user.room) return;
    socket.to(target).emit('webrtc-ice-candidate', { from: socket.id, candidate });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', async (reason) => {
    const currentRoom = user.room;
    users.delete(socket.id);

    // Notify only users in the room where user was present
    if (currentRoom) {
      socket.to(currentRoom).emit('user-left', socket.id);
      cleanupPrivateRoomIfEmpty(currentRoom);
    }

    // Broadcast updated room counts to all remaining clients
    io.emit('room-counts', getRoomCounts());

    if (db.connected) {
      Session.deleteOne({ socketId: socket.id })
        .catch((err) => log('warn', `[DB] Session delete failed: ${err.message}`));
    }

    log('log', `[DISCONNECT] ${user.name} (${reason}) — ${users.size} remaining`);
  });
});
});

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  server.listen(PORT, () => {
    log('log', `ProxiSpeak server listening at http://localhost:${PORT}`);
    log('log', `Frontend origin: ${FRONTEND_URL}`);
    log('log', `Move rate limit: ${MOVE_RATE_MS} ms between events`);
    log('log', `Earshot radius:  ${EARSHOT_PIXELS} canvas pixels`);
  });

  // Connect to MongoDB non-blockingly; server is already live and responsive
  connectDB(MONGODB_URI);
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  log('log', `Received ${signal} — shutting down gracefully…`);
  server.close(async () => {
    await disconnectDB();
    log('log', 'Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start();
