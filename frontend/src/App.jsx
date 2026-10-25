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
import { getNearbyUsers, EARSHOT_RADIUS, volumeFromDistance } from './utils/proximity.js';

// Canvas logical size (must match server-side clamp values)
const CANVAS_W = 800;
const CANVAS_H = 500;
const STEP     = 15; // pixels per key press
// Throttle move events to at most 1 per 50 ms (20 Hz)
const MOVE_THROTTLE_MS = 50;

const PALETTE = [
  '#259765', '#6478d9', '#d9647a', '#d9a064', '#64c8d9',
  '#9664d9', '#64d978', '#d9d064', '#d964c8', '#06b6d4',
];

const STYLES = [
  { id: 'classic', label: 'Classic', icon: '●' },
  { id: 'star',    label: 'Star',    icon: '⭐' },
  { id: 'crown',   label: 'Crown',   icon: '👑' },
  { id: 'diamond', label: 'Diamond', icon: '💎' },
];

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

  // Socket presence & rooms
  const {
    connected,
    connecting,
    myId,
    users,
    usersRef,
    currentRoom,
    roomInfo,
    roomCounts,
    roomError,
    profile,
    emitMove,
    emitMicStatus: _emitMicStatus,
    joinRoom,
    createPrivateRoom,
    leavePrivateRoom,
    updateProfile,
    clearRoomError,
  } = useSocket();

  // WebRTC audio
  const {
    micState,
    audioConnections,
    webrtcError,
    requestMic,
    disableMic,
    toggleMute,
    updateVolumes,
    cleanAllPeers,
  } = useWebRTC(myId);

  // Canvas drawing
  useOfficeCanvas(canvasRef, usersRef, myId, currentRoom, roomInfo);

  // Clean WebRTC peer audio connections when switching rooms
  useEffect(() => {
    cleanAllPeers();
  }, [currentRoom, cleanAllPeers]);

  // Nearby users computed from latest positions
  const [nearbyUsers, setNearbyUsers] = useState([]);

  // Modals state
  const [showCustomizer, setShowCustomizer]   = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal]     = useState(false);
  const [privateTitle, setPrivateTitle]       = useState('');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [copiedCode, setCopiedCode]           = useState(false);

  // Profile editing state inside customizer modal
  const [editProfile, setEditProfile] = useState(profile);

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

  // ── Handlers ─────────────────────────────────────────────────────────────
  const openCustomizer = () => {
    setEditProfile(profile);
    setShowCustomizer(true);
  };

  const handleSaveProfile = () => {
    updateProfile(editProfile);
    setShowCustomizer(false);
  };

  const handleCreateMeeting = (e) => {
    e.preventDefault();
    if (privateTitle.trim()) {
      createPrivateRoom(privateTitle.trim());
      setPrivateTitle('');
      setShowCreateModal(false);
    }
  };

  const handleJoinByCode = (e) => {
    e.preventDefault();
    if (inviteCodeInput.trim()) {
      joinRoom(inviteCodeInput.trim().toUpperCase(), inviteCodeInput.trim().toUpperCase());
      setInviteCodeInput('');
      setShowJoinModal(false);
    }
  };

  const handleCopyCode = () => {
    if (roomInfo?.code) {
      navigator.clipboard?.writeText(roomInfo.code).catch(() => {});
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

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
          <div className="people-count" aria-label={`${users.length} people in this room`}>
            <span className="count-number">{users.length}</span>
            <span>In this room</span>
          </div>
        </section>

        {/* ── Phase 3: Room Switcher Bar ──────────────────────────────────── */}
        <nav className="room-bar-container" aria-label="Office room navigation">
          <div className="room-tabs" role="tablist">
            <button
              className={`room-tab ${currentRoom === 'general' ? 'active' : ''}`}
              onClick={() => joinRoom('general')}
              role="tab"
              aria-selected={currentRoom === 'general'}
            >
              🏢 General Office
              <span className="room-badge">{roomCounts.general || 0}</span>
            </button>
            <button
              className={`room-tab ${currentRoom === 'meeting' ? 'active' : ''}`}
              onClick={() => joinRoom('meeting')}
              role="tab"
              aria-selected={currentRoom === 'meeting'}
            >
              👥 Meeting Room
              <span className="room-badge">{roomCounts.meeting || 0}</span>
            </button>
            <button
              className={`room-tab ${currentRoom === 'focus' ? 'active' : ''}`}
              onClick={() => joinRoom('focus')}
              role="tab"
              aria-selected={currentRoom === 'focus'}
            >
              🎧 Focus Room
              <span className="room-badge">{roomCounts.focus || 0}</span>
            </button>
            {roomInfo.isPrivate && (
              <button
                className="room-tab private-active"
                role="tab"
                aria-selected="true"
              >
                🔒 {roomInfo.title}
                <span className="room-badge">{users.length}</span>
              </button>
            )}
          </div>

          <div className="room-actions">
            <button
              className="btn-secondary-action"
              onClick={() => setShowCreateModal(true)}
              aria-label="Create private meeting"
            >
              ➕ New Meeting
            </button>
            <button
              className="btn-secondary-action"
              onClick={() => setShowJoinModal(true)}
              aria-label="Join meeting with code"
            >
              🔑 Join by Code
            </button>
            <button
              className="btn-customize"
              onClick={openCustomizer}
              aria-label="Customize avatar and profile"
            >
              <span
                className="user-avatar-pip"
                style={{ background: profile.avatarColor || '#259765' }}
              >
                {(profile.name || 'ME').slice(0, 2).toUpperCase()}
              </span>
              Customize Avatar
            </button>
          </div>
        </nav>

        {/* ── Room Notices & Error Alerts ─────────────────────────────────── */}
        {roomError && (
          <div className="room-banner error" role="alert">
            <span>⚠️ {roomError}</span>
            <button
              onClick={clearRoomError}
              className="btn-leave-meeting"
              style={{ padding: '3px 8px', fontSize: 11 }}
            >
              Dismiss
            </button>
          </div>
        )}

        {currentRoom === 'focus' && (
          <div className="room-banner focus" role="status">
            <span>
              🌿 <strong>Focus Room</strong> — Quiet zone for uninterrupted deep work.
              Your microphone remains strictly under your manual control.
            </span>
          </div>
        )}

        {roomInfo.isPrivate && (
          <div className="room-banner private" role="status">
            <div className="private-meta-group">
              <span>🔒 <strong>Private Meeting:</strong> {roomInfo.title}</span>
              <span className="code-pill">
                Code: {roomInfo.code}
                <button
                  className="btn-copy-code"
                  onClick={handleCopyCode}
                  aria-label="Copy invitation code"
                >
                  {copiedCode ? '✓ Copied!' : '📋 Copy'}
                </button>
              </span>
            </div>
            <button
              className="btn-leave-meeting"
              onClick={leavePrivateRoom}
              aria-label="Leave private meeting"
            >
              Leave Meeting
            </button>
          </div>
        )}

        {/* ── Main Grid ───────────────────────────────────────────────────── */}
        <div className="office-grid">
          {/* ── Office Canvas Card ──────────────────────────────────────── */}
          <section className="card" aria-label="Virtual office map">
            <div className="card-header">
              <div>
                <h2>{roomInfo.title || 'Virtual Office'}</h2>
                <p>Live workspace · Room: {roomInfo.room || currentRoom}</p>
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
              <span><i className="legend-dot other-dot" />Room participants</span>
              {nearbyUsers.length > 0 && (
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                  🔊 {nearbyUsers.length} nearby in room
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
                  <p>Room-scoped proximity audio</p>
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

                <div className="mic-actions">
                  <button
                    className={micBtnClass(micState)}
                    onClick={handleMicClick}
                    disabled={micState === 'requesting' || micState === 'denied'}
                    aria-label={micLabel(micState)}
                  >
                    <MicIcon state={micState} />
                    {micLabel(micState)}
                  </button>

                  {(micState === 'active' || micState === 'muted') && (
                    <button
                      className="mic-secondary-btn"
                      onClick={disableMic}
                      aria-label="Turn off microphone"
                    >
                      Turn Off Microphone
                    </button>
                  )}
                </div>

                {webrtcError && (
                  <div className="webrtc-error-box" role="alert">
                    ⚠️ {webrtcError}
                  </div>
                )}

                {audioConnections > 0 && (
                  <p className="mic-hint">
                    🔊 Audio connected to {audioConnections} peer{audioConnections > 1 ? 's' : ''} in this room
                  </p>
                )}
                {micState === 'idle' && (
                  <p className="mic-hint">
                    Click to enable proximity voice chat. Volume scales with distance inside {roomInfo.title || 'this room'}.
                  </p>
                )}
                {micState === 'denied' && (
                  <p className="mic-hint">
                    Allow microphone access in your browser settings and refresh the page.
                  </p>
                )}
              </div>
            </div>

            {/* Participants in Current Room */}
            <div className="card">
              <div className="card-header">
                <div>
                  <h2>Room Participants</h2>
                  <p>{roomInfo.title} ({users.length})</p>
                </div>
              </div>
              <div className="card-body">
                <div className="nearby-list" aria-live="polite" aria-label="Room participants">
                  {users.map((u) => {
                    const isMe = u.id === myId;
                    const nearbyInfo = nearbyUsers.find((n) => n.user.id === u.id);
                    const isAway = u.status === 'away';
                    const initials = (u.name || (isMe ? 'ME' : 'GU')).slice(0, 2).toUpperCase();

                    return (
                      <div key={u.id} className="nearby-user-row">
                        <div
                          className="nearby-avatar"
                          style={{ background: u.avatarColor || (isMe ? '#259765' : '#6478d9') }}
                        >
                          {initials}
                        </div>
                        <span className="nearby-user-name">
                          {u.name || 'Guest'} {isMe && '(You)'}
                        </span>
                        <div className="nearby-meta">
                          <span
                            className={`status-indicator-dot ${isAway ? 'away' : 'online'}`}
                            title={isAway ? 'Away' : 'Online'}
                          />
                          <span
                            className="user-mic-pill"
                            title={u.micEnabled ? 'Microphone on' : 'Microphone off'}
                          >
                            {u.micEnabled ? '🎙️' : '🔇'}
                          </span>
                          {nearbyInfo ? (
                            <span className="nearby-vol" title="Proximity volume">
                              {Math.round(volumeFromDistance(nearbyInfo.dist) * 100)}% vol
                            </span>
                          ) : !isMe ? (
                            <span className="nearby-dist" title="Out of earshot">Far</span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* ── Phase 3 Modals ─────────────────────────────────────────────────── */}

      {/* 1. Avatar Customization Modal */}
      {showCustomizer && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="customizer-title">
          <div className="modal-card">
            <div className="modal-header">
              <h3 id="customizer-title">Customize Avatar & Profile</h3>
              <button
                className="modal-close"
                onClick={() => setShowCustomizer(false)}
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              {/* Avatar Live Preview */}
              <div className="avatar-preview-container">
                <div
                  className="avatar-preview-circle"
                  style={{ background: editProfile.avatarColor || '#259765' }}
                >
                  {(editProfile.name || 'ME').slice(0, 2).toUpperCase()}
                  {editProfile.avatarStyle === 'star' && <span className="avatar-preview-badge">⭐</span>}
                  {editProfile.avatarStyle === 'crown' && <span className="avatar-preview-badge">👑</span>}
                  {editProfile.avatarStyle === 'diamond' && <span className="avatar-preview-badge">💎</span>}
                  <span
                    className="avatar-preview-status"
                    style={{ background: editProfile.status === 'away' ? '#f59e0b' : '#10b981' }}
                  />
                </div>
              </div>

              {/* Display Name */}
              <div className="form-field">
                <label htmlFor="profile-name">Display Name</label>
                <input
                  id="profile-name"
                  type="text"
                  className="form-input"
                  maxLength={30}
                  placeholder="Enter your name"
                  value={editProfile.name}
                  onChange={(e) => setEditProfile({ ...editProfile, name: e.target.value })}
                />
              </div>

              {/* Color Palette */}
              <div className="form-field">
                <label>Avatar Color</label>
                <div className="color-palette-grid">
                  {PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`color-swatch-btn ${editProfile.avatarColor === c ? 'selected' : ''}`}
                      style={{ background: c }}
                      onClick={() => setEditProfile({ ...editProfile, avatarColor: c })}
                      aria-label={`Select color ${c}`}
                    >
                      {editProfile.avatarColor === c && '✓'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Style Badge */}
              <div className="form-field">
                <label>Badge Style</label>
                <div className="style-button-group">
                  {STYLES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`choice-btn ${editProfile.avatarStyle === s.id ? 'selected' : ''}`}
                      onClick={() => setEditProfile({ ...editProfile, avatarStyle: s.id })}
                    >
                      <span>{s.icon}</span> {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Status */}
              <div className="form-field">
                <label>Status</label>
                <div className="status-button-group">
                  <button
                    type="button"
                    className={`choice-btn ${editProfile.status !== 'away' ? 'selected' : ''}`}
                    onClick={() => setEditProfile({ ...editProfile, status: 'online' })}
                  >
                    <span className="status-indicator-dot online" /> Online
                  </button>
                  <button
                    type="button"
                    className={`choice-btn ${editProfile.status === 'away' ? 'selected' : ''}`}
                    onClick={() => setEditProfile({ ...editProfile, status: 'away' })}
                  >
                    <span className="status-indicator-dot away" /> Away
                  </button>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={() => setShowCustomizer(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn-primary"
                onClick={handleSaveProfile}
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Create Private Meeting Modal */}
      {showCreateModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="create-title">
          <form className="modal-card" onSubmit={handleCreateMeeting}>
            <div className="modal-header">
              <h3 id="create-title">Create Private Meeting</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowCreateModal(false)}
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Create a private room isolated from public spaces. An invitation code will be generated for your team.
              </p>
              <div className="form-field">
                <label htmlFor="meeting-title">Meeting Title</label>
                <input
                  id="meeting-title"
                  type="text"
                  className="form-input"
                  maxLength={40}
                  placeholder="e.g. Design Review, Sprint Planning"
                  value={privateTitle}
                  onChange={(e) => setPrivateTitle(e.target.value)}
                  autoFocus
                  required
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="modal-btn-primary"
                disabled={!privateTitle.trim()}
              >
                Create & Enter
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 3. Join by Code Modal */}
      {showJoinModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="join-title">
          <form className="modal-card" onSubmit={handleJoinByCode}>
            <div className="modal-header">
              <h3 id="join-title">Join Private Meeting</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowJoinModal(false)}
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Enter the invitation code provided by the meeting host (e.g. PRV-K7M9).
              </p>
              <div className="form-field">
                <label htmlFor="invite-code">Invitation Code</label>
                <input
                  id="invite-code"
                  type="text"
                  className="form-input"
                  maxLength={10}
                  placeholder="PRV-XXXX"
                  style={{ textTransform: 'uppercase', fontFamily: 'monospace', letterSpacing: 1.5 }}
                  value={inviteCodeInput}
                  onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                  autoFocus
                  required
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={() => setShowJoinModal(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="modal-btn-primary"
                disabled={!inviteCodeInput.trim()}
              >
                Join Meeting
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────────── */}

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