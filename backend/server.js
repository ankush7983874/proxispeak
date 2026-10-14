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
 *   webrtc-offer           — forwarded WebRTC offer {from, offer}
 *   webrtc-answer          — forwarded WebRTC answer {from, answer}
 *   webrtc-ice-candidate   — forwarded ICE candidate {from, candidate}
 *
 * Socket.IO events (client → server):
 *   move                   — { x, y } move request
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

// ── In-memory user store ─────────────────────────────────────────────────────
// { [socketId]: { id, name, x, y } }
const users = new Map();

// ── Utility: structured log ──────────────────────────────────────────────────
function log(level, message) {
  const ts = new Date().toISOString();
  console[level](`[${ts}] ${message}`);
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'ProxiSpeak server is running',
    connectedUsers: users.size,
    database: getDBStatus(),
    timestamp: new Date().toISOString(),
  });
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
  // Generate a display name server-side — client cannot supply its own ID
  const name = `Guest-${socket.id.slice(0, 4).toUpperCase()}`;

  // Spawn at a random position inside the collaboration area
  const startX = 270 + Math.floor(Math.random() * 180);
  const startY = 60  + Math.floor(Math.random() * 60);

  const user = { id: socket.id, name, x: startX, y: startY };
  users.set(socket.id, user);

  // Persist to MongoDB (non-blocking; log error but don't crash)
  const db = getDBStatus();
  if (db.connected) {
    Session.create({
      socketId:  socket.id,
      name,
      x:         startX,
      y:         startY,
      location:  Session.makeLocation(startX, startY),
    }).catch((err) => log('warn', `[DB] Session create failed: ${err.message}`));
  }

  // Send current state to the new user
  socket.emit('initial-users', Array.from(users.values()));
  // Notify everyone else
  socket.broadcast.emit('user-joined', user);

  log('log', `[CONNECT] ${name} (${socket.id}) — ${users.size} total`);

  // ── Move event ─────────────────────────────────────────────────────────
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

    // Broadcast updated position to all clients
    io.emit('user-moved', user);

    // Compute proximity and notify this user
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

  // ── WebRTC Signaling ────────────────────────────────────────────────────

  socket.on('webrtc-offer', ({ target, offer }) => {
    if (!target || !offer) return;
    // Forward offer only to the specific target peer
    socket.to(target).emit('webrtc-offer', { from: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ target, answer }) => {
    if (!target || !answer) return;
    socket.to(target).emit('webrtc-answer', { from: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ target, candidate }) => {
    if (!target || !candidate) return;
    socket.to(target).emit('webrtc-ice-candidate', { from: socket.id, candidate });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', async (reason) => {
    users.delete(socket.id);
    io.emit('user-left', socket.id);

    if (db.connected) {
      Session.deleteOne({ socketId: socket.id })
        .catch((err) => log('warn', `[DB] Session delete failed: ${err.message}`));
    }

    log('log', `[DISCONNECT] ${name} (${reason}) — ${users.size} remaining`);
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  await connectDB(MONGODB_URI);

  server.listen(PORT, () => {
    log('log', `ProxiSpeak server listening at http://localhost:${PORT}`);
    log('log', `Frontend origin: ${FRONTEND_URL}`);
    log('log', `Move rate limit: ${MOVE_RATE_MS} ms between events`);
    log('log', `Earshot radius:  ${EARSHOT_PIXELS} canvas pixels`);
  });
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
