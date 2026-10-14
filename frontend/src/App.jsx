/**
 * App.jsx — ProxiSpeak main component
 *
 * Wires together:
 *  • useSocket  → real-time presence and movement
 *  • useOfficeCanvas → 2D office map rendering
 *  • useWebRTC  → proximity-based voice audio
 *  • Keyboard + button movement
 *  • Nearby-user detection
 *  • Mic / mute controls
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';

import { useSocket }       from './hooks/useSocket.js';
import { useOfficeCanvas } from './hooks/useOfficeCanvas.js';
import { useWebRTC }       from './hooks/useWebRTC.js';
import { getNearbyUsers, EARSHOT_RADIUS } from './utils/proximity.js';

// Canvas logical size (must match server-side clamp values)
const CANVAS_W = 800;
const CANVAS_H = 500;
const STEP     = 15; // pixels per key press
// Throttle move events to at most 1 per 50 ms (20 Hz)
const MOVE_THROTTLE_MS = 50;

// ── Mic icon helpers ────────────────────────────────────────────────────────
function MicIcon({ state }) {
  const icons = {
    idle:       '🎤',
    requesting: '⏳',
    active:     '🎤',
    muted:      '🔇',
    denied:     '🚫',
    error:      '⚠️',
  };
  return <span style={{ fontSize: 16 }}>{icons[state] ?? '🎤'}</span>;
}

function micLabel(state) {
  switch (state) {
    case 'idle':       return 'Enable Microphone';
    case 'requesting': return 'Requesting access…';
    case 'active':     return 'Mute Mic';
    case 'muted':      return 'Unmute Mic';
    case 'denied':     return 'Microphone Denied';
    case 'error':      return 'Mic Error — Retry';
    default:           return 'Microphone';
  }
}

function micDotClass(state) {
  if (state === 'active')  return 'mic-status-dot active';
  if (state === 'muted')   return 'mic-status-dot muted';
  if (state === 'denied')  return 'mic-status-dot denied';
  return 'mic-status-dot';
}

function micBtnClass(state) {
  if (state === 'muted')  return 'mic-btn muted';
  if (state === 'denied') return 'mic-btn denied';
  return 'mic-btn';
}

// ── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const canvasRef = useRef(null);

  // Socket presence
  const { connected, connecting, myId, users, usersRef, emitMove } = useSocket();

  // Canvas drawing
  useOfficeCanvas(canvasRef, usersRef, myId);

  // WebRTC audio
  const { micState, audioConnections, requestMic, toggleMute, updateVolumes } = useWebRTC(myId);

  // Nearby users computed from latest positions
  const [nearbyUsers, setNearbyUsers] = useState([]);

  // Movement throttle ref
  const lastMoveRef = useRef(0);

  // ── Movement ──────────────────────────────────────────────────────────────
  const move = useCallback(
    (dx, dy) => {
      const now = performance.now();
      if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return;
      lastMoveRef.current = now;

      const me = usersRef.current.find((u) => u.id === myId);
      if (!me) return;

      const nx = Math.max(20, Math.min(CANVAS_W - 20, me.x + dx));
      const ny = Math.max(20, Math.min(CANVAS_H - 20, me.y + dy));
      emitMove(nx, ny);
    },
    [myId, usersRef, emitMove]
  );

  // Keyboard movement
  useEffect(() => {
    const onKeyDown = (e) => {
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d'].includes(e.key)) {
        e.preventDefault();
      }
      if (e.key === 'ArrowUp'    || e.key === 'w') move(0, -STEP);
      if (e.key === 'ArrowDown'  || e.key === 's') move(0,  STEP);
      if (e.key === 'ArrowLeft'  || e.key === 'a') move(-STEP, 0);
      if (e.key === 'ArrowRight' || e.key === 'd') move( STEP, 0);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move]);

  // ── Proximity & volume updates ────────────────────────────────────────────
  useEffect(() => {
    const me = users.find((u) => u.id === myId);
    if (!me) return;

    const others  = users.filter((u) => u.id !== myId);
    const nearby  = getNearbyUsers(me, others, EARSHOT_RADIUS);
    setNearbyUsers(nearby);
    updateVolumes(nearby, users);
  }, [users, myId, updateVolumes]);

  // ── Mic click handler ─────────────────────────────────────────────────────
  const handleMicClick = () => {
    if (micState === 'idle' || micState === 'error') {
      requestMic();
    } else if (micState === 'active' || micState === 'muted') {
      toggleMute();
    }
  };

  // ── Status text ───────────────────────────────────────────────────────────
  const connectionLabel = connecting
    ? 'Connecting…'
    : connected
    ? 'Connected to office'
    : 'Disconnected';

  const dotClass = connecting
    ? 'status-dot'
    : connected
    ? 'status-dot online'
    : 'status-dot error';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main className="app-shell">
      {/* ── Top Bar ─────────────────────────────────────────────────────── */}
      <header className="topbar">
        <a className="brand" href="/" aria-label="ProxiSpeak home">
          <span className="brand-icon">P</span>
          <span>ProxiSpeak</span>
        </a>

        <div className="topbar-right">
          {connecting && (
            <div className="state-banner connecting" role="status">
              <span className="spinner" />
              Connecting…
            </div>
          )}
          <div className="connection" role="status" aria-live="polite">
            <span className={dotClass} />
            {connectionLabel}
          </div>
        </div>
      </header>

      <div className="page-content">
        {/* ── Welcome Banner ──────────────────────────────────────────────── */}
        <section className="welcome">
          <div>
            <p className="eyebrow">Your Virtual Workspace</p>
            <h1>Work better, <span>together.</span></h1>
            <p className="subtitle">
              Move around the office. Talk to people nearby automatically.
            </p>
          </div>
          <div className="people-count" aria-label={`${users.length} people online`}>
            <span className="count-number">{users.length}</span>
            <span>People online</span>
          </div>
        </section>

        {/* ── Main Grid ───────────────────────────────────────────────────── */}
        <div className="office-grid">
          {/* ── Office Canvas Card ──────────────────────────────────────── */}
          <section className="card" aria-label="Virtual office map">
            <div className="card-header">
              <div>
                <h2>Virtual Office</h2>
                <p>Live workspace · Real-time presence</p>
              </div>
              {connected && (
                <span className="live-label">
                  <span />
                  LIVE
                </span>
              )}
            </div>

            <div className="canvas-wrap">
              {!connected && !connecting && (
                <div
                  style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(243, 248, 245, 0.85)',
                    fontSize: 14, color: 'var(--text-muted)', gap: 10,
                    zIndex: 10,
                  }}
                >
                  <span style={{ fontSize: 24 }}>🔌</span>
                  Office offline — check your connection
                </div>
              )}
              <canvas
                ref={canvasRef}
                aria-label="Virtual office map showing user avatars"
                style={{ cursor: 'crosshair' }}
              />
            </div>

            <div className="office-footer">
              <span><i className="legend-dot my-dot" />Your avatar</span>
              <span><i className="legend-dot other-dot" />Other people</span>
              {nearbyUsers.length > 0 && (
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                  🔊 {nearbyUsers.length} nearby
                </span>
              )}
              <span className="movement-hint">Move: WASD or arrow keys</span>
            </div>
          </section>

          {/* ── Right Sidebar ────────────────────────────────────────────── */}
          <aside className="sidebar">
            {/* Controls */}
            <div className="card controls-card">
              <div className="card-header">
                <div>
                  <h2>Move Avatar</h2>
                  <p>Keyboard or buttons</p>
                </div>
              </div>
              <div className="card-body">
                <p className="section-label">Direction</p>
                <div className="direction-pad" role="group" aria-label="Avatar movement controls">
                  <button data-dir="up"    onClick={() => move(0, -STEP)} aria-label="Move up">↑</button>
                  <button data-dir="left"  onClick={() => move(-STEP, 0)} aria-label="Move left">←</button>
                  <button data-dir="down"  onClick={() => move(0,  STEP)} aria-label="Move down">↓</button>
                  <button data-dir="right" onClick={() => move( STEP, 0)} aria-label="Move right">→</button>
                </div>
              </div>
            </div>

            {/* Microphone */}
            <div className="card">
              <div className="card-header">
                <div>
                  <h2>Voice Chat</h2>
                  <p>Proximity audio</p>
                </div>
              </div>
              <div className="card-body">
                <div className="mic-status" role="status" aria-live="polite">
                  <span className={micDotClass(micState)} />
                  {micState === 'idle'       && 'Microphone off'}
                  {micState === 'requesting' && 'Requesting…'}
                  {micState === 'active'     && 'Mic active'}
                  {micState === 'muted'      && 'Muted'}
                  {micState === 'denied'     && 'Permission denied'}
                  {micState === 'error'      && 'Mic error'}
                </div>
                <button
                  className={micBtnClass(micState)}
                  onClick={handleMicClick}
                  disabled={micState === 'requesting' || micState === 'denied'}
                  aria-label={micLabel(micState)}
                >
                  <MicIcon state={micState} />
                  {micLabel(micState)}
                </button>
                {audioConnections > 0 && (
                  <p className="mic-hint">
                    🔊 Audio connected to {audioConnections} user{audioConnections > 1 ? 's' : ''}
                  </p>
                )}
                {micState === 'idle' && (
                  <p className="mic-hint">
                    Click to enable proximity voice chat. Audio volume adjusts automatically by distance.
                  </p>
                )}
                {micState === 'denied' && (
                  <p className="mic-hint">
                    Allow microphone access in your browser settings and refresh the page.
                  </p>
                )}
              </div>
            </div>

            {/* Nearby Users */}
            <div className="card">
              <div className="card-header">
                <div>
                  <h2>Nearby</h2>
                  <p>Within earshot ({EARSHOT_RADIUS}px)</p>
                </div>
              </div>
              <div className="card-body">
                <div className="nearby-list" aria-live="polite" aria-label="Nearby users">
                  {nearbyUsers.length === 0 ? (
                    <div className="nearby-empty">
                      {users.length <= 1
                        ? 'No one else is online yet'
                        : 'Move closer to someone to talk'}
                    </div>
                  ) : (
                    nearbyUsers.map(({ user, dist }) => (
                      <div key={user.id} className="nearby-user-row">
                        <div className="nearby-avatar">
                          {user.name.slice(0, 2).toUpperCase()}
                        </div>
                        <span className="nearby-user-name">{user.name}</span>
                        <span className="nearby-dist">{Math.round(dist)}px</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="page-footer">
        ProxiSpeak · Geospatial Proximity Audio Ecosystem ·{' '}
        <a
          href="https://github.com"
          style={{ color: 'inherit', textDecoration: 'underline' }}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
      </footer>
    </main>
  );
}