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

// Active workstation occupancy: Map of deskId -> { socketId, userId, name, deskName }
const occupiedWorkstations = new Map();

// Avatar style & status allowed lists
const VALID_STYLES   = new Set(['classic', 'star', 'diamond', 'crown']);
const VALID_STATUSES = new Set(['online', 'away', 'busy']);

// Email sanitization regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function sanitizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return EMAIL_REGEX.test(trimmed) ? trimmed : null;
}

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

// ── Utility: office presence list ──────────────────────────────────────────
export function getOfficePresence() {
  const presence = [];
  for (const [, u] of users) {
    let roomTitle = 'General Office';
    if (u.room === 'meeting')      roomTitle = 'Meeting Room';
    else if (u.room === 'focus')   roomTitle = 'Focus Room';
    else if (u.room && privateRooms.has(u.room)) {
      roomTitle = privateRooms.get(u.room).title || 'Private Meeting';
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
      isPrivate: Boolean(u.room && privateRooms.has(u.room)),
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

app.get('/api/presence', (_req, res) => {
  res.json({
    success: true,
    count: users.size,
    presence: getOfficePresence(),
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
  const auth = (socket.handshake && socket.handshake.auth && typeof socket.handshake.auth === 'object')
    ? socket.handshake.auth
    : {};
  const guestId = (auth.guestId && typeof auth.guestId === 'string') ? auth.guestId.slice(0, 50) : null;
  const rawName = (auth.name && typeof auth.name === 'string') ? auth.name : null;
  const name = (rawName && sanitizeDisplayName(rawName)) || `Guest-${socket.id.slice(0, 4).toUpperCase()}`;

  // Spawn at a random position inside the collaboration area
  const startX = 270 + Math.floor(Math.random() * 180);
  const startY = 60  + Math.floor(Math.random() * 60);

  const user = {
    id: socket.id,
    name,
    email: sanitizeEmail(auth.email) || null,
    guestId,
    workstation: null,
    x: startX,
    y: startY,
    micEnabled: false,
    room: 'general',
    avatarColor: (auth.avatarColor && /^#[0-9a-fA-F]{6}$/.test(auth.avatarColor)) ? auth.avatarColor : '#259765',
    avatarStyle: (auth.avatarStyle && VALID_STYLES.has(auth.avatarStyle)) ? auth.avatarStyle : 'classic',
    status: (auth.status && VALID_STATUSES.has(auth.status)) ? auth.status : 'online',
    joinedAt: new Date().toISOString(),
  };

  // Evict any existing user in memory holding the same guestId (prevents duplicate / ghost avatars)
  if (guestId) {
    for (const [sid, existingUser] of users.entries()) {
      if (sid !== socket.id && existingUser.guestId === guestId) {
        log('log', `[DEDUP] Evicting stale socket ${sid} for guestId ${guestId} on new connection`);
        users.delete(sid);
        if (existingUser.workstation) {
          occupiedWorkstations.delete(existingUser.workstation);
        }
        socket.to(existingUser.room || 'general').emit('user-left', sid);
        const dbStatus = getDBStatus();
        if (dbStatus.connected) {
          Session.deleteOne({ socketId: sid }).catch(() => {});
        }
      }
    }
  }

  users.set(socket.id, user);

  // Join default public room
  socket.join('general');

  // Emit current workstation occupancy state
  socket.emit('workstation-occupancy', Object.fromEntries(occupiedWorkstations));

  // Persist to MongoDB (non-blocking; log error but don't crash)
  const db = getDBStatus();
  if (db.connected) {
    if (user.guestId) {
      Session.deleteMany({ guestId: user.guestId, socketId: { $ne: socket.id } }).catch(() => {});
    }
    Session.create({
      socketId:    socket.id,
      name:        user.name,
      email:       user.email,
      guestId:     user.guestId,
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
  io.emit('presence-list', getOfficePresence());

  log('log', `[CONNECT] ${user.name} (${socket.id}) joined general — ${users.size} total`);

  // ── Move event (room-scoped) ───────────────────────────────────────────
  let lastMoveAt = 0;
  let lastDbMoveWriteAt = 0;

  socket.on('move', async (position) => {
    // Rate limit movement events
    const now = Date.now();
    if (now - lastMoveAt < MOVE_RATE_MS) return;
    lastMoveAt = now;

    // Validate input
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;

    // Server-authoritative clamp
    const { x, y } = clampPosition(position.x, position.y);
    user.x = x;
    user.y = y;

    // Broadcast updated position ONLY to users in the same room (in-memory, immediate)
    io.to(user.room).emit('user-moved', user);

    // Compute proximity within the current room and notify this user
    const nearby = getNearbyUsers(user, users);
    socket.emit('proximity-update', nearby.map((n) => n.user.id));

    // Persist updated position to MongoDB throttled to at most once per 3s per user
    if (db.connected && (now - lastDbMoveWriteAt >= 3000)) {
      lastDbMoveWriteAt = now;
      Session.updateOne(
        { socketId: socket.id },
        {
          $set: {
            x, y,
            location: Session.makeLocation(x, y),
            lastSeen: new Date(),
          },
        }
      ).catch((err) => log('warn', `[DB] Move update failed: ${err.message}`));
    }
  });

  // ── Room Navigation ──────────────────────────────────────────────────────

  socket.on('join-room', (data, callback) => {
    const { room: targetRoom, code, profile } = (data && typeof data === 'object') ? data : {};
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
        if (typeof callback === 'function') {
          callback({ success: false, error: 'Invalid or expired meeting invitation code.' });
        }
        return;
      }
      const priv = privateRooms.get(lookupCode);
      roomToJoin = priv.code;
      roomTitle = priv.title;
      isPrivate = true;
      hostSocketId = priv.hostSocketId;
    }

    const oldRoom = user.room;

    // Optional profile update on join with strict validation
    let profileUpdated = false;
    if (profile && typeof profile === 'object') {
      if ('name' in profile) {
        const clean = sanitizeDisplayName(profile.name);
        if (!clean) {
          socket.emit('room-error', { message: 'Full name must be between 2 and 30 characters.' });
          if (typeof callback === 'function') {
            callback({ success: false, error: 'Full name must be between 2 and 30 characters.' });
          }
          return;
        }
        if (clean !== user.name) {
          user.name = clean;
          profileUpdated = true;
        }
      }
      if ('email' in profile && profile.email) {
        const cleanEmail = sanitizeEmail(profile.email);
        if (!cleanEmail) {
          socket.emit('room-error', { message: 'A valid email address is required.' });
          if (typeof callback === 'function') {
            callback({ success: false, error: 'A valid email address is required.' });
          }
          return;
        }
        if (cleanEmail !== user.email) {
          user.email = cleanEmail;
          profileUpdated = true;
        }
      }
      if (profile.guestId && typeof profile.guestId === 'string') {
        user.guestId = profile.guestId.slice(0, 50);
      }
      if (profile.avatarColor && /^#[0-9a-fA-F]{6}$/.test(profile.avatarColor)) {
        user.avatarColor = profile.avatarColor;
        profileUpdated = true;
      }
      if (profile.avatarStyle && VALID_STYLES.has(profile.avatarStyle)) {
        user.avatarStyle = profile.avatarStyle;
        profileUpdated = true;
      }
      if (profile.status && VALID_STATUSES.has(profile.status)) {
        user.status = profile.status;
        profileUpdated = true;
      }
    }

    if (oldRoom === roomToJoin) {
      if (profileUpdated) {
        io.to(roomToJoin).emit('user-profile-updated', {
          id: socket.id,
          name: user.name,
          avatarColor: user.avatarColor,
          avatarStyle: user.avatarStyle,
          status: user.status,
        });
        io.emit('presence-list', getOfficePresence());
        if (db.connected) {
          Session.updateOne(
            { socketId: socket.id },
            {
              $set: {
                name: user.name,
                email: user.email,
                guestId: user.guestId,
                avatarColor: user.avatarColor,
                avatarStyle: user.avatarStyle,
                status: user.status,
                lastSeen: new Date(),
              },
            }
          ).catch((err) => log('warn', `[DB] Session update failed: ${err.message}`));
        }
      }
        io.to(roomToJoin).emit('user-profile-updated', {
          id: socket.id,
          name: user.name,
          avatarColor: user.avatarColor,
          avatarStyle: user.avatarStyle,
          status: user.status,
        });
        io.emit('presence-list', getOfficePresence());
      }
      const currentRoomUsers = Array.from(users.values()).filter((u) => u.room === roomToJoin);
      socket.emit('initial-users', currentRoomUsers);
      socket.emit('room-info', {
        room: roomToJoin,
        title: roomTitle,
        isPrivate,
        code: isPrivate ? roomToJoin : null,
        hostSocketId,
      });
      if (typeof callback === 'function') {
        callback({
          success: true,
          room: roomToJoin,
          title: roomTitle,
          isPrivate,
          code: isPrivate ? roomToJoin : null,
        });
      }
      return;
    }

    // Leave previous room & notify peers in that room
    if (oldRoom) {
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('user-left', socket.id);
      cleanupPrivateRoomIfEmpty(oldRoom);
    }

    // Update user record
    user.room = roomToJoin;
    user.x = 270 + Math.floor(Math.random() * 180);
    user.y = 60  + Math.floor(Math.random() * 60);

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

    if (typeof callback === 'function') {
      callback({
        success: true,
        room: roomToJoin,
        title: roomTitle,
        isPrivate,
        code: isPrivate ? roomToJoin : null,
      });
    }

    // Notify other users in the new room
    socket.to(roomToJoin).emit('user-joined', user);

    // Update room counts across all clients
    io.emit('room-counts', getRoomCounts());
    io.emit('presence-list', getOfficePresence());

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

    // ── Session & Room Reconnection Recovery ──────────────────────────────────
    socket.on('recover-session', async (data, callback) => {
      const {
        previousSocketId,
        guestId: reqGuestId,
        profile: recoveryProfile,
        room: requestedRoom,
        lastX,
        lastY,
        workstation: requestedWorkstation,
      } = (data && typeof data === 'object') ? data : {};

      log('log', `[SESSION-RECOVER] Request from ${socket.id} (prev: ${previousSocketId}, guest: ${reqGuestId}) for room: ${requestedRoom}`);

      // 1. Sanitize Profile data
      const activeProfile = recoveryProfile && typeof recoveryProfile === 'object' ? recoveryProfile : {};
      const cleanName = sanitizeDisplayName(activeProfile.name) || user.name;
      const cleanEmail = sanitizeEmail(activeProfile.email) || user.email;
      const avatarColor = (activeProfile.avatarColor && /^#[0-9a-fA-F]{6}$/.test(activeProfile.avatarColor))
        ? activeProfile.avatarColor
        : user.avatarColor;
      const avatarStyle = (activeProfile.avatarStyle && VALID_STYLES.has(activeProfile.avatarStyle))
        ? activeProfile.avatarStyle
        : user.avatarStyle;
      const status = (activeProfile.status && VALID_STATUSES.has(activeProfile.status))
        ? activeProfile.status
        : 'online';
      const resolvedGuestId = (typeof reqGuestId === 'string' && reqGuestId)
        ? reqGuestId.slice(0, 50)
        : (user.guestId || null);

      // 2. Clean up any stale/ghost records for this user to prevent duplicate participants
      if (previousSocketId && previousSocketId !== socket.id && users.has(previousSocketId)) {
        const staleUser = users.get(previousSocketId);
        if (staleUser.room) {
          socket.to(staleUser.room).emit('user-left', previousSocketId);
          cleanupPrivateRoomIfEmpty(staleUser.room);
        }
        if (staleUser.workstation) {
          occupiedWorkstations.delete(staleUser.workstation);
        }
        users.delete(previousSocketId);
      }
      if (resolvedGuestId) {
        for (const [sId, existingUser] of users.entries()) {
          if (sId !== socket.id && existingUser.guestId === resolvedGuestId) {
            log('log', `[SESSION-RECOVER] Removing stale socket ${sId} matching guestId ${resolvedGuestId}`);
            if (existingUser.room) {
              socket.to(existingUser.room).emit('user-left', sId);
              cleanupPrivateRoomIfEmpty(existingUser.room);
            }
            if (existingUser.workstation) {
              occupiedWorkstations.delete(existingUser.workstation);
            }
            users.delete(sId);
          }
        }
      }

      // 3. Validate & resolve target room
      let targetRoom = requestedRoom || 'general';
      let roomTitle = 'General Office';
      let isPrivate = false;
      let hostSocketId = null;
      let roomFallbackNotice = null;

      if (PUBLIC_ROOMS.includes(targetRoom)) {
        if (targetRoom === 'meeting')      roomTitle = 'Meeting Room';
        else if (targetRoom === 'focus')   roomTitle = 'Focus Room';
        else                               roomTitle = 'General Office';
      } else if (typeof targetRoom === 'string' && privateRooms.has(targetRoom)) {
        // Valid active private room
        const priv = privateRooms.get(targetRoom);
        roomTitle = priv.title;
        isPrivate = true;
        if (priv.hostSocketId === previousSocketId) {
          priv.hostSocketId = socket.id;
        }
        hostSocketId = priv.hostSocketId;
      } else {
        // Target private room was expired, closed, or invalid
        if (targetRoom && targetRoom !== 'general') {
          roomFallbackNotice = `Previous meeting (${targetRoom}) is no longer available. Reconnected to General Office.`;
          log('warn', `[SESSION-RECOVER] Room ${targetRoom} no longer available. Falling back to general.`);
        }
        targetRoom = 'general';
        roomTitle = 'General Office';
        isPrivate = false;
      }

      // 4. Validate & restore coordinates (authoritative clamp)
      let posX = Number.isFinite(lastX) ? lastX : user.x;
      let posY = Number.isFinite(lastY) ? lastY : user.y;
      const clamped = clampPosition(posX, posY);
      posX = clamped.x;
      posY = clamped.y;

      // 5. Validate & restore workstation
      let restoredWorkstation = null;
      if (requestedWorkstation && typeof requestedWorkstation === 'string') {
        const existingDesk = occupiedWorkstations.get(requestedWorkstation);
        if (!existingDesk || existingDesk.socketId === previousSocketId || existingDesk.userId === previousSocketId) {
          occupiedWorkstations.set(requestedWorkstation, {
            socketId: socket.id,
            userId: socket.id,
            name: cleanName,
            deskName: existingDesk?.deskName || requestedWorkstation,
          });
          restoredWorkstation = requestedWorkstation;
        }
      }

      // 6. Update current user instance in memory
      user.name = cleanName;
      user.email = cleanEmail;
      user.guestId = resolvedGuestId;
      user.avatarColor = avatarColor;
      user.avatarStyle = avatarStyle;
      user.status = status;
      user.room = targetRoom;
      user.x = posX;
      user.y = posY;
      user.workstation = restoredWorkstation;
      users.set(socket.id, user);

      // 7. Re-join Socket.IO room
      for (const r of socket.rooms) {
        if (r !== socket.id) socket.leave(r);
      }
      socket.join(targetRoom);

      // 8. Send fresh room state & workstation occupancy to reconnecting client
      const currentRoomUsers = Array.from(users.values()).filter((u) => u.room === targetRoom);
      socket.emit('initial-users', currentRoomUsers);
      socket.emit('room-info', {
        room: targetRoom,
        title: roomTitle,
        isPrivate,
        code: isPrivate ? targetRoom : null,
        hostSocketId,
      });
      socket.emit('workstation-occupancy', Object.fromEntries(occupiedWorkstations));

      // 9. Notify other peers in the room
      socket.to(targetRoom).emit('user-joined', user);

      // 10. Broadcast updated counts & presence globally
      io.emit('room-counts', getRoomCounts());
      io.emit('presence-list', getOfficePresence());

      // 11. Update MongoDB Session
      if (db.connected) {
        Session.findOneAndUpdate(
          { $or: [{ socketId: previousSocketId }, { socketId: socket.id }, { guestId: resolvedGuestId }] },
          {
            $set: {
              socketId: socket.id,
              name: cleanName,
              email: cleanEmail,
              guestId: resolvedGuestId,
              room: targetRoom,
              x: posX,
              y: posY,
              avatarColor,
              avatarStyle,
              status,
              workstation: restoredWorkstation,
              location: Session.makeLocation(posX, posY),
              lastSeen: new Date(),
            },
          },
          { upsert: true, new: true }
        ).catch((err) => log('warn', `[DB] Session recover update failed: ${err.message}`));
      }

      log('log', `[SESSION-RECOVER] ${user.name} (${socket.id}) successfully restored to ${targetRoom} at (${posX}, ${posY})`);

      if (typeof callback === 'function') {
        callback({
          success: true,
          restored: true,
          room: targetRoom,
          title: roomTitle,
          isPrivate,
          code: isPrivate ? targetRoom : null,
          workstation: restoredWorkstation,
          notice: roomFallbackNotice,
          user,
        });
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
    io.emit('presence-list', getOfficePresence());
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
    io.emit('presence-list', getOfficePresence());

    log('log', `[ROOM-LEAVE] ${user.name} left ${oldRoom} returned to general`);
  });

  socket.on('leave-office', () => {
    const oldRoom = user.room;
    if (oldRoom) {
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('user-left', socket.id);
      cleanupPrivateRoomIfEmpty(oldRoom);
    }

    if (user.workstation) {
      occupiedWorkstations.delete(user.workstation);
      user.workstation = null;
      io.emit('workstation-occupancy', Object.fromEntries(occupiedWorkstations));
    }

    user.room = null;
    io.emit('room-counts', getRoomCounts());
    io.emit('presence-list', getOfficePresence());
    log('log', `[LEAVE-OFFICE] ${user.name} (${socket.id}) exited to welcome screen`);

    if (db.connected) {
      Session.updateOne(
        { socketId: socket.id },
        {
          $set: {
            room: null,
            lastSeen: new Date(),
          },
        }
      ).catch((err) => log('warn', `[DB] Session leave office update failed: ${err.message}`));
    }
  });

  // ── In-Room Real-Time Text Chat ──────────────────────────────────────────
  socket.on('send-room-chat', ({ text }) => {
    if (!text || typeof text !== 'string') return;
    const clean = text.replace(/<[^>]*>?/gm, '').trim().slice(0, 300);
    if (!clean) return;

    const chatMsg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      senderId: socket.id,
      senderName: user.name,
      avatarColor: user.avatarColor,
      text: clean,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      room: user.room || 'general',
    };

    io.to(user.room || 'general').emit('room-chat-message', chatMsg);
    log('log', `[CHAT] [${user.room}] ${user.name}: ${clean.slice(0, 40)}`);
  });

  // ── Workstation Occupancy ────────────────────────────────────────────────
  socket.on('sit-workstation', ({ deskId, deskName }) => {
    if (!deskId || typeof deskId !== 'string') return;
    user.workstation = deskId;
    occupiedWorkstations.set(deskId, {
      socketId: socket.id,
      userId: user.id,
      name: user.name,
      deskName: deskName || deskId,
    });
    io.emit('workstation-occupancy', Object.fromEntries(occupiedWorkstations));
    io.emit('presence-list', getOfficePresence());
    log('log', `[WORKSTATION] ${user.name} occupied ${deskId}`);
  });

  socket.on('leave-workstation', () => {
    if (user.workstation) {
      occupiedWorkstations.delete(user.workstation);
      user.workstation = null;
      io.emit('workstation-occupancy', Object.fromEntries(occupiedWorkstations));
      io.emit('presence-list', getOfficePresence());
      log('log', `[WORKSTATION] ${user.name} left workstation`);
    }
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
      io.emit('presence-list', getOfficePresence());

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
    io.emit('presence-list', getOfficePresence());

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

    if (user.workstation) {
      occupiedWorkstations.delete(user.workstation);
      io.emit('workstation-occupancy', Object.fromEntries(occupiedWorkstations));
    }

    // Notify only users in the room where user was present
    if (currentRoom) {
      socket.to(currentRoom).emit('user-left', socket.id);
      cleanupPrivateRoomIfEmpty(currentRoom);
    }

    // Broadcast updated room counts to all remaining clients
    io.emit('room-counts', getRoomCounts());
    io.emit('presence-list', getOfficePresence());

    if (db.connected) {
      Session.deleteOne({ socketId: socket.id })
        .catch((err) => log('warn', `[DB] Session delete failed: ${err.message}`));
    }

    log('log', `[DISCONNECT] ${user.name} (${reason}) — ${users.size} remaining`);
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
