/**
 * src/models/Session.js
 *
 * Represents a connected user's live session.
 *
 * COORDINATE SYSTEM — IMPORTANT
 * Canvas pixel coordinates (x, y) are stored as a GeoJSON Point with
 * normalised values:
 *
 *   longitude = x / CANVAS_WIDTH   (range 0 → 1)
 *   latitude  = y / CANVAS_HEIGHT  (range 0 → 1)
 *
 * This normalisation is required because:
 *   1. MongoDB 2dsphere indexes expect values in the range [-180, 180] for
 *      longitude and [-90, 90] for latitude.
 *   2. Raw canvas pixels (e.g. 800 × 500) exceed these bounds.
 *   3. Normalised [0, 1] values stay well within the valid range.
 *
 * Earshot radius in normalised space:
 *   EARSHOT_PX = 100 canvas pixels
 *   EARSHOT_NORMALISED = 100 / 800 = 0.125 (longitude units) ≈ same for lat.
 *
 * This mapping is mirrored exactly in frontend/src/utils/proximity.js.
 *
 * Sessions expire automatically via a TTL index on `lastSeen` (60 seconds).
 * This cleans up stale records left by unexpected disconnections.
 */
import mongoose from 'mongoose';

const CANVAS_WIDTH  = 800;
const CANVAS_HEIGHT = 500;

const sessionSchema = new mongoose.Schema(
  {
    socketId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      maxlength: 40,
    },
    // Raw canvas coordinates for quick in-memory use
    x: { type: Number, required: true, min: 0, max: CANVAS_WIDTH  },
    y: { type: Number, required: true, min: 0, max: CANVAS_HEIGHT },
    // GeoJSON Point with normalised coordinates for geospatial queries
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },
    connectedAt: { type: Date, default: Date.now },
    lastSeen:    { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// 2dsphere index enables $near and $geoWithin queries
sessionSchema.index({ location: '2dsphere' });

// TTL index — remove sessions not updated for 60 seconds (stale cleanup)
sessionSchema.index({ lastSeen: 1 }, { expireAfterSeconds: 60 });

// Helper: convert canvas (x, y) to normalised GeoJSON coordinates
sessionSchema.statics.toGeoCoords = function (x, y) {
  return [x / CANVAS_WIDTH, y / CANVAS_HEIGHT];
};

// Helper: build a GeoJSON Point from canvas coords
sessionSchema.statics.makeLocation = function (x, y) {
  return {
    type: 'Point',
    coordinates: [x / CANVAS_WIDTH, y / CANVAS_HEIGHT],
  };
};

export const Session = mongoose.model('Session', sessionSchema);
export { CANVAS_WIDTH, CANVAS_HEIGHT };
