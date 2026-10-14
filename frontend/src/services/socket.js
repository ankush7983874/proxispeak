/**
 * socket.js
 * Singleton Socket.IO client instance.
 * Import this instead of calling io() multiple times.
 */
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

const socket = io(SOCKET_URL, {
  autoConnect: false,        // we connect manually after mounting
  reconnectionAttempts: 10,
  reconnectionDelay: 1500,
  timeout: 10000,
});

export default socket;
