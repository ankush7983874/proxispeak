/**
 * OfficeMinimap.jsx — Interactive Workspace Minimap & Navigation Overview
 *
 * Provides a real-time spatial overview of the virtual office:
 *  • Scaled 800×500 office floor plan with all 6 architectural zones
 *  • Real-time player marker (pulsing cyan blip with radar ring)
 *  • Live teammate markers with their avatar colors
 *  • Interactive Click-to-Navigate: clicking anywhere sets destination waypoint
 *  • Real-time coordinates HUD and active zone name indicator
 *  • Collapsible / expandable with smooth CSS transition
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { getRoomZones, LOGICAL_W, LOGICAL_H } from '../hooks/useOfficeCanvas.js';

const MINIMAP_W = 184;
const MINIMAP_H = 115;
const SCALE_X = MINIMAP_W / LOGICAL_W;
const SCALE_Y = MINIMAP_H / LOGICAL_H;

export function OfficeMinimap({
  myId = '',
  users = [],
  currentRoom = 'general',
  roomInfo = {},
  currentZone = null,
  onNavigate = null,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const canvasRef = useRef(null);

  // Find player
  const me = users.find((u) => u.id === myId) || users[0];

  const handleMinimapClick = useCallback(
    (e) => {
      if (!onNavigate || collapsed) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Convert from minimap pixel space (184x115) to logical office space (800x500)
      const targetX = Math.max(20, Math.min(LOGICAL_W - 20, Math.round(clickX / SCALE_X)));
      const targetY = Math.max(20, Math.min(LOGICAL_H - 20, Math.round(clickY / SCALE_Y)));

      onNavigate(targetX, targetY);
    },
    [onNavigate, collapsed]
  );

  // Draw minimap canvas
  useEffect(() => {
    if (collapsed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = MINIMAP_W;
    canvas.height = MINIMAP_H;
    const ctx = canvas.getContext('2d');

    // 1. Floor Base
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= MINIMAP_W; x += 18) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MINIMAP_H); ctx.stroke();
    }
    for (let y = 0; y <= MINIMAP_H; y += 18) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MINIMAP_W, y); ctx.stroke();
    }

    // 2. Zone outlines
    const zones = getRoomZones(currentRoom, roomInfo);
    zones.forEach((z) => {
      const zx = z.x * SCALE_X;
      const zy = z.y * SCALE_Y;
      const zw = z.w * SCALE_X;
      const zh = z.h * SCALE_Y;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(zx, zy, zw, zh);

      ctx.strokeStyle = z.badgeBg || '#38bdf8';
      ctx.lineWidth = 1;
      ctx.strokeRect(zx, zy, zw, zh);
    });

    // 3. Teammates
    users.forEach((u) => {
      const isMe = u.id === myId || u.id === 'local-preview';
      if (isMe) return; // Draw me on top

      const ux = Math.max(4, Math.min(MINIMAP_W - 4, (u.x || 300) * SCALE_X));
      const uy = Math.max(4, Math.min(MINIMAP_H - 4, (u.y || 200) * SCALE_Y));

      ctx.beginPath();
      ctx.arc(ux, uy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = u.avatarColor || '#38bdf8';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // 4. Current User Marker
    if (me) {
      const mx = Math.max(4, Math.min(MINIMAP_W - 4, (me.x || 360) * SCALE_X));
      const my = Math.max(4, Math.min(MINIMAP_H - 4, (me.y || 110) * SCALE_Y));

      // Radar range wave
      ctx.beginPath();
      ctx.arc(mx, my, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(6, 182, 212, 0.25)';
      ctx.fill();
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Center blip
      ctx.beginPath();
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [users, myId, currentRoom, roomInfo, me, collapsed]);

  return (
    <div className={`office-minimap-widget ${collapsed ? 'collapsed' : ''}`} aria-label="Office Minimap">
      <div className="minimap-header">
        <div className="minimap-title-bar">
          <span className="minimap-icon" aria-hidden="true">🗺️</span>
          <span className="minimap-title">Minimap</span>
        </div>
        <button
          type="button"
          className="minimap-toggle-btn"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Show office minimap' : 'Hide office minimap'}
          aria-label={collapsed ? 'Expand minimap' : 'Collapse minimap'}
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div
            className="minimap-canvas-wrap"
            onClick={handleMinimapClick}
            title="Click anywhere to navigate your avatar there"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                handleMinimapClick(e);
              }
            }}
          >
            <canvas ref={canvasRef} className="minimap-canvas" />
            <div className="minimap-hint-overlay">Click to Walk</div>
          </div>

          <div className="minimap-footer">
            <span className="minimap-zone-tag" title="Current Office Zone">
              {currentZone ? `${currentZone.icon || '📍'} ${currentZone.name}` : '📍 Office Floor'}
            </span>
            <span className="minimap-coords" title="Authoritative Canvas Coordinates">
              {me ? `${Math.round(me.x)}, ${Math.round(me.y)}` : '360, 110'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
