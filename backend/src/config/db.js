/**
 * src/config/db.js
 * MongoDB connection using Mongoose.
 *
 * Graceful degradation: if MONGODB_URI is not set or the connection fails,
 * the server continues running with in-memory state only. A clear warning
 * is logged so developers know the DB layer is unavailable.
 */
import mongoose from 'mongoose';

let isConnected = false;

export async function connectDB(uri) {
  if (!uri) {
    console.warn('[DB] MONGODB_URI is not set — running without persistent storage.');
    return false;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log('[DB] MongoDB connected:', mongoose.connection.host);
    return true;
  } catch (err) {
    console.warn('[DB] MongoDB connection failed:', err.message);
    console.warn('[DB] Continuing with in-memory state only.');
    return false;
  }
}

export function getDBStatus() {
  return {
    connected: isConnected,
    host: isConnected ? mongoose.connection.host : null,
    dbName: isConnected ? mongoose.connection.name : null,
  };
}

export async function disconnectDB() {
  if (isConnected) {
    await mongoose.disconnect();
    isConnected = false;
    console.log('[DB] MongoDB disconnected.');
  }
}
