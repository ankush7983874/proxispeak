/**
 * useOfficeCanvas.js — ProxiSpeak Realistic Corporate Office Canvas
 *
 * Implements Part 2 (Reference 2 Inspiration):
 *  • Realistic bright, modern corporate workplace
 *  • Reception area with guest check-in terminal & branded welcome mat
 *  • 6 Individual employee workstation desks with dual monitors, keyboards & chairs
 *  • Glass-walled meeting suite with boardroom table, executive chairs & 75" display
 *  • Acoustic focus telephone booths for deep concentration
 *  • Collaboration area with rolling whiteboard and sticky notes
 *  • Refreshment & coffee corner with espresso machine, mugs & water cooler
 *  • Breakout lounge with modern sectional sofa & Scandinavian coffee table
 *  • Delineated architectural walking paths and lush potted monstera/ficus plants
 *  • Interactive workstation occupancy & sitting mode
 *  • Obstacle map for furniture collision detection
 */
import { useEffect } from 'react';
import { EARSHOT_RADIUS } from '../utils/proximity.js';

export const LOGICAL_W = 800;
export const LOGICAL_H = 500;

// Curated avatar color fallback
const AVATAR_COLORS = [
  '#2563eb', '#06b6d4', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#6366f1', '#14b8a6', '#64748b',
];

function getAvatarColor(id) {
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// ── Furniture Obstacle Bounds for Collision Detection ────────────────────────
export const GENERAL_OBSTACLES = [
  // Reception Desk
  { x: 35, y: 395, w: 95, h: 45 },
  // Workstation Cluster 1 (Top Left, Dev Pods)
  { x: 35, y: 65, w: 200, h: 50 },
  // Workstation Cluster 2 (Mid Left, Design Pods)
  { x: 35, y: 195, w: 200, h: 50 },
  // Collaboration Table (Center)
  { x: 355, y: 85, w: 70, h: 50 },
  // Glass Conference Suite Table (Top Right)
  { x: 570, y: 70, w: 160, h: 70 },
  // Glass Walls (with doorway gap at y: 140-180)
  { x: 520, y: 20, w: 8, h: 120 },
  { x: 520, y: 180, w: 8, h: 30 },
  // Acoustic Focus Booths
  { x: 360, y: 235, w: 55, h: 65 },
  { x: 430, y: 235, w: 55, h: 65 },
  // Coffee Bar Counter (Bottom Center)
  { x: 210, y: 385, w: 150, h: 45 },
  // Breakout Lounge Sectional (Bottom Right)
  { x: 460, y: 380, w: 140, h: 50 },
];

export const MEETING_OBSTACLES = [
  // Main Stage Video Wall
  { x: 220, y: 25, w: 360, h: 25 },
  // Presentation Podium
  { x: 370, y: 60, w: 60, h: 24 },
  // Grand Boardroom Table
  { x: 200, y: 160, w: 400, h: 110 },
  // Discussion Lounges
  { x: 160, y: 390, w: 140, h: 50 },
  { x: 500, y: 390, w: 140, h: 50 },
];

export const FOCUS_OBSTACLES = [
  // 4 Private Acoustic Deep-Work Pod Desks
  { x: 65,  y: 85,  w: 190, h: 45 }, // Pod 01
  { x: 455, y: 85,  w: 190, h: 45 }, // Pod 02
  { x: 65,  y: 305, w: 190, h: 45 }, // Pod 03
  { x: 455, y: 305, w: 190, h: 45 }, // Pod 04
];

export const PRIVATE_OBSTACLES = [
  // Executive Boardroom Table
  { x: 170, y: 120, w: 460, h: 130 },
  // Presentation Video Wall
  { x: 240, y: 25, w: 320, h: 20 },
  // Executive Lounges
  { x: 150, y: 380, w: 160, h: 54 },
  { x: 490, y: 380, w: 160, h: 54 },
];

// Interactive Workstations in General Office
export const GENERAL_WORKSTATIONS = [
  { id: 'desk-1', x: 60,  y: 125, name: 'Workstation 1', zone: 'Dev Pod' },
  { id: 'desk-2', x: 130, y: 125, name: 'Workstation 2', zone: 'Dev Pod' },
  { id: 'desk-3', x: 200, y: 125, name: 'Workstation 3', zone: 'Dev Pod' },
  { id: 'desk-4', x: 60,  y: 255, name: 'Workstation 4', zone: 'Design Pod' },
  { id: 'desk-5', x: 130, y: 255, name: 'Workstation 5', zone: 'Design Pod' },
  { id: 'desk-6', x: 200, y: 255, name: 'Workstation 6', zone: 'Design Pod' },
  { id: 'booth-1', x: 387, y: 310, name: 'Focus Booth A', zone: 'Silent Pod' },
  { id: 'booth-2', x: 457, y: 310, name: 'Focus Booth B', zone: 'Silent Pod' },
];

/**
 * Returns obstacle array for the current room
 */
export function getRoomObstacles(currentRoom = 'general', isPrivate = false) {
  if (isPrivate || (typeof currentRoom === 'string' && currentRoom.startsWith('PRV-'))) {
    return PRIVATE_OBSTACLES;
  }
  if (currentRoom === 'meeting') return MEETING_OBSTACLES;
  if (currentRoom === 'focus')   return FOCUS_OBSTACLES;
  return GENERAL_OBSTACLES;
}

/**
 * Checks if a given coordinate collides with any solid office furniture in the active room
 */
export function checkCollision(x, y, radius = 10, currentRoom = 'general', isPrivate = false) {
  const obstacles = getRoomObstacles(currentRoom, isPrivate);
  return obstacles.some((obs) => {
    return (
      x + radius > obs.x &&
      x - radius < obs.x + obs.w &&
      y + radius > obs.y &&
      y - radius < obs.y + obs.h
    );
  });
}

/**
 * Finds the nearest workstation within interaction range (35px)
 */
export function findNearbyWorkstation(x, y, threshold = 35) {
  for (const ws of GENERAL_WORKSTATIONS) {
    const d = Math.hypot(ws.x - x, ws.y - y);
    if (d <= threshold) return ws;
  }
  return null;
}

/**
 * Helper to determine which zone a coordinate falls into
 */
export function getCurrentZone(x, y, currentRoom = 'general', roomInfo = {}) {
  const zones = getRoomZones(currentRoom, roomInfo);
  for (const z of zones) {
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
      return z;
    }
  }
  return { name: 'Office Corridor', category: 'WALKWAY', icon: '🚶', color: '#f8fafc' };
}

// ── Helper: Draw a Rounded Rectangle Path ───────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Helper: Draw a Lush Potted Office Plant ──────────────────────────────────
function drawPlant(ctx, x, y, size = 12) {
  ctx.save();
  // Ceramic pot shadow
  ctx.beginPath();
  ctx.ellipse(x, y + size * 0.8, size * 0.7, size * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
  ctx.fill();

  // Ceramic pot body (glazed white/terracotta)
  ctx.beginPath();
  ctx.moveTo(x - size * 0.6, y);
  ctx.lineTo(x - size * 0.45, y + size * 0.8);
  ctx.lineTo(x + size * 0.45, y + size * 0.8);
  ctx.lineTo(x + size * 0.6, y);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#d4c2ad'; // warm terracotta rim
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Plant leaves (Monstera / Fiddle-leaf greens)
  const leaves = [
    { dx: -size * 0.6, dy: -size * 0.4, r: size * 0.45, col: '#10b981' },
    { dx:  size * 0.5, dy: -size * 0.5, r: size * 0.48, col: '#059669' },
    { dx: -size * 0.2, dy: -size * 0.8, r: size * 0.52, col: '#047857' },
    { dx:  size * 0.2, dy: -size * 0.7, r: size * 0.46, col: '#10b981' },
    { dx:           0, dy: -size * 0.3, r: size * 0.35, col: '#34d399' },
  ];
  leaves.forEach((leaf) => {
    ctx.beginPath();
    ctx.ellipse(x + leaf.dx, y + leaf.dy, leaf.r, leaf.r * 0.65, Math.PI / 4, 0, Math.PI * 2);
    ctx.fillStyle = leaf.col;
    ctx.fill();
  });
  ctx.restore();
}

// ── Helper: Draw a Modern Workstation Desk with Dual Monitors & Chair ────────
function drawWorkstation(ctx, x, y, w = 50, h = 32, label = '', isOccupied = false, occupantName = '') {
  ctx.save();
  // Desk elevation shadow
  ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
  roundRect(ctx, x + 2, y + 2, w, h, 4);
  ctx.fill();

  // Desk surface (warm natural oak laminate)
  ctx.fillStyle = '#fffdfa';
  ctx.strokeStyle = '#e2d5c3';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.stroke();

  // Desk protective mat / blotter
  ctx.fillStyle = '#f1f5f9';
  roundRect(ctx, x + 5, y + 4, w - 10, h - 8, 2);
  ctx.fill();

  // Dual computer monitors with glowing cyan & blue IDE / metrics lines
  // Monitor 1 (Left, angled)
  ctx.fillStyle = '#0f172a';
  roundRect(ctx, x + 7, y + 5, 16, 4, 1);
  ctx.fill();
  ctx.fillStyle = '#06b6d4'; // Cyan screen glow
  ctx.fillRect(x + 8, y + 6, 14, 2);

  // Monitor 2 (Right)
  ctx.fillStyle = '#0f172a';
  roundRect(ctx, x + 26, y + 5, 16, 4, 1);
  ctx.fill();
  ctx.fillStyle = '#2563eb'; // Blue screen glow
  ctx.fillRect(x + 27, y + 6, 14, 2);

  // Mechanical Keyboard
  ctx.fillStyle = '#e2e8f0';
  roundRect(ctx, x + w / 2 - 8, y + 13, 16, 6, 1);
  ctx.fill();
  // Spacebar accent
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(x + w / 2 - 4, y + 17, 8, 1);

  // Mousepad & optical mouse
  ctx.fillStyle = '#334155';
  ctx.fillRect(x + w - 12, y + 14, 5, 6);
  ctx.fillStyle = '#ef4444'; // Red mouse laser dot
  ctx.fillRect(x + w - 10, y + 16, 1.5, 1.5);

  // Ergonomic Task Chair behind desk
  const chairX = x + w / 2;
  const chairY = y + h + 8;

  // Chair shadow
  ctx.beginPath();
  ctx.arc(chairX, chairY + 1, 8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
  ctx.fill();

  // Chair cushion
  ctx.beginPath();
  ctx.arc(chairX, chairY, 7.5, 0, Math.PI * 2);
  ctx.fillStyle = isOccupied ? '#10b981' : '#2563eb';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Desk Label & Occupancy status
  ctx.fillStyle = '#64748b';
  ctx.font = '600 8px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const displayLabel = isOccupied && occupantName ? `👤 ${occupantName}` : label;
  ctx.fillText(displayLabel, x + w / 2, y - 2);

  ctx.restore();
}

// ── Helper: Draw Reception Area Desk & Branded Welcome Mat ───────────────────
function drawReceptionDesk(ctx, x = 35, y = 395, w = 95, h = 42) {
  ctx.save();
  // Branded Welcome Rug in front of reception
  ctx.fillStyle = '#eaf2ff';
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 1.2;
  roundRect(ctx, x + 5, y + h + 8, w - 10, 24, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#1e40af';
  ctx.font = 'bold 8px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PROXISPEAK VIRTUAL OFFICE', x + w / 2, y + h + 20);

  // Reception desk shadow
  ctx.fillStyle = 'rgba(15, 23, 42, 0.1)';
  roundRect(ctx, x + 2, y + 2, w, h, 8);
  ctx.fill();

  // Reception curved wooden counter facade
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#d4c2ad';
  ctx.lineWidth = 1.8;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();

  // Quartz Countertop trim
  ctx.fillStyle = '#f8fafc';
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 3, y + 3, w - 6, 12, 4);
  ctx.fill();
  ctx.stroke();

  // Check-in iPad / visitor terminal
  ctx.fillStyle = '#0f172a';
  roundRect(ctx, x + w / 2 - 9, y + 5, 18, 8, 1.5);
  ctx.fill();
  ctx.fillStyle = '#06b6d4'; // Glowing welcome screen
  ctx.fillRect(x + w / 2 - 7, y + 6, 14, 6);

  // Receptionist chair
  ctx.beginPath();
  ctx.arc(x + w / 2, y - 6, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#1e3a8a';
  ctx.fill();

  // Signage pill
  ctx.fillStyle = '#172554';
  ctx.font = 'bold 9px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RECEPTION', x + w / 2, y + 28);

  ctx.restore();
}

// ── Helper: Draw Glass Conference Meeting Suite ──────────────────────────────
function drawGlassMeetingSuite(ctx, cx = 650, cy = 105, w = 160, h = 70) {
  ctx.save();
  // Glass partition enclosure
  ctx.fillStyle = 'rgba(6, 182, 212, 0.05)';
  ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
  ctx.lineWidth = 2;
  roundRect(ctx, 520, 20, 260, 180, 10);
  ctx.fill();
  ctx.stroke();

  // Doorway opening indicator (gap in glass wall)
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(520, 135);
  ctx.lineTo(520, 175);
  ctx.stroke();

  // 75" 4K Presentation Display Wall Screen
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 590, 25, 120, 8, 2);
  ctx.fill();
  ctx.stroke();
  // Chart graphics on screen
  ctx.fillStyle = '#06b6d4'; ctx.fillRect(600, 27, 8, 4);
  ctx.fillStyle = '#3b82f6'; ctx.fillRect(612, 26, 14, 5);
  ctx.fillStyle = '#10b981'; ctx.fillRect(630, 27, 10, 4);

  // Executive Boardroom Table
  ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
  roundRect(ctx, cx - w / 2 + 3, cy - h / 2 + 3, w, h, 14);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 2;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 14);
  ctx.fill();
  ctx.stroke();

  // Walnut wood center insert
  ctx.fillStyle = '#fef3c7';
  roundRect(ctx, cx - w / 3, cy - 8, (w / 3) * 2, 16, 6);
  ctx.fill();

  // Speakerphone puck
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#2563eb';
  ctx.fill();

  // 8 Executive Leather Chairs around table
  const chairCols = 4;
  const spacing = (w - 30) / (chairCols - 1);
  for (let i = 0; i < chairCols; i++) {
    const chairX = cx - w / 2 + 15 + i * spacing;
    // Top chairs
    ctx.beginPath(); ctx.arc(chairX, cy - h / 2 - 8, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#1e3a8a'; ctx.fill();
    // Bottom chairs
    ctx.beginPath(); ctx.arc(chairX, cy + h / 2 + 8, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#1e3a8a'; ctx.fill();
  }
  ctx.restore();
}

// ── Helper: Draw Acoustic Focus Telephone Booth ──────────────────────────────
function drawFocusBooth(ctx, x, y, w = 55, h = 65, label = 'Booth', isOccupied = false) {
  ctx.save();
  // Soundproof booth outer shadow
  ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
  roundRect(ctx, x + 2, y + 2, w, h, 6);
  ctx.fill();

  // Acoustic felt exterior
  ctx.fillStyle = '#f8fafc';
  ctx.strokeStyle = isOccupied ? '#ef4444' : '#0d9488';
  ctx.lineWidth = 1.8;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();

  // Acoustic diamond padding texture
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);

  // Interior desk shelf
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 8, y + 10, w - 16, 16, 2);
  ctx.fill();
  ctx.stroke();

  // Laptop on desk
  ctx.fillStyle = '#0f172a';
  roundRect(ctx, x + w / 2 - 6, y + 12, 12, 4, 1);
  ctx.fill();
  ctx.fillStyle = '#0d9488'; // Screen light
  ctx.fillRect(x + w / 2 - 5, y + 13, 10, 2);

  // Stool inside booth
  ctx.beginPath();
  ctx.arc(x + w / 2, y + 42, 6, 0, Math.PI * 2);
  ctx.fillStyle = isOccupied ? '#ef4444' : '#0d9488';
  ctx.fill();

  // Status Badge / Name
  ctx.fillStyle = isOccupied ? '#ef4444' : '#0f766e';
  ctx.font = 'bold 8px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(isOccupied ? 'BUSY' : label, x + w / 2, y + h - 5);

  ctx.restore();
}

// ── Helper: Draw Coffee Corner Kitchenette & Water Cooler ────────────────────
function drawCoffeeBar(ctx, x = 220, y = 385, w = 150, h = 45) {
  ctx.save();
  // Bar shadow
  ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
  roundRect(ctx, x + 2, y + 2, w, h, 6);
  ctx.fill();

  // Marble & oak counter surface
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#d4c2ad';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();

  // Italian Espresso Machine (Stainless steel chrome)
  ctx.fillStyle = '#334155';
  roundRect(ctx, x + 16, y + 8, 28, 24, 3);
  ctx.fill();
  ctx.fillStyle = '#06b6d4'; // Pressure dial / power LED
  ctx.beginPath(); ctx.arc(x + 30, y + 15, 3, 0, Math.PI * 2); ctx.fill();

  // Ceramic Coffee Mugs on counter
  ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(x + 58, y + 16, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#3b82f6'; ctx.beginPath(); ctx.arc(x + 70, y + 20, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#10b981'; ctx.beginPath(); ctx.arc(x + 82, y + 16, 4, 0, Math.PI * 2); ctx.fill();

  // 5-Gallon Blue Water Cooler
  ctx.fillStyle = '#f8fafc';
  roundRect(ctx, x + w - 34, y + 10, 22, 28, 3);
  ctx.fill();
  ctx.strokeStyle = '#cbd5e1'; ctx.stroke();
  // Blue bottle
  ctx.fillStyle = '#0284c7';
  ctx.beginPath(); ctx.arc(x + w - 23, y + 10, 8, 0, Math.PI * 2); ctx.fill();

  // Barstools along the bottom of the counter
  for (let i = 0; i < 3; i++) {
    const stoolX = x + 40 + i * 36;
    ctx.beginPath(); ctx.arc(stoolX, y + h + 8, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#0284c7'; ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }

  // Label
  ctx.fillStyle = '#172554';
  ctx.font = 'bold 8.5px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('REFRESHMENT CAFE', x + w / 2, y + 36);

  ctx.restore();
}

// ── Helper: Draw Lounge Breakout Sectional & Table ───────────────────────────
function drawLoungeSectional(ctx, x = 460, y = 380, w = 140, h = 50) {
  ctx.save();
  // Sofa shadow
  ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
  roundRect(ctx, x + 2, y + 2, w, h, 8);
  ctx.fill();

  // Sofa Upholstery (Slate Navy)
  ctx.fillStyle = '#f1f5f9';
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();

  // Cushions
  ctx.fillStyle = '#e2e8f0';
  roundRect(ctx, x + 6, y + 6, w / 2 - 9, h - 12, 4);
  ctx.fill();
  roundRect(ctx, x + w / 2 + 3, y + 6, w / 2 - 9, h - 12, 4);
  ctx.fill();

  // Scandinavian Round Coffee Table
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h + 16, 20, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Mobile Ideation Whiteboard on Casters
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x + w + 15, y + 6, 12, 42, 2);
  ctx.fill();
  ctx.stroke();
  // Colorful sticky notes
  ctx.fillStyle = '#fef08a'; ctx.fillRect(x + w + 18, y + 12, 6, 6);
  ctx.fillStyle = '#fbcfe8'; ctx.fillRect(x + w + 18, y + 22, 6, 6);
  ctx.fillStyle = '#bae6fd'; ctx.fillRect(x + w + 18, y + 32, 6, 6);

  ctx.restore();
}

// ── Room-Specific Architectural Plans ───────────────────────────────────────
function drawGeneralOfficePlan(ctx, occupiedDesks = {}) {
  // 1. RECEPTION AREA (Bottom-Left)
  drawReceptionDesk(ctx, 35, 395, 95, 42);
  drawPlant(ctx, 142, 400, 13);

  // 2. WORKSTATIONS CLUSTER 1 (Top-Left: Dev Pod 1, 2, 3)
  drawWorkstation(ctx, 35,  65, 50, 32, 'Desk 1', !!occupiedDesks['desk-1'], occupiedDesks['desk-1']?.name);
  drawWorkstation(ctx, 105, 65, 50, 32, 'Desk 2', !!occupiedDesks['desk-2'], occupiedDesks['desk-2']?.name);
  drawWorkstation(ctx, 175, 65, 50, 32, 'Desk 3', !!occupiedDesks['desk-3'], occupiedDesks['desk-3']?.name);
  drawPlant(ctx, 235, 42, 12);

  // 3. WORKSTATIONS CLUSTER 2 (Mid-Left: Design Pod 4, 5, 6)
  drawWorkstation(ctx, 35,  195, 50, 32, 'Desk 4', !!occupiedDesks['desk-4'], occupiedDesks['desk-4']?.name);
  drawWorkstation(ctx, 105, 195, 50, 32, 'Desk 5', !!occupiedDesks['desk-5'], occupiedDesks['desk-5']?.name);
  drawWorkstation(ctx, 175, 195, 50, 32, 'Desk 6', !!occupiedDesks['desk-6'], occupiedDesks['desk-6']?.name);
  drawPlant(ctx, 235, 230, 12);

  // 4. COLLABORATION HUB (Center-Top)
  // Standup Whiteboard
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 315, 32, 140, 10, 2);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fef08a'; ctx.fillRect(330, 34, 6, 6);
  ctx.fillStyle = '#fbcfe8'; ctx.fillRect(344, 34, 6, 6);
  ctx.fillStyle = '#bae6fd'; ctx.fillRect(358, 34, 6, 6);
  ctx.restore();

  // Collaboration round table
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.ellipse(390, 110, 32, 22, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  ctx.restore();

  // 5. ACOUSTIC FOCUS TELEPHONE BOOTHS (Center-Mid)
  drawFocusBooth(ctx, 360, 235, 55, 65, 'Booth A', !!occupiedDesks['booth-1']);
  drawFocusBooth(ctx, 430, 235, 55, 65, 'Booth B', !!occupiedDesks['booth-2']);
  drawPlant(ctx, 340, 270, 11);

  // 6. GLASS MEETING ROOM SUITE (Top-Right)
  drawGlassMeetingSuite(ctx, 650, 105, 160, 70);

  // 7. REFRESHMENT & CAFE CORNER (Bottom-Center)
  drawCoffeeBar(ctx, 210, 385, 150, 45);

  // 8. COLLABORATION BREAKOUT LOUNGE (Bottom-Right)
  drawLoungeSectional(ctx, 460, 380, 140, 50);
  drawPlant(ctx, 420, 390, 13);
  drawPlant(ctx, 640, 400, 14);
  drawPlant(ctx, 755, 395, 14);
}

function drawMeetingRoomPlan(ctx) {
  // Main Stage Video Wall
  ctx.save();
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  roundRect(ctx, 220, 30, 360, 14, 3);
  ctx.fill(); ctx.stroke();
  ctx.restore();

  // Grand Boardroom Table
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 2;
  roundRect(ctx, 200, 160, 400, 110, 16);
  ctx.fill(); ctx.stroke();
  ctx.restore();

  // Presentation podium
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 370, 60, 60, 24, 4);
  ctx.fill(); ctx.stroke();
  ctx.restore();

  // Plants
  drawPlant(ctx, 80, 70, 16);
  drawPlant(ctx, 720, 70, 16);
  drawPlant(ctx, 80, 410, 16);
  drawPlant(ctx, 720, 410, 16);

  // Discussion Lounges at bottom
  drawLoungeSectional(ctx, 160, 390, 140, 50);
  drawLoungeSectional(ctx, 500, 390, 140, 50);
}

function drawFocusRoomPlan(ctx) {
  // 4 Private Acoustic Deep-Work Pods
  const pods = [
    { x: 40,  y: 40,  w: 330, h: 180, name: 'Deep Work Pod 01' },
    { x: 430, y: 40,  w: 330, h: 180, name: 'Deep Work Pod 02' },
    { x: 40,  y: 260, w: 330, h: 190, name: 'Deep Work Pod 03' },
    { x: 430, y: 260, w: 330, h: 190, name: 'Deep Work Pod 04' },
  ];

  pods.forEach((p) => {
    drawWorkstation(ctx, p.x + 30,  p.y + 50, 60, 38, 'Station A');
    drawWorkstation(ctx, p.x + 130, p.y + 50, 60, 38, 'Station B');
    drawWorkstation(ctx, p.x + 230, p.y + 50, 60, 38, 'Station C');
    drawPlant(ctx, p.x + p.w - 24, p.y + p.h - 24, 13);
  });
}

function drawPrivateRoomPlan(ctx, _roomTitle = 'Private Meeting') {
  // Executive Boardroom Suite
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#c4b5fd';
  ctx.lineWidth = 2;
  roundRect(ctx, 170, 120, 460, 130, 16);
  ctx.fill(); ctx.stroke();

  // Big screen on top
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth = 2;
  roundRect(ctx, 240, 30, 320, 12, 3);
  ctx.fill(); ctx.stroke();

  // Executive lounge below
  drawLoungeSectional(ctx, 150, 380, 160, 54);
  drawLoungeSectional(ctx, 490, 380, 160, 54);

  drawPlant(ctx, 90, 60, 16);
  drawPlant(ctx, 710, 60, 16);
  drawPlant(ctx, 90, 410, 16);
  drawPlant(ctx, 710, 410, 16);
  ctx.restore();
}

// ── Room Zones Architecture Metadata ─────────────────────────────────────────
export const GENERAL_ZONES = [
  { x: 20,  y: 20,  w: 245, h: 300, name: 'DEV & ENGINEERING', category: 'WORKSTATIONS', color: '#f8fafc', border: '#e2e8f0', badgeBg: '#2563eb', icon: '💻' },
  { x: 285, y: 20,  w: 215, h: 180, name: 'COLLABORATION HUB', category: 'TEAM SYNC',    color: '#eff6ff', border: '#93c5fd', badgeBg: '#0284c7', icon: '💡' },
  { x: 515, y: 20,  w: 265, h: 185, name: 'GLASS CONFERENCE',  category: 'MEETING SUITE',color: '#f0fdfa', border: '#5eead4', badgeBg: '#0f766e', icon: '📊' },
  { x: 20,  y: 340, w: 165, h: 140, name: 'RECEPTION',         category: 'WELCOME',      color: '#fffbf5', border: '#fed7aa', badgeBg: '#c2410c', icon: '🏢' },
  { x: 200, y: 340, w: 220, h: 140, name: 'REFRESHMENT CAFE',  category: 'KITCHENETTE',  color: '#fefce8', border: '#fef08a', badgeBg: '#a16207', icon: '☕' },
  { x: 440, y: 340, w: 340, h: 140, name: 'BREAKOUT LOUNGE',   category: 'SOCIAL',       color: '#faf5ff', border: '#e9d5ff', badgeBg: '#7e22ce', icon: '🛋️' },
];

export const MEETING_ZONES = [
  { x: 20,  y: 20,  w: 760, h: 320, name: 'BOARDROOM & STAGE', category: 'CONFERENCE', color: '#eff6ff', border: '#93c5fd', badgeBg: '#1d4ed8', icon: '👥' },
  { x: 20,  y: 360, w: 760, h: 120, name: 'DISCUSSION LOUNGE',category: 'HUDDLE',     color: '#f0f9ff', border: '#bae6fd', badgeBg: '#0284c7', icon: '💬' },
];

export const FOCUS_ZONES = [
  { x: 20,  y: 20,  w: 370, h: 220, name: 'SILENT POD A', category: 'DEEP WORK', color: '#f0fdfa', border: '#99f6e4', badgeBg: '#0f766e', icon: '🎧' },
  { x: 410, y: 20,  w: 370, h: 220, name: 'SILENT POD B', category: 'DEEP WORK', color: '#f0fdfa', border: '#99f6e4', badgeBg: '#0f766e', icon: '🎧' },
  { x: 20,  y: 255, w: 370, h: 225, name: 'STUDY POD C',  category: 'READING',   color: '#f8fafc', border: '#cbd5e1', badgeBg: '#475569', icon: '📚' },
  { x: 410, y: 255, w: 370, h: 225, name: 'STUDY POD D',  category: 'RESEARCH',  color: '#f8fafc', border: '#cbd5e1', badgeBg: '#475569', icon: '🔬' },
];

export function getRoomZones(currentRoom, roomInfo) {
  if (roomInfo?.isPrivate) {
    const title = (roomInfo.title || 'Private Meeting').toUpperCase();
    return [
      { x: 20, y: 20,  w: 760, h: 330, name: title,           category: 'PRIVATE SUITE', color: '#faf5ff', border: '#ddd6fe', badgeBg: '#7c3aed', icon: '🔒' },
      { x: 20, y: 365, w: 760, h: 115, name: 'PRIVATE LOUNGE',category: 'EXECUTIVE',     color: '#ffffff', border: '#e2e8f0', badgeBg: '#475569', icon: '🍸' },
    ];
  }
  if (currentRoom === 'meeting') return MEETING_ZONES;
  if (currentRoom === 'focus')   return FOCUS_ZONES;
  return GENERAL_ZONES;
}

/**
 * 2D Canvas Driver Hook
 */
export function useOfficeCanvas(
  canvasRef,
  usersRef,
  myId,
  currentRoom = 'general',
  roomInfo = {},
  profile = null,
  occupiedDesks = {},
  currentWorkstation = null,
  waypoint = null
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set logical canvas resolution
    canvas.width  = LOGICAL_W;
    canvas.height = LOGICAL_H;

    const ctx = canvas.getContext('2d');
    let frameId;
    let pulseAngle = 0;

    // Real-time FPS & frame-time profiling probe
    let lastFrameTime = performance.now();
    let fpsHistory = [];
    let currentFps = 60;
    let frameDelta = 16.6;

    function draw() {
      const now = performance.now();
      const delta = now - lastFrameTime;
      lastFrameTime = now;

      if (delta > 0 && delta < 500) {
        fpsHistory.push(1000 / delta);
        if (fpsHistory.length > 30) fpsHistory.shift();
        const avg = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;
        currentFps = Math.min(60, Math.round(avg));
        frameDelta = Number(delta.toFixed(1));
      }

      ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
      pulseAngle = (pulseAngle + 0.04) % (Math.PI * 2);

      // ── 1. Floor Base & Modern Tile Texture ───────────────────
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

      // Light modern architectural plank / tile grid
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      for (let x = 0; x <= LOGICAL_W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, LOGICAL_H); ctx.stroke();
      }
      for (let y = 0; y <= LOGICAL_H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(LOGICAL_W, y); ctx.stroke();
      }

      // Outer boundary wall trim with soft 3D molding
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 3;
      ctx.strokeRect(2, 2, LOGICAL_W - 4, LOGICAL_H - 4);

      // ── 2. Distinct Office Zone Carpets ────────────────────────
      const zones = getRoomZones(currentRoom, roomInfo);
      zones.forEach((z) => {
        // Drop shadow under zone rug
        ctx.fillStyle = 'rgba(15, 23, 42, 0.04)';
        roundRect(ctx, z.x + 3, z.y + 3, z.w, z.h, 12);
        ctx.fill();

        // Zone carpet body
        ctx.fillStyle = z.color;
        ctx.strokeStyle = z.border;
        ctx.lineWidth = 1.8;
        roundRect(ctx, z.x, z.y, z.w, z.h, 12);
        ctx.fill();
        ctx.stroke();

        // Zone Header Badge (Floating, High-Contrast Navy/Pill)
        ctx.save();
        const badgeText = `${z.icon}  ${z.name}`;
        ctx.font = 'bold 10.5px Inter, -apple-system, sans-serif';
        const textW = ctx.measureText(badgeText).width;

        // Badge pill background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.strokeStyle = z.border;
        ctx.lineWidth = 1.2;
        roundRect(ctx, z.x + 10, z.y + 8, textW + 20, 20, 6);
        ctx.fill();
        ctx.stroke();

        // Badge label
        ctx.fillStyle = '#172554';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(badgeText, z.x + 18, z.y + 18);

        // Category pill tag (e.g., WORKSTATIONS, KITCHENETTE, SOCIAL)
        if (z.category) {
          ctx.font = '700 8px Inter, sans-serif';
          const catW = ctx.measureText(z.category).width;
          const catX = z.x + textW + 36;
          ctx.fillStyle = z.badgeBg || '#2563eb';
          roundRect(ctx, catX, z.y + 10, catW + 10, 16, 999);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.fillText(z.category, catX + (catW + 10) / 2, z.y + 18);
        }
        ctx.restore();
      });

      // ── 3. Architectural Furniture & Desks ─────────────────────
      if (roomInfo?.isPrivate) {
        drawPrivateRoomPlan(ctx, roomInfo.title);
      } else if (currentRoom === 'meeting') {
        drawMeetingRoomPlan(ctx);
      } else if (currentRoom === 'focus') {
        drawFocusRoomPlan(ctx);
      } else {
        drawGeneralOfficePlan(ctx, occupiedDesks);
      }

      // ── 4. Participants List (Authoritative or Local Preview) ──
      const liveUsers = usersRef.current || [];
      let usersToRender = liveUsers;

      // If user is offline or not yet received from server, draw local preview avatar
      if (usersToRender.length === 0) {
        usersToRender = [
          {
            id: myId || 'local-preview',
            name: profile?.name || 'You',
            x: 360,
            y: 330,
            micEnabled: false,
            avatarColor: profile?.avatarColor || '#2563eb',
            avatarStyle: profile?.avatarStyle || 'classic',
            status: profile?.status || 'online',
          },
        ];
      }

      // ── 5. Spatial Audio Earshot Proximity Rings ────────────────
      const me = usersToRender.find((u) => u.id === myId) || usersToRender[0];
      if (me) {
        const mx = Math.max(20, Math.min(LOGICAL_W - 20, me.x));
        const my = Math.max(20, Math.min(LOGICAL_H - 20, me.y));

        // Soft radial ambient glow
        const radGrad = ctx.createRadialGradient(mx, my, 8, mx, my, EARSHOT_RADIUS);
        radGrad.addColorStop(0, 'rgba(37, 99, 235, 0.12)');
        radGrad.addColorStop(0.7, 'rgba(6, 182, 212, 0.05)');
        radGrad.addColorStop(1, 'rgba(6, 182, 212, 0.0)');
        ctx.fillStyle = radGrad;
        ctx.beginPath();
        ctx.arc(mx, my, EARSHOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        // Earshot boundary stroke
        ctx.save();
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(mx, my, EARSHOT_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // If sitting at workstation, draw an active focus halo
        if (currentWorkstation) {
          ctx.beginPath();
          ctx.arc(mx, my, 28, 0, Math.PI * 2);
          ctx.strokeStyle = '#06b6d4';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // ── 5b. Interactive Navigation Waypoint Marker ─────────────
      if (waypoint) {
        const wx = Math.max(20, Math.min(LOGICAL_W - 20, waypoint.x));
        const wy = Math.max(20, Math.min(LOGICAL_H - 20, waypoint.y));
        const pulseR = 12 + Math.sin(pulseAngle * 2) * 3;

        ctx.save();
        // Path dash line from player to waypoint
        if (me) {
          ctx.beginPath();
          ctx.moveTo(me.x, me.y);
          ctx.lineTo(wx, wy);
          ctx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
        }

        // Target outer ring
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(wx, wy, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        // Target center blip
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(wx, wy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#06b6d4';
        ctx.fill();

        ctx.restore();
      }

      // ── 6. Render Participant Avatars ──────────────────────────
      usersToRender.forEach((user) => {
        const x      = Math.max(20, Math.min(LOGICAL_W - 20, user.x));
        const y      = Math.max(20, Math.min(LOGICAL_H - 20, user.y));
        const isMe   = user.id === myId || user.id === 'local-preview';
        const color  = user.avatarColor || (isMe ? '#2563eb' : getAvatarColor(user.id));
        const isAway = user.status === 'away';
        const isBusy = user.status === 'busy';

        ctx.save();
        if (isAway) {
          ctx.globalAlpha = 0.85;
        }

        // Active Speaker Pulse Halo (when micEnabled is true)
        if (user.micEnabled) {
          const pulseR = 26 + Math.sin(pulseAngle) * 3;
          ctx.beginPath();
          ctx.arc(x, y, pulseR, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Avatar outer drop shadow
        ctx.beginPath();
        ctx.arc(x, y + 2, 20, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.16)';
        ctx.fill();

        // Avatar body circle with 3D radial lighting
        ctx.beginPath();
        ctx.arc(x, y, 18, 0, Math.PI * 2);
        const avatarGrad = ctx.createRadialGradient(x - 5, y - 5, 2, x, y, 18);
        avatarGrad.addColorStop(0, '#ffffff');
        avatarGrad.addColorStop(0.3, color);
        avatarGrad.addColorStop(1, color);
        ctx.fillStyle = avatarGrad;
        ctx.fill();

        // Crisp white border
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Style badge overlay chip (Star, Crown, Diamond)
        if (user.avatarStyle && user.avatarStyle !== 'classic') {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x - 13, y - 13, 9, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (user.avatarStyle === 'star')    ctx.fillText('⭐', x - 13, y - 13);
          if (user.avatarStyle === 'crown')   ctx.fillText('👑', x - 13, y - 13);
          if (user.avatarStyle === 'diamond') ctx.fillText('💎', x - 13, y - 13);
          ctx.restore();
        }

        // Initials / "ME"
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Inter, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const rawName = user.name || (isMe ? 'You' : 'Guest');
        const initials = isMe ? 'YOU' : rawName.slice(0, 2).toUpperCase();
        ctx.fillText(initials, x, y);

        // Active Mic Badge
        if (user.micEnabled) {
          ctx.beginPath();
          ctx.arc(x + 13, y - 13, 7, 0, Math.PI * 2);
          ctx.fillStyle = '#10b981'; // Green active
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('🎙️', x + 13, y - 13);
        }

        // 3-Tier Availability Status dot (Online = #10b981, Busy = #ef4444, Away = #f59e0b)
        ctx.beginPath();
        ctx.arc(x + 13, y + 13, 5, 0, Math.PI * 2);
        ctx.fillStyle = isBusy ? '#ef4444' : (isAway ? '#f59e0b' : '#10b981');
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // High-Contrast Name Label Pill
        const label = isMe ? `${user.name || 'You'} (You)` : (user.name || 'Guest');
        ctx.font = '600 11px Inter, -apple-system, sans-serif';
        const labelW = ctx.measureText(label).width;

        // Label pill background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
        roundRect(ctx, x - labelW / 2 - 6, y + 23, labelW + 12, 18, 5);
        ctx.fill();
        ctx.strokeStyle = '#dce6f5';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Label text
        ctx.fillStyle = '#172554';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, y + 32);

        ctx.restore();
      });

      // ── 7. Performance FPS & Render Diagnostics Probe ────────────
      ctx.save();
      ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      const perfText = `${currentFps} FPS • ${frameDelta}ms`;
      const perfW = ctx.measureText(perfText).width;
      const px = LOGICAL_W - perfW - 22;
      const py = LOGICAL_H - 24;

      // Dark translucent pill
      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
      roundRect(ctx, px - 8, py - 3, perfW + 16, 18, 5);
      ctx.fill();

      // Green dot if >= 55 FPS, yellow if >= 30, red if < 30
      ctx.beginPath();
      ctx.arc(px - 1, py + 6, 3, 0, Math.PI * 2);
      ctx.fillStyle = currentFps >= 50 ? '#10b981' : (currentFps >= 30 ? '#f59e0b' : '#ef4444');
      ctx.fill();

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(perfText, px + 6, py + 6);
      ctx.restore();

      frameId = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(frameId);
  }, [canvasRef, usersRef, myId, currentRoom, roomInfo, profile, occupiedDesks, currentWorkstation, waypoint]);
}
