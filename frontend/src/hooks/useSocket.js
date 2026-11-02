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
          guestId: parsed.guestId || `guest_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
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
      guestId: `guest_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
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

    socket.connect();
    setConnecting(true);

    const onConnect = () => {
      setConnected(true);
      setConnecting(false);
      setMyId(socket.id);

      // If user had a saved profile name or custom color, sync to server
      if (profile.name || profile.avatarColor !== '#2563eb' || profile.avatarStyle !== 'classic') {
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
   * Emit a throttled move event.
   * The server enforces clamping; during offline preview we move locally.
   */
  const emitMove = useCallback((x, y) => {
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
