/**
 * PresencePanel.jsx — Live Employee Presence Directory
 *
 * Real-time presence directory showing only genuinely connected participants:
 *  • Name, avatar with custom color & style badge (⭐, 👑, 💎)
 *  • 3-Tier Availability status: Online (green), Busy (red), Away (amber)
 *  • Microphone status (Active, Muted, Off)
 *  • Current room badge (General Office, Meeting Room, Focus Room, Private Meeting)
 *  • Quick room travel button (join colleague's room with one click)
 *  • Workstation occupancy badge (e.g., Dev Pod, Workstation 1)
 *  • Proximity earshot indicator when in the same room
 *  • Real-time employee search & status filter pills
 *  • Zero fake data; 100% synchronized via Socket.IO
 */
import { useState, useMemo } from 'react';
import {
  UsersIcon,
  MicIcon,
  MicOffIcon,
  BuildingIcon,
  LockIcon,
  HeadphonesIcon,
  StarIcon,
  CrownIcon,
  DiamondIcon,
} from './Icons.jsx';
import { volumeFromDistance, calculateAudioObstruction } from '../utils/proximity.js';

export function PresencePanel({
  presenceList = [],
  myId = '',
  currentRoom = 'general',
  nearbyUsers = [],
  onJoinRoom = null,
  me = null,
  obstacles = [],
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'online' | 'busy' | 'away'

  // Calculate live counts
  const counts = useMemo(() => {
    let online = 0;
    let busy = 0;
    let away = 0;
    for (const p of presenceList) {
      if (p.status === 'busy') busy++;
      else if (p.status === 'away') away++;
      else online++;
    }
    return { all: presenceList.length, online, busy, away };
  }, [presenceList]);

  // Filtered presence list
  const filteredList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return presenceList.filter((p) => {
      // 1. Status Filter
      if (statusFilter !== 'all') {
        const pStatus = p.status || 'online';
        if (pStatus !== statusFilter) return false;
      }
      // 2. Search Query
      if (!q) return true;
      const nameMatch = (p.name || '').toLowerCase().includes(q);
      const emailMatch = (p.email || '').toLowerCase().includes(q);
      const roomMatch = (p.roomTitle || p.room || '').toLowerCase().includes(q);
      const deskMatch = (p.workstation || '').toLowerCase().includes(q);
      const statusMatch = (p.status || 'online').toLowerCase().includes(q);
      return nameMatch || emailMatch || roomMatch || deskMatch || statusMatch;
    });
  }, [presenceList, searchQuery, statusFilter]);

  const getStatusBadge = (status) => {
    const s = status || 'online';
    if (s === 'busy') return { label: 'Busy', dotClass: 'busy', color: '#ef4444' };
    if (s === 'away') return { label: 'Away', dotClass: 'away', color: '#f59e0b' };
    return { label: 'Online', dotClass: 'online', color: '#10b981' };
  };

  const getRoomIcon = (p) => {
    if (p.isPrivate || p.room?.startsWith('PRV-')) return <LockIcon size={12} />;
    if (p.room === 'meeting') return <UsersIcon size={12} />;
    if (p.room === 'focus') return <HeadphonesIcon size={12} />;
    return <BuildingIcon size={12} />;
  };

  return (
    <div className="presence-panel" aria-label="Live Employee Presence Panel">
      {/* ── Header with Live Counter ─────────────────────────── */}
      <div className="presence-header">
        <div className="presence-title-wrap">
          <div className="presence-live-indicator" aria-hidden="true">
            <span className="live-pulse-dot" />
          </div>
          <div>
            <h3 className="presence-title">Live Presence</h3>
            <p className="presence-subtitle">
              {presenceList.length} connected colleague{presenceList.length === 1 ? '' : 's'} across office
            </p>
          </div>
        </div>
      </div>

      {/* ── Search Input ─────────────────────────────────────── */}
      <div className="presence-search-wrap">
        <span className="search-icon" aria-hidden="true">🔍</span>
        <input
          type="text"
          className="presence-search-input"
          placeholder="Search by name, email, or room…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search participants"
        />
        {searchQuery && (
          <button
            type="button"
            className="search-clear-btn"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search query"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── Status Filter Pills ──────────────────────────────── */}
      <div className="presence-filter-bar" role="tablist" aria-label="Filter participants by status">
        <button
          type="button"
          className={`filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
          onClick={() => setStatusFilter('all')}
          role="tab"
          aria-selected={statusFilter === 'all'}
        >
          All <span className="pill-count">{counts.all}</span>
        </button>
        <button
          type="button"
          className={`filter-pill ${statusFilter === 'online' ? 'active' : ''}`}
          onClick={() => setStatusFilter('online')}
          role="tab"
          aria-selected={statusFilter === 'online'}
        >
          <span className="mini-status-dot online" />
          Online <span className="pill-count">{counts.online}</span>
        </button>
        <button
          type="button"
          className={`filter-pill ${statusFilter === 'busy' ? 'active' : ''}`}
          onClick={() => setStatusFilter('busy')}
          role="tab"
          aria-selected={statusFilter === 'busy'}
        >
          <span className="mini-status-dot busy" />
          Busy <span className="pill-count">{counts.busy}</span>
        </button>
        <button
          type="button"
          className={`filter-pill ${statusFilter === 'away' ? 'active' : ''}`}
          onClick={() => setStatusFilter('away')}
          role="tab"
          aria-selected={statusFilter === 'away'}
        >
          <span className="mini-status-dot away" />
          Away <span className="pill-count">{counts.away}</span>
        </button>
      </div>

      {/* ── Participants List ─────────────────────────────────── */}
      <div className="presence-list" role="list" aria-live="polite">
        {presenceList.length === 0 ? (
          <div className="presence-empty-state">
            <span className="presence-empty-icon">👥</span>
            <p><strong>Waiting for connection…</strong></p>
            <p>Live presence synchronizes automatically upon connecting.</p>
          </div>
        ) : filteredList.length === 0 ? (
          <div className="presence-empty-state">
            <span className="presence-empty-icon">🔍</span>
            <p><strong>No colleagues match your search</strong></p>
            <p>Try searching for a different name, room, or status.</p>
          </div>
        ) : (
          filteredList.map((p) => {
            const isMe = p.id === myId;
            const statusInfo = getStatusBadge(p.status);
            const initials = (p.name || (isMe ? 'YOU' : 'GU')).slice(0, 2).toUpperCase();
            const isInSameRoom = p.room === currentRoom;
            const nearbyInfo = nearbyUsers.find((n) => n.user.id === p.id);

            return (
              <div
                key={p.id}
                className={`presence-card ${isMe ? 'is-self' : ''}`}
                role="listitem"
              >
                {/* Avatar with Status & Badge */}
                <div className="presence-avatar-wrap">
                  <div
                    className="presence-avatar"
                    style={{ background: p.avatarColor || '#2563eb' }}
                  >
                    {initials}
                    {p.avatarStyle === 'star' && <span className="presence-style-badge"><StarIcon size={10} /></span>}
                    {p.avatarStyle === 'crown' && <span className="presence-style-badge"><CrownIcon size={10} /></span>}
                    {p.avatarStyle === 'diamond' && <span className="presence-style-badge"><DiamondIcon size={10} /></span>}
                  </div>
                  <span
                    className={`presence-status-dot ${statusInfo.dotClass}`}
                    title={`Status: ${statusInfo.label}`}
                  />
                </div>

                {/* Identity & Room Info */}
                <div className="presence-details">
                  <div className="presence-name-row">
                    <span className="presence-name">
                      {p.name || 'Guest'}
                    </span>
                    {isMe && <span className="presence-self-badge">You</span>}
                  </div>

                  <div className="presence-tags-row">
                    {/* Room Badge */}
                    <span
                      className={`presence-room-pill ${isInSameRoom ? 'same-room' : 'other-room'}`}
                      title={isInSameRoom ? 'In your current room' : `Currently in ${p.roomTitle}`}
                    >
                      {getRoomIcon(p)}
                      <span>{p.roomTitle || p.room || 'General'}</span>
                    </span>

                    {/* Workstation Pill */}
                    {p.workstation && (
                      <span className="presence-desk-pill" title={`Seated at ${p.workstation}`}>
                        🪑 <span>{p.workstation}</span>
                      </span>
                    )}

                    {/* Same-Room Proximity Volume Info */}
                    {isInSameRoom && !isMe && (
                      nearbyInfo ? (() => {
                        let transmission = 1.0;
                        let blockedBy = [];
                        if (me && obstacles && obstacles.length > 0) {
                          const obs = calculateAudioObstruction(me, p, obstacles);
                          transmission = obs.transmission;
                          blockedBy = obs.blockedBy;
                        }
                        const finalPct = Math.round(volumeFromDistance(nearbyInfo.dist) * transmission * 100);
                        const isObstructed = blockedBy.length > 0;

                        return (
                          <span
                            className={`presence-audio-pill near ${isObstructed ? 'obstructed' : ''}`}
                            title={isObstructed ? `Proximity volume: ${finalPct}% (obstructed by ${blockedBy.join(', ')})` : `Proximity volume: ${finalPct}%`}
                          >
                            🔊 {finalPct}%{isObstructed ? ' 🧱' : ''}
                          </span>
                        );
                      })() : (
                        <span className="presence-audio-pill far" title="Beyond earshot radius">
                          Far
                        </span>
                      )
                    )}
                  </div>
                </div>

                {/* Right Side: Mic Indicator & Actions */}
                <div className="presence-actions">
                  <span
                    className={`presence-mic-pill ${p.micEnabled ? 'active' : 'muted'}`}
                    title={p.micEnabled ? 'Microphone is active' : 'Microphone is muted/off'}
                  >
                    {p.micEnabled ? (
                      <MicIcon size={14} />
                    ) : (
                      <MicOffIcon size={14} />
                    )}
                  </span>

                  {/* Quick Travel Button if colleague is in another public room */}
                  {!isInSameRoom && onJoinRoom && !p.isPrivate && (
                    <button
                      type="button"
                      className="btn-presence-join"
                      onClick={() => onJoinRoom(p.room)}
                      title={`Go to ${p.roomTitle}`}
                    >
                      Go →
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
