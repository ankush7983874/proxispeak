/**
 * App.jsx — ProxiSpeak Main Application
 *
 * Full-stack spatial audio collaboration platform featuring:
 *  • useSocket        → real-time presence, multi-room sync, and profile customization
 *  • useOfficeCanvas   → 2D office floor plan rendering with 3-tier statuses & badges
 *  • useWebRTC        → proximity-attenuated WebRTC audio mesh
 *  • Premium SaaS UI   → SVG icon system, blue/cyan theme, accessible modals & confirmations
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';

import { useSocket }       from './hooks/useSocket.js';
import { useOfficeCanvas, checkCollision, findNearbyWorkstation } from './hooks/useOfficeCanvas.js';
import { useWebRTC }       from './hooks/useWebRTC.js';
import { getNearbyUsers, EARSHOT_RADIUS, volumeFromDistance } from './utils/proximity.js';
import { WelcomePage }     from './components/WelcomePage.jsx';

import {
  BuildingIcon,
  UsersIcon,
  HeadphonesIcon,
  LockIcon,
  PlusIcon,
  KeyIcon,
  SlidersIcon,
  MicIcon,
  MicOffIcon,
  MicDeniedIcon,
  CopyIcon,
  CheckIcon,
  LogOutIcon,
  CloseIcon,
  RadioIcon,
  VolumeIcon,
  AlertCircleIcon,
  InfoIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  StarIcon,
  CrownIcon,
  DiamondIcon,
} from './components/Icons.jsx';

// Logical canvas bounds matching server-side clamping
const CANVAS_W = 800;
const CANVAS_H = 500;
const STEP     = 15; // pixels per movement action
const MOVE_THROTTLE_MS = 50; // at most 20 Hz movement events

// Curated 10-color SaaS palette
const PALETTE = [
  '#2563eb', '#06b6d4', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#6366f1', '#14b8a6', '#64748b',
];

const STYLES = [
  { id: 'classic', label: 'Classic', icon: '●' },
  { id: 'star',    label: 'Star',    icon: '⭐' },
  { id: 'crown',   label: 'Crown',   icon: '👑' },
  { id: 'diamond', label: 'Diamond', icon: '💎' },
];

export default function App() {
  const canvasRef = useRef(null);

  // Socket.IO presence, rooms, and profile state
  const {
    socket,
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
    roomMessages,
    occupiedDesks,
    currentWorkstation,
    emitMove,
    joinRoom,
    leaveOffice,
    createPrivateRoom,
    leavePrivateRoom,
    updateProfile,
    sendRoomChat,
    sitAtWorkstation,
    leaveWorkstation,
    clearRoomError,
  } = useSocket();

  // WebRTC spatial audio mesh
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

  // Office entry gate: Welcome / Login page appears first
  const [hasJoined, setHasJoined] = useState(false);

  // 2D office canvas renderer
  useOfficeCanvas(canvasRef, usersRef, myId, currentRoom, roomInfo, profile);

  // Teardown previous audio connections on room changes
  useEffect(() => {
    cleanAllPeers();
  }, [currentRoom, cleanAllPeers]);

  // If a room error occurs (e.g. invalid invite code), keep user on welcome screen
  useEffect(() => {
    if (roomError) {
      setHasJoined(false);
    }
  }, [roomError]);

  // Nearby users computed from authoritative positions
  const [nearbyUsers, setNearbyUsers] = useState([]);

  // Modals & UI interactive state
  const [showCustomizer, setShowCustomizer]     = useState(false);
  const [showCreateModal, setShowCreateModal]   = useState(false);
  const [showJoinModal, setShowJoinModal]       = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [privateTitle, setPrivateTitle]         = useState('');
  const [inviteCodeInput, setInviteCodeInput]   = useState('');
  const [copiedCode, setCopiedCode]             = useState(false);

  // Workstation interaction & In-Room Chat state
  const [nearbyDesk, setNearbyDesk] = useState(null);
  const [sidebarTab, setSidebarTab] = useState('teammates'); // 'teammates' | 'chat'
  const [chatInput, setChatInput]   = useState('');
  const chatBottomRef = useRef(null);

  // Editable profile state inside customizer modal
  const [editProfile, setEditProfile] = useState(profile);

  // Movement throttle ref
  const lastMoveRef = useRef(0);

  // ── Welcome Screen Join Handler ───────────────────────────────────────────
  const handleJoinOffice = useCallback(
    ({ name, email, room, code }) => {
      return new Promise((resolve, reject) => {
        if (!connected) {
          reject(new Error('Backend server is offline or unreachable. Please start backend on port 5000.'));
          return;
        }

        const targetRoom = room || 'general';
        updateProfile({ name, email });

        let settled = false;

        const onSettled = (success, errorMsg) => {
          if (settled) return;
          settled = true;
          socket.off('room-info', onRoomInfo);
          socket.off('room-error', onRoomError);
          clearTimeout(timeoutId);

          if (success) {
            setHasJoined(true);
            resolve();
          } else {
            reject(new Error(errorMsg || 'Failed to join room.'));
          }
        };

        const onRoomInfo = () => onSettled(true);
        const onRoomError = ({ message }) => onSettled(false, message);

        socket.once('room-info', onRoomInfo);
        socket.once('room-error', onRoomError);

        const timeoutId = setTimeout(() => {
          onSettled(false, 'Join request timed out. Please verify your connection.');
        }, 5000);

        joinRoom(targetRoom, code, { ...profile, name, email }, (res) => {
          if (res) {
            if (res.success) {
              onSettled(true);
            } else {
              onSettled(false, res.error);
            }
          }
        });
      });
    },
    [connected, updateProfile, joinRoom, profile, socket]
  );

  // ── Leave Office (Return to Welcome Screen) ───────────────────────────────
  const handleLeaveOffice = useCallback(() => {
    cleanAllPeers();
    disableMic();
    leaveOffice();
    setHasJoined(false);
    clearRoomError();
  }, [cleanAllPeers, disableMic, leaveOffice, clearRoomError]);

  // ── Movement Handler with Furniture Collision & Sliding ────────────────────
  const move = useCallback(
    (dx, dy) => {
      const now = performance.now();
      if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return;
      lastMoveRef.current = now;

      const me = usersRef.current.find((u) => u.id === myId) || usersRef.current[0];
      if (!me) return;

      let nx = Math.max(20, Math.min(CANVAS_W - 20, me.x + dx));
      let ny = Math.max(20, Math.min(CANVAS_H - 20, me.y + dy));

      // Realistic obstacle collision with wall/desk sliding
      if (checkCollision(nx, ny, 10, currentRoom)) {
        if (!checkCollision(nx, me.y, 10, currentRoom)) {
          // Slide along X axis
          ny = me.y;
        } else if (!checkCollision(me.x, ny, 10, currentRoom)) {
          // Slide along Y axis
          nx = me.x;
        } else {
          // Fully blocked by obstacle
          return;
        }
      }

      // Automatically leave workstation if user walks away
      if (currentWorkstation && (nx !== me.x || ny !== me.y)) {
        const d = Math.hypot(currentWorkstation.x - nx, currentWorkstation.y - ny);
        if (d > 35) {
          leaveWorkstation();
        }
      }

      emitMove(nx, ny);
    },
    [myId, usersRef, currentRoom, currentWorkstation, leaveWorkstation, emitMove]
  );

  // Keyboard navigation & Workstation interaction (WASD + E)
  useEffect(() => {
    if (!hasJoined) return;
    const onKeyDown = (e) => {
      // Don't intercept when user is typing inside text input fields
      if (['INPUT', 'TEXTAREA'].includes(e.target?.tagName)) return;

      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d'].includes(e.key)) {
        if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
          e.preventDefault();
        }
      }
      if (e.key === 'ArrowUp'    || e.key === 'w') move(0, -STEP);
      if (e.key === 'ArrowDown'  || e.key === 's') move(0,  STEP);
      if (e.key === 'ArrowLeft'  || e.key === 'a') move(-STEP, 0);
      if (e.key === 'ArrowRight' || e.key === 'd') move( STEP, 0);

      // Key E: Sit / Leave Workstation
      if (e.key === 'e' || e.key === 'E') {
        if (currentWorkstation) {
          leaveWorkstation();
        } else if (nearbyDesk) {
          const occ = occupiedDesks[nearbyDesk.id];
          if (!occ || occ.socketId === myId) {
            sitAtWorkstation(nearbyDesk);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move, hasJoined, currentWorkstation, nearbyDesk, occupiedDesks, myId, sitAtWorkstation, leaveWorkstation]);

  // Track nearest workstation within interaction radius
  useEffect(() => {
    const me = usersRef.current.find((u) => u.id === myId);
    if (!me || currentRoom !== 'general') {
      setNearbyDesk(null);
      return;
    }
    const desk = findNearbyWorkstation(me.x, me.y, 35);
    setNearbyDesk(desk);
  }, [users, myId, currentRoom, usersRef]);

  // Auto-scroll chat messages container when new message arrives
  useEffect(() => {
    if (sidebarTab === 'chat' && chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [roomMessages, sidebarTab]);

  // ── Send In-Room Chat Message ──────────────────────────────────────────────
  const handleSendChat = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    sendRoomChat(chatInput);
    setChatInput('');
  };

  // ── Proximity & Spatial Gain Updates ──────────────────────────────────────
  useEffect(() => {
    const me = users.find((u) => u.id === myId);
    if (!me) return;

    const others = users.filter((u) => u.id !== myId);
    const nearby = getNearbyUsers(me, others, EARSHOT_RADIUS);
    setNearbyUsers(nearby);
    updateVolumes(nearby, users);
  }, [users, myId, updateVolumes]);

  // ── Microphone Click Handler ──────────────────────────────────────────────
  const handleMicClick = () => {
    if (micState === 'idle' || micState === 'error') {
      requestMic();
    } else if (micState === 'active' || micState === 'muted') {
      toggleMute();
    }
  };

  // ── Customizer Handlers ───────────────────────────────────────────────────
  const openCustomizer = () => {
    setEditProfile(profile);
    setShowCustomizer(true);
  };

  const handleSaveProfile = () => {
    updateProfile(editProfile);
    setShowCustomizer(false);
  };

  // ── Private Meeting Handlers ──────────────────────────────────────────────
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

  const confirmLeavePrivate = () => {
    leavePrivateRoom();
    setShowLeaveConfirm(false);
  };

  // ── Connection Status Details ─────────────────────────────────────────────
  const connectionLabel = connecting
    ? 'Connecting to office…'
    : connected
    ? 'Connected'
    : 'Disconnected';

  const dotClass = connecting
    ? 'status-dot'
    : connected
    ? 'status-dot online'
    : 'status-dot error';

  const statusColor = (status) => {
    if (status === 'busy') return '#ef4444';
    if (status === 'away') return '#f59e0b';
    return '#10b981';
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (!hasJoined) {
    return (
      <WelcomePage
        onJoin={handleJoinOffice}
        connected={connected}
        connecting={connecting}
        initialProfile={profile}
        roomCounts={roomCounts}
        serverError={roomError}
        clearServerError={clearRoomError}
      />
    );
  }

  return (
    <main className="app-shell">
      {/* ── Top Navigation Bar ─────────────────────────────────────────────── */}
      <header className="topbar">
        <a className="brand" href="/" aria-label="ProxiSpeak home">
          <div className="brand-icon">
            <RadioIcon size={20} />
          </div>
          <div className="brand-title">
            <span className="brand-name">ProxiSpeak</span>
            <span className="brand-tag">Spatial Office</span>
          </div>
        </a>

        <div className="topbar-center">
          <div className={`topbar-room-badge ${roomInfo.isPrivate ? 'private' : ''}`}>
            {roomInfo.isPrivate ? <LockIcon size={14} /> : <BuildingIcon size={14} />}
            <span>{roomInfo.title || 'General Office'}</span>
          </div>
        </div>

        <div className="topbar-right">
          {connecting && (
            <div className="state-banner connecting" role="status">
              <span className="spinner" />
              Connecting…
            </div>
          )}

          <div className="connection" role="status" aria-live="polite">
            <span className={dotClass} />
            <span>{connectionLabel}</span>
          </div>

          <button
            type="button"
            className="topbar-user-pill"
            onClick={openCustomizer}
            title="Edit profile & avatar"
            aria-label={`Profile: ${profile.name || 'You'}`}
          >
            <div
              className="topbar-user-avatar"
              style={{ background: profile.avatarColor || '#2563eb' }}
            >
              {(profile.name || 'ME').slice(0, 2).toUpperCase()}
            </div>
            <span>{profile.name || 'Guest'}</span>
            <span
              className={`status-indicator-dot ${profile.status || 'online'}`}
              style={{ width: 7, height: 7 }}
            />
          </button>

          <button
            type="button"
            className="btn-leave-office"
            onClick={handleLeaveOffice}
            title="Leave virtual office and return to welcome page"
            aria-label="Leave office"
          >
            <LogOutIcon size={14} />
            <span>Leave Office</span>
          </button>
        </div>
      </header>

      <div className="page-content">
        {/* ── Welcome Header ──────────────────────────────────────────────── */}
        <section className="welcome">
          <div>
            <div className="eyebrow">
              <RadioIcon size={13} />
              <span>Real-Time Geospatial Audio</span>
            </div>
            <h1>Work better, <span>together.</span></h1>
            <p className="subtitle">
              Move your avatar across the office. Audio volume attenuates naturally with proximity.
            </p>
          </div>
          <div className="people-count" aria-label={`${users.length} teammates in this room`}>
            <span className="count-number">{users.length}</span>
            <span>In this room</span>
          </div>
        </section>

        {/* ── Room Navigation Toolbar ─────────────────────────────────────── */}
        <nav className="room-bar-container" aria-label="Office room navigation">
          <div className="room-tabs" role="tablist">
            <button
              className={`room-tab ${currentRoom === 'general' ? 'active' : ''}`}
              onClick={() => joinRoom('general')}
              role="tab"
              aria-selected={currentRoom === 'general'}
            >
              <BuildingIcon size={15} />
              <span>General Office</span>
              <span className="room-badge">{roomCounts.general || 0}</span>
            </button>

            <button
              className={`room-tab ${currentRoom === 'meeting' ? 'active' : ''}`}
              onClick={() => joinRoom('meeting')}
              role="tab"
              aria-selected={currentRoom === 'meeting'}
            >
              <UsersIcon size={15} />
              <span>Meeting Room</span>
              <span className="room-badge">{roomCounts.meeting || 0}</span>
            </button>

            <button
              className={`room-tab ${currentRoom === 'focus' ? 'active' : ''}`}
              onClick={() => joinRoom('focus')}
              role="tab"
              aria-selected={currentRoom === 'focus'}
            >
              <HeadphonesIcon size={15} />
              <span>Focus Room</span>
              <span className="room-badge">{roomCounts.focus || 0}</span>
            </button>

            {roomInfo.isPrivate && (
              <button
                className="room-tab private-active"
                role="tab"
                aria-selected="true"
              >
                <LockIcon size={15} />
                <span>{roomInfo.title}</span>
                <span className="room-badge">{users.length}</span>
              </button>
            )}
          </div>

          <div className="room-actions">
            <button
              type="button"
              className="btn-secondary-action"
              onClick={() => setShowCreateModal(true)}
              aria-label="Create new private meeting"
            >
              <PlusIcon size={14} />
              <span>New Meeting</span>
            </button>

            <button
              type="button"
              className="btn-secondary-action"
              onClick={() => setShowJoinModal(true)}
              aria-label="Join meeting with invitation code"
            >
              <KeyIcon size={14} />
              <span>Join by Code</span>
            </button>

            <button
              type="button"
              className="btn-customize"
              onClick={openCustomizer}
              aria-label="Customize avatar and identity"
            >
              <SlidersIcon size={14} />
              <span>Customize Profile</span>
            </button>
          </div>
        </nav>

        {/* ── Room Notices & Error Alerts ─────────────────────────────────── */}
        {roomError && (
          <div className="room-banner error" role="alert">
            <div className="banner-left">
              <AlertCircleIcon size={16} />
              <span>{roomError}</span>
            </div>
            <button
              type="button"
              onClick={clearRoomError}
              className="btn-leave-meeting"
              style={{ padding: '3px 10px', fontSize: 11 }}
            >
              Dismiss
            </button>
          </div>
        )}

        {currentRoom === 'focus' && (
          <div className="room-banner focus" role="status">
            <div className="banner-left">
              <InfoIcon size={16} />
              <span>
                <strong>Focus Room</strong> — Quiet zone for deep focus. Audio transmission is restricted to immediate earshot.
              </span>
            </div>
          </div>
        )}

        {roomInfo.isPrivate && (
          <div className="room-banner private" role="status">
            <div className="private-meta-group">
              <div className="banner-left">
                <LockIcon size={16} />
                <span><strong>Private Meeting:</strong> {roomInfo.title}</span>
              </div>
              <span className="code-pill">
                <span>Code:</span>
                <strong>{roomInfo.code}</strong>
                <button
                  type="button"
                  className="btn-copy-code"
                  onClick={handleCopyCode}
                  aria-label="Copy invitation code"
                >
                  {copiedCode ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                  <span>{copiedCode ? 'Copied!' : 'Copy'}</span>
                </button>
              </span>
            </div>
            <button
              type="button"
              className="btn-leave-meeting"
              onClick={() => setShowLeaveConfirm(true)}
              aria-label="Leave private meeting"
            >
              <LogOutIcon size={13} />
              <span>Leave Meeting</span>
            </button>
          </div>
        )}

        {/* ── Main Workspace Grid ─────────────────────────────────────────── */}
        <div className="office-grid">
          {/* ── Office Canvas Section ─────────────────────────────────────── */}
          <section className="card" aria-label="Virtual office map">
            <div className="card-header">
              <div>
                <h2>
                  <BuildingIcon size={16} />
                  <span>{roomInfo.title || 'Virtual Office Floor'}</span>
                </h2>
                <p>Live collaborative workspace · Space: {roomInfo.room || currentRoom}</p>
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
                <div className="canvas-offline-toast" role="status">
                  <span className="offline-badge">OFFLINE PREVIEW</span>
                  <span>
                    Server offline. Start with <code>npm --prefix backend run dev</code> to connect.
                  </span>
                </div>
              )}
              <canvas
                ref={canvasRef}
                aria-label="Interactive 2D virtual office map showing participant avatars"
                style={{ cursor: 'crosshair' }}
              />
            </div>

            {/* Interactive Workstation Sitting Prompt */}
            {currentWorkstation ? (
              <div className="workstation-prompt-pill active" role="status">
                <span className="desk-indicator">🪑</span>
                <span className="desk-prompt-text">
                  Working at <strong>{currentWorkstation.name}</strong> ({currentWorkstation.zone})
                </span>
                <button
                  type="button"
                  className="btn-workstation-action"
                  onClick={leaveWorkstation}
                  title="Stand up (or press E)"
                >
                  Leave Desk (E)
                </button>
              </div>
            ) : nearbyDesk ? (
              <div className="workstation-prompt-pill" role="status">
                <span className="desk-indicator">🪑</span>
                <span className="desk-prompt-text">
                  Near <strong>{nearbyDesk.name}</strong> ({nearbyDesk.zone})
                  {occupiedDesks[nearbyDesk.id] ? ` · Occupied by ${occupiedDesks[nearbyDesk.id].name}` : ''}
                </span>
                {!occupiedDesks[nearbyDesk.id] ? (
                  <button
                    type="button"
                    className="btn-workstation-action"
                    onClick={() => sitAtWorkstation(nearbyDesk)}
                    title="Sit down at desk (or press E)"
                  >
                    Sit Here (E)
                  </button>
                ) : (
                  <span className="desk-occupied-badge">Occupied</span>
                )}
              </div>
            ) : null}

            <div className="office-footer">
              <span><i className="legend-dot my-dot" />You</span>
              <span><i className="legend-dot other-dot" />Teammates</span>
              {nearbyUsers.length > 0 && (
                <span style={{ color: 'var(--primary-600)', fontWeight: 700 }}>
                  <VolumeIcon size={14} />
                  <span>{nearbyUsers.length} in earshot</span>
                </span>
              )}
              <span className="movement-hint">Move: WASD or Arrow Keys · Sit: E</span>
            </div>
          </section>

          {/* ── Right Sidebar ─────────────────────────────────────────────── */}
          <aside className="sidebar">
            {/* Movement Controls Card */}
            <div className="card controls-card">
              <div className="card-header">
                <div>
                  <h2>Direction Controls</h2>
                  <p>Move avatar across office</p>
                </div>
              </div>
              <div className="card-body">
                <p className="section-label">Compass Pad</p>
                <div className="direction-pad" role="group" aria-label="Avatar direction navigation buttons">
                  <button data-dir="up"    onClick={() => move(0, -STEP)} aria-label="Move up"><ChevronUpIcon size={18} /></button>
                  <button data-dir="left"  onClick={() => move(-STEP, 0)} aria-label="Move left"><ChevronLeftIcon size={18} /></button>
                  <button data-dir="down"  onClick={() => move(0,  STEP)} aria-label="Move down"><ChevronDownIcon size={18} /></button>
                  <button data-dir="right" onClick={() => move( STEP, 0)} aria-label="Move right"><ChevronRightIcon size={18} /></button>
                </div>
              </div>
            </div>

            {/* Voice & Microphone Card */}
            <div className="card">
              <div className="card-header">
                <div>
                  <h2>Proximity Audio</h2>
                  <p>Room-scoped spatial voice</p>
                </div>
              </div>
              <div className="card-body">
                <div className="mic-status" role="status" aria-live="polite">
                  <span className={`mic-status-dot ${micState}`} />
                  {micState === 'idle'       && 'Microphone off'}
                  {micState === 'requesting' && 'Requesting access…'}
                  {micState === 'active'     && 'Microphone active'}
                  {micState === 'muted'      && 'Microphone muted'}
                  {micState === 'denied'     && 'Microphone permission denied'}
                  {micState === 'error'      && 'Microphone hardware error'}
                </div>

                <div className="mic-actions">
                  <button
                    type="button"
                    className={`mic-btn ${micState === 'muted' ? 'muted' : micState === 'denied' ? 'denied' : ''}`}
                    onClick={handleMicClick}
                    disabled={micState === 'requesting' || micState === 'denied'}
                    aria-label={micState === 'active' ? 'Mute microphone' : 'Enable microphone'}
                  >
                    {micState === 'active' ? (
                      <MicIcon size={16} />
                    ) : micState === 'denied' ? (
                      <MicDeniedIcon size={16} />
                    ) : (
                      <MicOffIcon size={16} />
                    )}
                    <span>
                      {micState === 'idle'       && 'Enable Microphone'}
                      {micState === 'requesting' && 'Requesting Access…'}
                      {micState === 'active'     && 'Mute Microphone'}
                      {micState === 'muted'      && 'Unmute Microphone'}
                      {micState === 'denied'     && 'Access Denied'}
                      {micState === 'error'      && 'Retry Microphone'}
                    </span>
                  </button>

                  {(micState === 'active' || micState === 'muted') && (
                    <button
                      type="button"
                      className="mic-secondary-btn"
                      onClick={disableMic}
                      aria-label="Turn off microphone stream"
                    >
                      Turn Off Microphone
                    </button>
                  )}
                </div>

                {webrtcError && (
                  <div className="webrtc-error-box" role="alert">
                    <AlertCircleIcon size={14} />
                    <span>{webrtcError}</span>
                  </div>
                )}

                {audioConnections > 0 && (
                  <p className="mic-hint">
                    Audio connected to {audioConnections} peer{audioConnections > 1 ? 's' : ''} in this space
                  </p>
                )}
                {micState === 'idle' && (
                  <p className="mic-hint">
                    Enable your microphone to chat with nearby teammates. Audio volume scales smoothly with distance.
                  </p>
                )}
                {micState === 'denied' && (
                  <p className="mic-hint">
                    Microphone access was denied. Check your browser privacy permissions and reload.
                  </p>
                )}
              </div>
            </div>

            {/* Tabbed Teammates & Room Chat Card */}
            <div className="card tabbed-sidebar-card">
              <div className="sidebar-tab-bar" role="tablist" aria-label="Sidebar navigation">
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab === 'teammates'}
                  className={`sidebar-tab-btn ${sidebarTab === 'teammates' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('teammates')}
                >
                  <UsersIcon size={14} />
                  <span>Teammates</span>
                  <span className="tab-counter-badge">{users.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarTab === 'chat'}
                  className={`sidebar-tab-btn ${sidebarTab === 'chat' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('chat')}
                >
                  <span>💬</span>
                  <span>In-Room Chat</span>
                  {roomMessages.length > 0 && (
                    <span className="tab-counter-badge">{roomMessages.length}</span>
                  )}
                </button>
              </div>

              <div className="card-body sidebar-tab-content">
                {sidebarTab === 'teammates' ? (
                  <div className="nearby-list" aria-live="polite" aria-label="Connected room participants">
                    {users.length === 0 ? (
                      <div className="nearby-empty">
                        <RadioIcon size={24} className="nearby-empty-icon" />
                        <p><strong>Offline Preview Mode</strong></p>
                        <p>Start backend on port 5000 to connect with teammates.</p>
                      </div>
                    ) : users.length === 1 ? (
                      <div className="nearby-empty">
                        <UsersIcon size={24} className="nearby-empty-icon" />
                        <p><strong>You are the only one here</strong></p>
                        <p>Invite colleagues to join this room or explore another space!</p>
                      </div>
                    ) : null}

                    {(users.length > 0 ? users : [{
                      id: 'local-preview',
                      name: profile.name || 'You',
                      avatarColor: profile.avatarColor || '#2563eb',
                      avatarStyle: profile.avatarStyle || 'classic',
                      status: profile.status || 'online',
                      micEnabled: false,
                    }]).map((u) => {
                      const isMe = u.id === myId || u.id === 'local-preview';
                      const nearbyInfo = nearbyUsers.find((n) => n.user.id === u.id);
                      const statusVal = u.status || 'online';
                      const initials = (u.name || (isMe ? 'YOU' : 'GU')).slice(0, 2).toUpperCase();

                      return (
                        <div key={u.id} className="nearby-user-row">
                          <div
                            className="nearby-avatar"
                            style={{ background: u.avatarColor || (isMe ? '#2563eb' : '#06b6d4') }}
                          >
                            {initials}
                          </div>
                          <span className="nearby-user-name">
                            {u.name || 'Guest'} {isMe && '(You)'}
                          </span>
                          <div className="nearby-meta">
                            <span
                              className={`status-indicator-dot ${statusVal}`}
                              title={`Status: ${statusVal.charAt(0).toUpperCase() + statusVal.slice(1)}`}
                            />
                            <span
                              className="user-mic-pill"
                              title={u.micEnabled ? 'Microphone on' : 'Microphone muted'}
                            >
                              {u.micEnabled ? (
                                <span style={{ color: 'var(--status-online)' }}><MicIcon size={13} /></span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)' }}><MicOffIcon size={13} /></span>
                              )}
                            </span>
                            {nearbyInfo ? (
                              <span className="nearby-vol" title="Proximity volume">
                                {Math.round(volumeFromDistance(nearbyInfo.dist) * 100)}%
                              </span>
                            ) : !isMe ? (
                              <span className="nearby-dist" title="Beyond earshot radius">Far</span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="chat-view-container">
                    <div className="chat-messages-container" role="log" aria-live="polite">
                      {roomMessages.length === 0 ? (
                        <div className="chat-empty-state">
                          <span className="chat-empty-icon">💬</span>
                          <p><strong>No messages yet</strong></p>
                          <p>Messages sent here are isolated to <strong>{roomInfo.title}</strong>.</p>
                        </div>
                      ) : (
                        roomMessages.map((msg) => {
                          const isMe = msg.senderId === myId;
                          return (
                            <div
                              key={msg.id}
                              className={`chat-message-bubble ${isMe ? 'is-me' : ''}`}
                            >
                              <div className="chat-msg-header">
                                <span
                                  className="chat-msg-avatar"
                                  style={{ background: msg.avatarColor || (isMe ? '#2563eb' : '#06b6d4') }}
                                >
                                  {(msg.senderName || 'GU').slice(0, 2).toUpperCase()}
                                </span>
                                <span className="chat-msg-name">
                                  {msg.senderName} {isMe ? '(You)' : ''}
                                </span>
                                <span className="chat-msg-time">{msg.timestamp}</span>
                              </div>
                              <div className="chat-msg-text">{msg.text}</div>
                            </div>
                          );
                        })
                      )}
                      <div ref={chatBottomRef} />
                    </div>

                    <form className="chat-input-form" onSubmit={handleSendChat}>
                      <input
                        type="text"
                        className="chat-input-field"
                        placeholder={`Message ${roomInfo.title || 'room'}…`}
                        value={chatInput}
                        maxLength={300}
                        onChange={(e) => setChatInput(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="chat-send-btn"
                        disabled={!chatInput.trim()}
                        title="Send message"
                      >
                        Send
                      </button>
                    </form>
                  </div>
                )}
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
                type="button"
                className="modal-close"
                onClick={() => setShowCustomizer(false)}
                aria-label="Close modal"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              {/* Avatar Live Interactive Preview */}
              <div className="avatar-preview-container">
                <div
                  className="avatar-preview-circle"
                  style={{ background: editProfile.avatarColor || '#2563eb' }}
                >
                  {(editProfile.name || 'ME').slice(0, 2).toUpperCase()}
                  {editProfile.avatarStyle === 'star' && <span className="avatar-preview-badge"><StarIcon size={12} /></span>}
                  {editProfile.avatarStyle === 'crown' && <span className="avatar-preview-badge"><CrownIcon size={12} /></span>}
                  {editProfile.avatarStyle === 'diamond' && <span className="avatar-preview-badge"><DiamondIcon size={12} /></span>}
                  <span
                    className="avatar-preview-status"
                    style={{ background: statusColor(editProfile.status) }}
                  />
                </div>
              </div>

              {/* Display Name Field */}
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

              {/* 10-Color Curated Palette */}
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
                      {editProfile.avatarColor === c && <CheckIcon size={14} />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Badge Style Selection */}
              <div className="form-field">
                <label>Style Badge</label>
                <div className="style-button-group">
                  {STYLES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`choice-btn ${editProfile.avatarStyle === s.id ? 'selected' : ''}`}
                      onClick={() => setEditProfile({ ...editProfile, avatarStyle: s.id })}
                    >
                      <span>{s.icon}</span>
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 3-Tier Availability Status Selection */}
              <div className="form-field">
                <label>Availability Status</label>
                <div className="status-button-group">
                  <button
                    type="button"
                    className={`choice-btn ${editProfile.status === 'online' || !editProfile.status ? 'selected' : ''}`}
                    onClick={() => setEditProfile({ ...editProfile, status: 'online' })}
                  >
                    <span className="status-indicator-dot online" />
                    <span>Online</span>
                  </button>

                  <button
                    type="button"
                    className={`choice-btn ${editProfile.status === 'busy' ? 'selected' : ''}`}
                    onClick={() => setEditProfile({ ...editProfile, status: 'busy' })}
                  >
                    <span className="status-indicator-dot busy" />
                    <span>Busy</span>
                  </button>

                  <button
                    type="button"
                    className={`choice-btn ${editProfile.status === 'away' ? 'selected' : ''}`}
                    onClick={() => setEditProfile({ ...editProfile, status: 'away' })}
                  >
                    <span className="status-indicator-dot away" />
                    <span>Away</span>
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
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Create a private room isolated from public spaces. A unique invitation code (PRV-XXXX) will be generated for your team.
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
                <CloseIcon size={16} />
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

      {/* 4. Leave Private Meeting Confirmation Modal */}
      {showLeaveConfirm && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="leave-title">
          <div className="modal-card">
            <div className="modal-header">
              <h3 id="leave-title">Leave Private Meeting?</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowLeaveConfirm(false)}
                aria-label="Close modal"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 14, color: 'var(--neutral-700)', margin: 0, lineHeight: 1.5 }}>
                Are you sure you want to leave <strong>{roomInfo.title}</strong>? You will be returned to the General Office.
              </p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                If you are the last participant, this private meeting will be closed automatically.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={() => setShowLeaveConfirm(false)}
              >
                Stay in Meeting
              </button>
              <button
                type="button"
                className="modal-btn-danger"
                onClick={confirmLeavePrivate}
              >
                Leave Meeting
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="page-footer">
        ProxiSpeak · Geospatial Proximity Audio Ecosystem · Premium Collaborative Office
      </footer>
    </main>
  );
}
