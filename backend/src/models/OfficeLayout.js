/**
 * src/models/OfficeLayout.js
 *
 * Mongoose schema and seed data for persistent virtual office layouts,
 * furniture dimensions, and acoustic obstruction properties.
 */
import mongoose from 'mongoose';

const obstacleSchema = new mongoose.Schema(
  {
    id:              { type: String, required: true },
    name:            { type: String, required: true },
    x:               { type: Number, required: true },
    y:               { type: Number, required: true },
    w:               { type: Number, required: true },
    h:               { type: Number, required: true },
    material:        { type: String, default: 'wood' },
    soundAbsorption: { type: Number, default: 0.35, min: 0, max: 1 }, // 0 = transparent, 1 = total block
  },
  { _id: false }
);

const workstationSchema = new mongoose.Schema(
  {
    id:   { type: String, required: true },
    x:    { type: Number, required: true },
    y:    { type: Number, required: true },
    name: { type: String, required: true },
    zone: { type: String, default: 'Work Pod' },
  },
  { _id: false }
);

const officeLayoutSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
    },
    dimensions: {
      width:  { type: Number, default: 800 },
      height: { type: Number, default: 500 },
    },
    obstacles:    [obstacleSchema],
    workstations: [workstationSchema],
  },
  { timestamps: true }
);

export const DEFAULT_GENERAL_LAYOUT = {
  roomId: 'general',
  name: 'General Collaborative Workspace',
  dimensions: { width: 800, height: 500 },
  obstacles: [
    { id: 'reception-desk', name: 'Reception Desk', x: 35, y: 395, w: 95, h: 45, material: 'wood', soundAbsorption: 0.30 },
    { id: 'dev-cluster-1', name: 'Dev Pod Workstations 1', x: 35, y: 65, w: 200, h: 50, material: 'wood', soundAbsorption: 0.25 },
    { id: 'dev-cluster-2', name: 'Design Pod Workstations 2', x: 35, y: 195, w: 200, h: 50, material: 'wood', soundAbsorption: 0.25 },
    { id: 'collab-table', name: 'Collaboration Table', x: 355, y: 85, w: 70, h: 50, material: 'wood', soundAbsorption: 0.20 },
    { id: 'conf-table', name: 'Glass Conference Table', x: 570, y: 70, w: 160, h: 70, material: 'wood', soundAbsorption: 0.30 },
    { id: 'glass-wall-top', name: 'Glass Partition Top', x: 520, y: 20, w: 8, h: 120, material: 'glass', soundAbsorption: 0.65 },
    { id: 'glass-wall-bot', name: 'Glass Partition Bottom', x: 520, y: 180, w: 8, h: 30, material: 'glass', soundAbsorption: 0.65 },
    { id: 'focus-booth-a', name: 'Acoustic Focus Booth A', x: 360, y: 235, w: 55, h: 65, material: 'acoustic-fabric', soundAbsorption: 0.85 },
    { id: 'focus-booth-b', name: 'Acoustic Focus Booth B', x: 430, y: 235, w: 55, h: 65, material: 'acoustic-fabric', soundAbsorption: 0.85 },
    { id: 'coffee-bar', name: 'Refreshment Bar', x: 210, y: 385, w: 150, h: 45, material: 'metal', soundAbsorption: 0.35 },
    { id: 'breakout-lounge', name: 'Lounge Sectional Sofa', x: 460, y: 380, w: 140, h: 50, material: 'acoustic-fabric', soundAbsorption: 0.40 },
  ],
  workstations: [
    { id: 'desk-1', x: 60,  y: 125, name: 'Workstation 1', zone: 'Dev Pod' },
    { id: 'desk-2', x: 130, y: 125, name: 'Workstation 2', zone: 'Dev Pod' },
    { id: 'desk-3', x: 200, y: 125, name: 'Workstation 3', zone: 'Dev Pod' },
    { id: 'desk-4', x: 60,  y: 255, name: 'Workstation 4', zone: 'Design Pod' },
    { id: 'desk-5', x: 130, y: 255, name: 'Workstation 5', zone: 'Design Pod' },
    { id: 'desk-6', x: 200, y: 255, name: 'Workstation 6', zone: 'Design Pod' },
    { id: 'booth-1', x: 387, y: 310, name: 'Focus Booth A', zone: 'Silent Pod' },
    { id: 'booth-2', x: 457, y: 310, name: 'Focus Booth B', zone: 'Silent Pod' },
  ],
};

export const DEFAULT_MEETING_LAYOUT = {
  roomId: 'meeting',
  name: 'Executive Boardroom & All-Hands Suite',
  dimensions: { width: 800, height: 500 },
  obstacles: [
    { id: 'video-wall', name: 'Video Presentation Wall', x: 220, y: 25, w: 360, h: 25, material: 'metal', soundAbsorption: 0.60 },
    { id: 'podium', name: 'Speaker Podium', x: 370, y: 60, w: 60, h: 24, material: 'wood', soundAbsorption: 0.30 },
    { id: 'boardroom-table', name: 'Grand Boardroom Table', x: 200, y: 160, w: 400, h: 110, material: 'wood', soundAbsorption: 0.35 },
    { id: 'lounge-left', name: 'Discussion Lounge Left', x: 160, y: 390, w: 140, h: 50, material: 'acoustic-fabric', soundAbsorption: 0.40 },
    { id: 'lounge-right', name: 'Discussion Lounge Right', x: 500, y: 390, w: 140, h: 50, material: 'acoustic-fabric', soundAbsorption: 0.40 },
  ],
  workstations: [],
};

export const DEFAULT_FOCUS_LAYOUT = {
  roomId: 'focus',
  name: 'Quiet Focus Pods',
  dimensions: { width: 800, height: 500 },
  obstacles: [
    { id: 'pod-desk-1', name: 'Deep Work Pod 01', x: 65,  y: 85,  w: 190, h: 45, material: 'acoustic-fabric', soundAbsorption: 0.70 },
    { id: 'pod-desk-2', name: 'Deep Work Pod 02', x: 455, y: 85,  w: 190, h: 45, material: 'acoustic-fabric', soundAbsorption: 0.70 },
    { id: 'pod-desk-3', name: 'Deep Work Pod 03', x: 65,  y: 305, w: 190, h: 45, material: 'acoustic-fabric', soundAbsorption: 0.70 },
    { id: 'pod-desk-4', name: 'Deep Work Pod 04', x: 455, y: 305, w: 190, h: 45, material: 'acoustic-fabric', soundAbsorption: 0.70 },
  ],
  workstations: [],
};

export const OfficeLayout = mongoose.model('OfficeLayout', officeLayoutSchema);
