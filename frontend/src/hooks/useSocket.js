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

    socket.on('connect',           onConnect);
    socket.on('disconnect',        onDisconnect);
    socket.on('connect_error',     onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.on('initial-users',     onInitialUsers);
    socket.on('user-joined',       onUserJoined);
    socket.on('user-moved',        onUserMoved);
    socket.on('user-left',         onUserLeft);

    return () => {
      socket.off('connect',       onConnect);
      socket.off('disconnect',    onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off('initial-users', onInitialUsers);
      socket.off('user-joined',   onUserJoined);
      socket.off('user-moved',    onUserMoved);
      socket.off('user-left',     onUserLeft);
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

  return { socket, connected, connecting, myId, users, usersRef, emitMove };
}
