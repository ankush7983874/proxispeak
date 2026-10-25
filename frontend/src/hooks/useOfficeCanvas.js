/**
 * useOfficeCanvas.js
 * Drives the 2D virtual-office canvas drawing loop using requestAnimationFrame.
 * Renders: floor grid, named zones, proximity rings, and all user avatars.
 *
 * COORDINATE SYSTEM
 * The logical canvas size is 800 × 500. The HTML canvas element is CSS-scaled
 * to fill its container. Avatar positions from the server use logical pixels.
 */
import { useEffect } from 'react';
import { EARSHOT_RADIUS, distance } from '../utils/proximity.js';

const LOGICAL_W = 800;
const LOGICAL_H = 500;

// Room-specific zone definitions
const GENERAL_ZONES = [
  { x: 24,  y: 24,  w: 220, h: 130, name: 'FOCUS ZONE',     color: '#f0faf5', border: '#c4e8d4' },
  { x: 268, y: 24,  w: 220, h: 130, name: 'COLLABORATION',  color: '#f5f0ff', border: '#d4c4f0' },
  { x: 512, y: 24,  w: 220, h: 130, name: 'MEETING SPACE',  color: '#f0f5ff', border: '#c4d4f0' },
  { x: 24,  y: 340, w: 708, h: 136, name: 'COMMON AREA',    color: '#fffaf0', border: '#f0e4c4' },
];

const MEETING_ZONES = [
  { x: 260, y: 24,  w: 280, h: 85,  name: 'MAIN SCREEN / STAGE', color: '#eef4ff', border: '#bad2fa' },
  { x: 160, y: 135, w: 480, h: 220, name: 'CONFERENCE TABLE',    color: '#f8faff', border: '#cfdefa' },
  { x: 24,  y: 380, w: 752, h: 96,  name: 'DISCUSSION LOUNGE',   color: '#fbf8ff', border: '#dfd2f7' },
];

const FOCUS_ZONES = [
  { x: 24,  y: 24,  w: 360, h: 200, name: 'SILENT STUDY POD 1', color: '#fcfbf8', border: '#e8e2d4' },
  { x: 416, y: 24,  w: 360, h: 200, name: 'SILENT STUDY POD 2', color: '#fcfbf8', border: '#e8e2d4' },
  { x: 24,  y: 248, w: 360, h: 228, name: 'DEEP WORK ZONE A',   color: '#f5faf6', border: '#d2e7d7' },
  { x: 416, y: 248, w: 360, h: 228, name: 'DEEP WORK ZONE B',   color: '#f5faf6', border: '#d2e7d7' },
];

function getRoomZones(currentRoom, roomInfo) {
  if (roomInfo?.isPrivate) {
    const title = roomInfo.title ? roomInfo.title.toUpperCase() : 'PRIVATE MEETING ROOM';
    return [
      { x: 80,  y: 40,  w: 640, h: 320, name: title,            color: '#faf7ff', border: '#d9c9f7' },
      { x: 80,  y: 385, w: 640, h: 90,  name: 'EXECUTIVE LOUNGE', color: '#fdfbf8', border: '#ede6da' },
    ];
  }
  if (currentRoom === 'meeting') return MEETING_ZONES;
  if (currentRoom === 'focus')   return FOCUS_ZONES;
  return GENERAL_ZONES;
}

// Avatar palette fallback
const AVATAR_COLORS = [
  '#259765', '#6478d9', '#d9647a', '#d9a064', '#64c8d9',
  '#9664d9', '#64d978', '#d9d064', '#d964c8', '#06b6d4',
];

function getAvatarColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/**
 * @param {React.RefObject<HTMLCanvasElement>} canvasRef
 * @param {React.RefObject<Array>} usersRef — live ref, updated outside this hook
 * @param {string} myId
 * @param {string} [currentRoom]
 * @param {object} [roomInfo]
 */
export function useOfficeCanvas(canvasRef, usersRef, myId, currentRoom = 'general', roomInfo = {}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set logical resolution
    canvas.width  = LOGICAL_W;
    canvas.height = LOGICAL_H;

    const ctx = canvas.getContext('2d');
    let frameId;

    function draw() {
      ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

      // ── Floor Background ────────────────────────────────────
      const isFocus = currentRoom === 'focus';
      const isMeet  = currentRoom === 'meeting';
      const isPriv  = roomInfo?.isPrivate;

      const floorColor = isFocus ? '#faf9f6' : isMeet ? '#f4f7fb' : isPriv ? '#f8f5fc' : '#f3f8f5';
      const gridColor  = isFocus ? '#ece7dd' : isMeet ? '#dae3f0' : isPriv ? '#e8dfed' : '#e2ece6';

      ctx.fillStyle = floorColor;
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

      // Grid lines
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      for (let x = 0; x <= LOGICAL_W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, LOGICAL_H); ctx.stroke();
      }
      for (let y = 0; y <= LOGICAL_H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(LOGICAL_W, y); ctx.stroke();
      }

      // ── Room Zones ──────────────────────────────────────────
      const zones = getRoomZones(currentRoom, roomInfo);
      zones.forEach((z) => {
        ctx.fillStyle = z.color;
        ctx.strokeStyle = z.border;
        ctx.lineWidth = 1.5;
        roundRect(ctx, z.x, z.y, z.w, z.h, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#64756b';
        ctx.font = 'bold 10px Inter, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(z.name, z.x + 12, z.y + 20);
      });

      const users = usersRef.current;

      // ── Proximity rings (drawn before avatars so they appear beneath) ──
      const me = users.find((u) => u.id === myId);
      if (me) {
        // Earshot ring around my avatar
        ctx.beginPath();
        ctx.arc(me.x, me.y, EARSHOT_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(37, 151, 101, 0.20)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Highlight users within earshot
        users.forEach((u) => {
          if (u.id === myId) return;
          const d = distance(me, u);
          if (d <= EARSHOT_RADIUS) {
            ctx.beginPath();
            ctx.arc(u.x, u.y, 30, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 120, 217, 0.12)';
            ctx.fill();
          }
        });
      }

      // ── Avatars ────────────────────────────────────────────
      users.forEach((user) => {
        const x     = Math.max(20, Math.min(LOGICAL_W - 20, user.x));
        const y     = Math.max(20, Math.min(LOGICAL_H - 20, user.y));
        const isMe  = user.id === myId;
        const color = user.avatarColor || (isMe ? '#259765' : getAvatarColor(user.id));
        const isAway = user.status === 'away';

        ctx.save();
        if (isAway) {
          ctx.globalAlpha = 0.8;
        }

        // Outer glow ring
        ctx.beginPath();
        ctx.arc(x, y, 24, 0, Math.PI * 2);
        ctx.fillStyle = isMe
          ? 'rgba(37, 151, 101, 0.16)'
          : 'rgba(100, 120, 217, 0.14)';
        ctx.fill();

        // Avatar circle / shape
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Style badge overlay (star, diamond, crown)
        if (user.avatarStyle === 'star') {
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('⭐', x - 12, y - 12);
        } else if (user.avatarStyle === 'crown') {
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('👑', x - 12, y - 12);
        } else if (user.avatarStyle === 'diamond') {
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('💎', x - 12, y - 12);
        }

        // Initials / "ME"
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 11px Inter, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const rawName = user.name || (isMe ? 'ME' : 'GU');
        const initials = isMe ? 'ME' : rawName.slice(0, 2).toUpperCase();
        ctx.fillText(initials, x, y);

        // Active Mic badge
        if (user.micEnabled) {
          ctx.beginPath();
          ctx.arc(x + 12, y - 12, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#22c55e'; // active green
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('🎙️', x + 12, y - 12);
        }

        // Status dot (away = amber, online = green)
        ctx.beginPath();
        ctx.arc(x + 12, y + 12, 4, 0, Math.PI * 2);
        ctx.fillStyle = isAway ? '#f59e0b' : '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Name label
        ctx.fillStyle = '#26352a';
        ctx.font = `12px Inter, Arial, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        const label = isMe ? `${user.name || 'You'} (You)` : (user.name || 'Guest');
        ctx.fillText(label, x, y + 22);

        ctx.restore();
      });

      frameId = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(frameId);
  }, [canvasRef, usersRef, myId, currentRoom, roomInfo]);
}

// Helper: draw a rounded rectangle path
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
