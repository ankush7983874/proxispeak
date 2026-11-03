/**
 * useSocket.js
 * Manages the Socket.IO lifecycle: connect, disconnect, reconnect events.
 * Returns the socket instance, connection status, own ID, and all users.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import socket from '../services/socket.js';

export function useSocket() {
  const [connected, setConnected]             = useState(false);
  const [connecting, setConnecting]           = useState(true);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'connected' | 'reconnecting' | 'disconnected' | 'error'
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [connectionError, setConnectionError] = useState(null);
  const [recoveryNotice, setRecoveryNotice]   = useState(null);
  const [wasReconnected, setWasReconnected]   = useState(false);
  const [myId, setMyId]                       = useState('');
  const [users, setUsers]                     = useState([]);

  // Phase 3 Room & Profile States
  const [currentRoom, setCurrentRoom] = useState('general');
  const [roomInfo, setRoomInfo]       = useState({
    room: 'general',
    title: 'General Office',
    isPrivate: false,
    code: null,
    hostSocketId: null,
  });
  const [roomCounts, setRoomCounts]   = useState({ general: 0, meeting: 0, focus: 0 });
  const [roomError, setRoomError]     = useState(null);

  // Avatar profile with per-tab guest isolation and localStorage persistence
  const [profile, setProfile] = useState(() => {
    let tabGuestId = null;
    try {
      tabGuestId = sessionStorage.getItem('proxispeak_guest_id');
      if (!tabGuestId) {
        tabGuestId = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        sessionStorage.setItem('proxispeak_guest_id', tabGuestId);
      }
    } catch {
      tabGuestId = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    try {
      const saved = localStorage.getItem('proxispeak_profile');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          guestId: tabGuestId,
          name: typeof parsed.name === 'string' ? parsed.name : '',
          email: typeof parsed.email === 'string' ? parsed.email : '',
          avatarColor: parsed.avatarColor || '#259765',
          avatarStyle: parsed.avatarStyle || 'classic',
          status: parsed.status || 'online',
        };
      }
    } catch {
      // ignore
    }
    return {
      guestId: tabGuestId,
      name: '',
      email: '',
      avatarColor: '#259765',
      avatarStyle: 'classic',
      status: 'online',
    };
  });

  // Room Chat state
  const [roomMessages, setRoomMessages] = useState([]);

  // Live Office Presence state across all office rooms
  const [officePresence, setOfficePresence] = useState([]);

  // Workstation state
  const [occupiedDesks, setOccupiedDesks] = useState({});
  const [currentWorkstation, setCurrentWorkstation] = useState(null);

  // Reconnection and recovery refs
  const previousSocketIdRef   = useRef(null);
  const currentRoomRef        = useRef(currentRoom);
  const roomInfoRef           = useRef(roomInfo);
  const profileRef            = useRef(profile);
  const currentWorkstationRef = useRef(currentWorkstation);
  const lastPosRef            = useRef({ x: 360, y: 110 });
  const hasJoinedRef          = useRef(false);

  useEffect(() => { currentRoomRef.current = currentRoom; }, [currentRoom]);
  useEffect(() => { roomInfoRef.current = roomInfo; }, [roomInfo]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { currentWorkstationRef.current = currentWorkstation; }, [currentWorkstation]);

  // Keep socket.auth populated so Socket.IO sends current identity on reconnection
  useEffect(() => {
    socket.auth = {
      guestId: profile.guestId,
      name: profile.name,
      email: profile.email,
      avatarColor: profile.avatarColor,
      avatarStyle: profile.avatarStyle,
      status: profile.status,
      room: currentRoom,
    };
  }, [profile, currentRoom]);

  // Keep users in a ref so canvas draw loop always has the latest value
  // without re-creating the draw loop itself.
  const usersRef = useRef([]);
  const setUsersSync = useCallback((updater) => {
    setUsers((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      usersRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    // Populate initial preview avatar so canvas and floor plan are immediately alive
    setUsersSync((prev) => {
      if (prev.length === 0) {
        return [{
          id: 'local-preview',
          name: profile.name || 'You',
          x: 360,
          y: 110,
          micEnabled: false,
          room: 'general',
          avatarColor: profile.avatarColor || '#2563eb',
          avatarStyle: profile.avatarStyle || 'classic',
          status: profile.status || 'online',
        }];
      }
      return prev;
    });

    if (!socket.connected) {
      socket.connect();
      setConnecting(true);
      setConnectionStatus('connecting');
    }

    const onConnect = () => {
      const prevId = previousSocketIdRef.current;
      const isReconnect = Boolean(prevId && prevId !== socket.id);

      setConnected(true);
      setConnecting(false);
      setConnectionStatus('connected');
      setReconnectAttempt(0);
      setConnectionError(null);
      setMyId(socket.id);

      // Session & Room recovery upon automatic reconnection
      if (isReconnect && hasJoinedRef.current) {
        const recoveryData = {
          previousSocketId: prevId,
          guestId: profileRef.current?.guestId,
          profile: profileRef.current,
          room: currentRoomRef.current,
          lastX: lastPosRef.current?.x,
          lastY: lastPosRef.current?.y,
          workstation: currentWorkstationRef.current?.id,
        };

        socket.emit('recover-session', recoveryData, (res) => {
          if (res && res.success) {
            if (res.notice) {
              setRecoveryNotice(res.notice);
            }
            if (res.room && res.room !== currentRoomRef.current) {
              setCurrentRoom(res.room);
            }
            setWasReconnected(true);
          }
        });
      } else {
        // Initial connect or profile sync
        if (profileRef.current.name || profileRef.current.avatarColor !== '#2563eb' || profileRef.current.avatarStyle !== 'classic') {
          socket.emit('update-profile', profileRef.current);
        }
      }

      previousSocketIdRef.current = socket.id;
    };

    const onDisconnect = (reason) => {
      setConnected(false);
      if (reason === 'io server disconnect') {
        setConnecting(false);
        setConnectionStatus('disconnected');
        setConnectionError('Server closed the session. Click Reconnect to try again.');
      } else {
        // Transport error or ping timeout: auto-reconnecting
        setConnecting(true);
        setConnectionStatus('reconnecting');
      }
    };

    const onConnectError = (err) => {
      setConnected(false);
      setConnectionError(err?.message || 'Connection error');
      if (socket.active) {
        setConnecting(true);
        setConnectionStatus('reconnecting');
      } else {
        setConnecting(false);
        setConnectionStatus('error');
      }
    };

    const onReconnectAttempt = (attempt) => {
      setConnecting(true);
      setConnectionStatus('reconnecting');
      setReconnectAttempt(attempt);
    };

    const onReconnect = () => {
      setConnected(true);
      setConnecting(false);
      setConnectionStatus('connected');
      setReconnectAttempt(0);
      setConnectionError(null);
    };

    const onReconnectError = (err) => {
      setConnectionError(err?.message || 'Reconnection error');
    };

    const onReconnectFailed = () => {
      setConnected(false);
      setConnecting(false);
      setConnectionStatus('disconnected');
      setConnectionError('Unable to reconnect to office server. Click to retry.');
    };

    const onInitialUsers = (serverUsers) => {
      if (!Array.isArray(serverUsers)) return;
      // Deduplicate by ID and guestId, filter out preview avatar
      const seenIds = new Set();
      const seenGuests = new Set();
      const cleanUsers = [];
      for (const u of serverUsers) {
        if (!u || !u.id || seenIds.has(u.id)) continue;
        if (u.guestId && seenGuests.has(u.guestId)) continue;
        seenIds.add(u.id);
        if (u.guestId) seenGuests.add(u.guestId);
        cleanUsers.push(u);
      }
      setUsersSync(cleanUsers);
    };

    const onUserJoined = (user) => {
      if (!user || !user.id) return;
      setUsersSync((prev) => [
        ...prev.filter((u) => u.id !== user.id && (!user.guestId || u.guestId !== user.guestId) && u.id !== 'local-preview'),
        user,
      ]);
    };

    const onUserMoved = (user) => {
      setUsersSync((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, ...user } : u))
      );
    };

    const onUserLeft = (id) => {
      setUsersSync((prev) => prev.filter((u) => u.id !== id));
    };

    const onUserMicStatus = ({ id, micEnabled }) => {
      setUsersSync((prev) =>
        prev.map((u) => (u.id === id ? { ...u, micEnabled } : u))
      );
    };

    const onUserProfileUpdated = (updated) => {
      setUsersSync((prev) =>
        prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u))
      );
    };

    const onRoomInfo = (info) => {
      setRoomInfo(info);
      if (info?.room) {
        setCurrentRoom(info.room);
        setRoomMessages([]); // Clean room chat on room switch
        setCurrentWorkstation(null);
      }
    };

    const onRoomCounts = (counts) => {
      if (counts && typeof counts === 'object') {
        setRoomCounts(counts);
      }
    };

    const onRoomError = ({ message }) => {
      setRoomError(message || 'Room error occurred');
    };

    const onRoomChatMessage = (msg) => {
      if (msg && typeof msg === 'object') {
        setRoomMessages((prev) => [...prev.slice(-99), msg]);
      }
    };

    const onWorkstationOccupancy = (desks) => {
      if (desks && typeof desks === 'object') {
        setOccupiedDesks(desks);
      }
    };

    const onPresenceList = (list) => {
      if (Array.isArray(list)) {
        setOfficePresence(list);
      }
    };

    socket.on('connect',              onConnect);
    socket.on('disconnect',           onDisconnect);
    socket.on('connect_error',        onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.io.on('reconnect',         onReconnect);
    socket.io.on('reconnect_error',   onReconnectError);
    socket.io.on('reconnect_failed',  onReconnectFailed);
    socket.on('initial-users',        onInitialUsers);
    socket.on('user-joined',          onUserJoined);
    socket.on('user-moved',           onUserMoved);
    socket.on('user-left',            onUserLeft);
    socket.on('user-mic-status',      onUserMicStatus);
    socket.on('user-profile-updated', onUserProfileUpdated);
    socket.on('room-info',            onRoomInfo);
    socket.on('room-counts',          onRoomCounts);
    socket.on('room-error',           onRoomError);
    socket.on('room-chat-message',    onRoomChatMessage);
    socket.on('workstation-occupancy',onWorkstationOccupancy);
    socket.on('presence-list',        onPresenceList);

    return () => {
      socket.off('connect',              onConnect);
      socket.off('disconnect',           onDisconnect);
      socket.off('connect_error',        onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.io.off('reconnect',         onReconnect);
      socket.io.off('reconnect_error',   onReconnectError);
      socket.io.off('reconnect_failed',  onReconnectFailed);
      socket.off('initial-users',        onInitialUsers);
      socket.off('user-joined',          onUserJoined);
      socket.off('user-moved',           onUserMoved);
      socket.off('user-left',            onUserLeft);
      socket.off('user-mic-status',      onUserMicStatus);
      socket.off('user-profile-updated', onUserProfileUpdated);
      socket.off('room-info',            onRoomInfo);
      socket.off('room-counts',          onRoomCounts);
      socket.off('room-error',           onRoomError);
      socket.off('room-chat-message',    onRoomChatMessage);
      socket.off('workstation-occupancy',onWorkstationOccupancy);
      socket.off('presence-list',        onPresenceList);
      socket.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Manual reconnect trigger with safety check
   */
  const reconnect = useCallback(() => {
    if (!socket.connected) {
      setConnecting(true);
      setConnectionStatus('reconnecting');
      setConnectionError(null);
      socket.connect();
    }
  }, []);

  /**
   * Update virtual office entered/left flag for session recovery
   */
  const setJoinedOffice = useCallback((joined) => {
    hasJoinedRef.current = Boolean(joined);
  }, []);

  const clearRecoveryNotice = useCallback(() => {
    setRecoveryNotice(null);
  }, []);

  /**
   * Emit a throttled move event.
   * The server enforces clamping; during offline preview we move locally.
   */
  const emitMove = useCallback((x, y) => {
    lastPosRef.current = { x, y };
    if (socket.connected) {
      socket.emit('move', { x, y });
    } else {
      setUsersSync((prev) => {
        if (prev.length === 0) {
          return [{
            id: myId || 'local-preview',
            name: profile?.name || 'You',
            x,
            y,
            micEnabled: false,
            room: 'general',
            avatarColor: profile?.avatarColor || '#2563eb',
            avatarStyle: profile?.avatarStyle || 'classic',
            status: profile?.status || 'online',
          }];
        }
        return prev.map((u) => ({ ...u, x, y }));
      });
    }
  }, [myId, profile, setUsersSync]);

  /**
   * Emit mic status updates to all peers via server broadcast.
   */
  const emitMicStatus = useCallback((micEnabled) => {
    if (socket.connected) {
      socket.emit('update-mic-status', { micEnabled });
    }
  }, []);

  /**
   * Switch room (public or private by code)
   */
  const joinRoom = useCallback((room, code, customProfile, callback) => {
    if (socket.connected) {
      setRoomError(null);
      const activeProfile = customProfile || profile;
      socket.emit('join-room', { room, code, profile: activeProfile }, (res) => {
        if (typeof callback === 'function') callback(res);
      });
    } else if (typeof callback === 'function') {
      callback({ success: false, error: 'Socket is not connected to server' });
    }
  }, [profile]);

  /**
   * Leave the virtual office and return to welcome page
   */
  const leaveOffice = useCallback(() => {
    hasJoinedRef.current = false;
    if (socket.connected) {
      socket.emit('leave-office');
    }
  }, []);

  /**
   * Create a private meeting room
   */
  const createPrivateRoom = useCallback((title) => {
    if (socket.connected) {
      setRoomError(null);
      socket.emit('create-private-room', { title });
    }
  }, []);

  /**
   * Leave private meeting room, returning to General Office
   */
  const leavePrivateRoom = useCallback(() => {
    if (socket.connected) {
      setRoomError(null);
      socket.emit('leave-private-room');
    }
  }, []);

  /**
   * Update avatar customization and broadcast to room
   */
  const updateProfile = useCallback((newProfile) => {
    const merged = { ...profile, ...newProfile };
    setProfile(merged);
    try {
      localStorage.setItem('proxispeak_profile', JSON.stringify(merged));
      if (merged.guestId) {
        sessionStorage.setItem('proxispeak_guest_id', merged.guestId);
      }
    } catch {
      // ignore
    }
    if (socket.connected) {
      socket.emit('update-profile', merged);
    } else {
      setUsersSync((prev) =>
        prev.map((u) =>
          u.id === 'local-preview' || u.id === myId
            ? {
                ...u,
                name: merged.name || u.name,
                avatarColor: merged.avatarColor || u.avatarColor,
                avatarStyle: merged.avatarStyle || u.avatarStyle,
                status: merged.status || u.status,
              }
            : u
        )
      );
    }
  }, [profile, myId, setUsersSync]);

  /**
   * Send in-room text chat message
   */
  const sendRoomChat = useCallback((text) => {
    if (socket.connected && text && text.trim()) {
      socket.emit('send-room-chat', { text: text.trim() });
    }
  }, []);

  /**
   * Sit at an interactive workstation / desk
   */
  const sitAtWorkstation = useCallback((desk) => {
    if (!desk) return;
    setCurrentWorkstation(desk);
    if (socket.connected) {
      socket.emit('sit-workstation', { deskId: desk.id, deskName: desk.name });
    }
  }, []);

  /**
   * Leave the workstation
   */
  const leaveWorkstation = useCallback(() => {
    setCurrentWorkstation(null);
    if (socket.connected) {
      socket.emit('leave-workstation');
    }
  }, []);

  const clearRoomError = useCallback(() => {
    setRoomError(null);
  }, []);

  return {
    socket,
    connected,
    connecting,
    connectionStatus,
    reconnectAttempt,
    connectionError,
    recoveryNotice,
    clearRecoveryNotice,
    wasReconnected,
    setWasReconnected,
    reconnect,
    setJoinedOffice,
    myId,
    users,
    usersRef,
    currentRoom,
    roomInfo,
    roomCounts,
    roomError,
    profile,
    roomMessages,
    officePresence,
    occupiedDesks,
    currentWorkstation,
    emitMove,
    emitMicStatus,
    joinRoom,
    leaveOffice,
    createPrivateRoom,
    leavePrivateRoom,
    updateProfile,
    sendRoomChat,
    sitAtWorkstation,
    leaveWorkstation,
    clearRoomError,
  };
}
