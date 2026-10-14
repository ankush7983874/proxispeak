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

// Zone definitions for the office floor plan
const ZONES = [
  { x: 24,  y: 24,  w: 220, h: 130, name: 'FOCUS ZONE',     color: '#f0faf5', border: '#c4e8d4' },
  { x: 268, y: 24,  w: 220, h: 130, name: 'COLLABORATION',  color: '#f5f0ff', border: '#d4c4f0' },
  { x: 512, y: 24,  w: 220, h: 130, name: 'MEETING SPACE',  color: '#f0f5ff', border: '#c4d4f0' },
  { x: 24,  y: 340, w: 708, h: 136, name: 'COMMON AREA',    color: '#fffaf0', border: '#f0e4c4' },
];

// Avatar palette — each other user gets a consistent colour based on their index
const AVATAR_COLORS = [
  '#6478d9', '#d9647a', '#d9a064', '#64c8d9',
  '#9664d9', '#64d978', '#d9d064', '#d964c8',
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
 */
export function useOfficeCanvas(canvasRef, usersRef, myId) {
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

      // ── Floor ──────────────────────────────────────────────
      ctx.fillStyle = '#f3f8f5';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

      // Grid lines
      ctx.strokeStyle = '#e2ece6';
      ctx.lineWidth = 1;
      for (let x = 0; x <= LOGICAL_W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, LOGICAL_H); ctx.stroke();
      }
      for (let y = 0; y <= LOGICAL_H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(LOGICAL_W, y); ctx.stroke();
      }

      // ── Zones ──────────────────────────────────────────────
      ZONES.forEach((z) => {
        ctx.fillStyle = z.color;
        ctx.strokeStyle = z.border;
        ctx.lineWidth = 1.5;
        roundRect(ctx, z.x, z.y, z.w, z.h, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#6d8878';
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
        ctx.strokeStyle = 'rgba(37, 151, 101, 0.15)';
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
            ctx.fillStyle = 'rgba(100, 120, 217, 0.10)';
            ctx.fill();
          }
        });
      }

      // ── Avatars ────────────────────────────────────────────
      users.forEach((user) => {
        const x     = Math.max(20, Math.min(LOGICAL_W - 20, user.x));
        const y     = Math.max(20, Math.min(LOGICAL_H - 20, user.y));
        const isMe  = user.id === myId;
        const color = isMe ? '#259765' : getAvatarColor(user.id);

        // Outer glow ring
        ctx.beginPath();
        ctx.arc(x, y, 24, 0, Math.PI * 2);
        ctx.fillStyle = isMe
          ? 'rgba(37, 151, 101, 0.15)'
          : 'rgba(100, 120, 217, 0.12)';
        ctx.fill();

        // Avatar circle
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Initials / "Me"
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 11px Inter, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const initials = isMe ? 'ME' : user.name.slice(0, 2).toUpperCase();
        ctx.fillText(initials, x, y);

        // Name label
        ctx.fillStyle = '#26352a';
        ctx.font = `12px Inter, Arial, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        ctx.fillText(isMe ? 'You' : user.name, x, y + 22);
      });

      frameId = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(frameId);
  }, [canvasRef, usersRef, myId]);
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
