/**
 * socket.js
 * Singleton Socket.IO client instance.
 * Import this instead of calling io() multiple times.
 */
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

const socket = io(SOCKET_URL, {
  autoConnect: false,        // we connect manually after mounting
  reconnection: true,         // enable automatic reconnection
  reconnectionAttempts: 25,   // retry up to 25 times
  reconnectionDelay: 1000,    // initial delay: 1 second
  reconnectionDelayMax: 5000, // max backoff delay: 5 seconds
  randomizationFactor: 0.5,   // jitter to prevent reconnect stampedes
  timeout: 10000,             // connection timeout
  transports: ['websocket', 'polling'],
});

export default socket;
