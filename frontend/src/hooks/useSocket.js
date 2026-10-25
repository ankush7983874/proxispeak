/**
 * useSocket.js
 * Manages the Socket.IO lifecycle: connect, disconnect, reconnect events.
 * Returns the socket instance, connection status, own ID, and all users.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import socket from '../services/socket.js';

export function useSocket() {
  const [connected, setConnected]   = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [myId, setMyId]             = useState('');
  const [users, setUsers]           = useState([]);

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

  // Avatar profile with localStorage persistence
  const [profile, setProfile] = useState(() => {
    try {
      const saved = localStorage.getItem('proxispeak_profile');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          name: typeof parsed.name === 'string' ? parsed.name : '',
          avatarColor: parsed.avatarColor || '#259765',
          avatarStyle: parsed.avatarStyle || 'classic',
          status: parsed.status || 'online',
        };
      }
    } catch {
      // ignore
    }
    return {
      name: '',
      avatarColor: '#259765',
      avatarStyle: 'classic',
      status: 'online',
    };
  });

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
    socket.connect();
    setConnecting(true);

    const onConnect = () => {
      setConnected(true);
      setConnecting(false);
      setMyId(socket.id);

      // If user had a saved profile name or custom color, sync to server
      if (profile.name || profile.avatarColor !== '#259765' || profile.avatarStyle !== 'classic') {
        socket.emit('update-profile', profile);
      }
    };

    const onDisconnect = () => {
      setConnected(false);
      setConnecting(false);
    };

    const onConnectError = () => {
      setConnected(false);
      setConnecting(false);
    };

    const onReconnectAttempt = () => {
      setConnecting(true);
    };

    const onInitialUsers = (serverUsers) => {
      setUsersSync(serverUsers);
    };

    const onUserJoined = (user) => {
      setUsersSync((prev) => [
        ...prev.filter((u) => u.id !== user.id),
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

    socket.on('connect',              onConnect);
    socket.on('disconnect',           onDisconnect);
    socket.on('connect_error',        onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.on('initial-users',        onInitialUsers);
    socket.on('user-joined',          onUserJoined);
    socket.on('user-moved',           onUserMoved);
    socket.on('user-left',            onUserLeft);
    socket.on('user-mic-status',      onUserMicStatus);
    socket.on('user-profile-updated', onUserProfileUpdated);
    socket.on('room-info',            onRoomInfo);
    socket.on('room-counts',          onRoomCounts);
    socket.on('room-error',           onRoomError);

    return () => {
      socket.off('connect',              onConnect);
      socket.off('disconnect',           onDisconnect);
      socket.off('connect_error',        onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off('initial-users',        onInitialUsers);
      socket.off('user-joined',          onUserJoined);
      socket.off('user-moved',           onUserMoved);
      socket.off('user-left',            onUserLeft);
      socket.off('user-mic-status',      onUserMicStatus);
      socket.off('user-profile-updated', onUserProfileUpdated);
      socket.off('room-info',            onRoomInfo);
      socket.off('room-counts',          onRoomCounts);
      socket.off('room-error',           onRoomError);
      socket.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Emit a throttled move event.
   * The server enforces clamping; the client just sends deltas.
   */
  const emitMove = useCallback((x, y) => {
    if (socket.connected) {
      socket.emit('move', { x, y });
    }
  }, []);

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
  const joinRoom = useCallback((room, code) => {
    if (socket.connected) {
      setRoomError(null);
      socket.emit('join-room', { room, code, profile });
    }
  }, [profile]);

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
    } catch {
      // ignore
    }
    if (socket.connected) {
      socket.emit('update-profile', merged);
    }
  }, [profile]);

  const clearRoomError = useCallback(() => {
    setRoomError(null);
  }, []);

  return {
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
    emitMove,
    emitMicStatus,
    joinRoom,
    createPrivateRoom,
    leavePrivateRoom,
    updateProfile,
    clearRoomError,
  };
}
