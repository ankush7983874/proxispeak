/**
 * ConnectionStatus.jsx — Production Connection Monitoring & Toast Notifications
 *
 * Provides:
 *  1. ConnectionIndicator: Compact, accessible indicator pill for the topbar
 *     (Connected: Green, Reconnecting: Amber with subtle spinner/pulse, Disconnected: Red with Retry button)
 *  2. ConnectionToast: Floating non-intrusive status toast with automatic transition detection,
 *     deduplication, auto-dismiss, and session recovery notice handling.
 */
import { useEffect, useRef, useState } from 'react';
import { RefreshCwIcon, WifiOffIcon, CheckIcon, AlertCircleIcon, CloseIcon } from './Icons.jsx';

/**
 * Compact Connection Indicator for Topbar
 */
export function ConnectionIndicator({
  connectionStatus = 'connected',
  reconnectAttempt = 0,
  onReconnect,
  className = '',
}) {
  const isConnected    = connectionStatus === 'connected';
  const isReconnecting = connectionStatus === 'reconnecting';
  const isDisconnected = connectionStatus === 'disconnected' || connectionStatus === 'error';

  let statusClass = 'connected';
  let labelText = 'Connected';

  if (isReconnecting) {
    statusClass = 'reconnecting';
    labelText = reconnectAttempt > 0 ? `Reconnecting (${reconnectAttempt})…` : 'Reconnecting…';
  } else if (isDisconnected) {
    statusClass = 'disconnected';
    labelText = 'Connection Lost';
  }

  return (
    <div
      className={`connection-indicator ${statusClass} ${className}`}
      role="status"
      aria-live="polite"
      title={isReconnecting ? `Reconnection attempt ${reconnectAttempt}` : labelText}
    >
      {isConnected && (
        <>
          <span className="status-dot online" aria-hidden="true" />
          <span className="connection-text">{labelText}</span>
        </>
      )}

      {isReconnecting && (
        <>
          <span className="connection-spinner" aria-hidden="true" />
          <span className="connection-text">{labelText}</span>
        </>
      )}

      {isDisconnected && (
        <>
          <span className="status-dot error" aria-hidden="true" />
          <span className="connection-text">{labelText}</span>
          {typeof onReconnect === 'function' && (
            <button
              type="button"
              className="btn-indicator-retry"
              onClick={onReconnect}
              title="Attempt manual reconnection"
              aria-label="Retry connection"
            >
              <RefreshCwIcon size={11} />
              <span>Retry</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Floating Connection Notification Toast
 * Automatically displays non-duplicate notifications during connection drops,
 * successful reconnections, and room recovery fallbacks.
 */
export function ConnectionToast({
  connectionStatus = 'connected',
  connectionError = null,
  wasReconnected = false,
  recoveryNotice = null,
  onClearRecoveryNotice,
  onReconnect,
}) {
  const [toast, setToast] = useState(null); // { id, type: 'warning'|'success'|'info'|'error', message, canRetry }
  const prevStatusRef = useRef(connectionStatus);
  const autoDismissTimerRef = useRef(null);

  // Transition detection & deduplication
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = connectionStatus;

    if (prev === connectionStatus) return;

    if (autoDismissTimerRef.current) {
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }

    // 1. Connection dropped: transitioned to reconnecting or disconnected
    if (prev === 'connected' && (connectionStatus === 'reconnecting' || connectionStatus === 'disconnected')) {
      setToast({
        id: `toast-${Date.now()}`,
        type: 'warning',
        title: 'Connection Lost',
        message: 'Network connection interrupted. Automatically attempting to reconnect…',
        canRetry: connectionStatus === 'disconnected',
      });
    }

    // 2. Connection restored: transitioned from reconnecting/disconnected to connected
    if ((prev === 'reconnecting' || prev === 'disconnected' || prev === 'error') && connectionStatus === 'connected') {
      setToast({
        id: `toast-${Date.now()}`,
        type: 'success',
        title: 'Connection Restored',
        message: 'Reconnected to office server. Session and room state synchronized.',
        canRetry: false,
      });

      // Auto dismiss success toast after 4 seconds
      autoDismissTimerRef.current = setTimeout(() => {
        setToast((current) => (current?.type === 'success' ? null : current));
      }, 4000);
    }
  }, [connectionStatus]);

  // Handle connection error notification
  useEffect(() => {
    if (connectionError && (connectionStatus === 'error' || connectionStatus === 'disconnected')) {
      setToast({
        id: `toast-err-${Date.now()}`,
        type: 'error',
        title: 'Connection Issue',
        message: connectionError,
        canRetry: true,
      });
    }
  }, [connectionError, connectionStatus]);

  // Handle wasReconnected flag if fired directly
  useEffect(() => {
    if (wasReconnected && (!toast || toast.type !== 'success')) {
      setToast({
        id: `toast-reconnect-${Date.now()}`,
        type: 'success',
        title: 'Session Restored',
        message: 'You have reconnected to the virtual office.',
        canRetry: false,
      });
      if (autoDismissTimerRef.current) clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = setTimeout(() => {
        setToast((current) => (current?.type === 'success' ? null : current));
      }, 4000);
    }
  }, [wasReconnected, toast]);

  // Handle recovery notice (e.g. private room closed during disconnection)
  useEffect(() => {
    if (recoveryNotice) {
      setToast({
        id: `toast-recovery-${Date.now()}`,
        type: 'info',
        title: 'Room Update',
        message: recoveryNotice,
        canRetry: false,
        isRecovery: true,
      });
    }
  }, [recoveryNotice]);

  const dismissToast = () => {
    if (toast?.isRecovery && typeof onClearRecoveryNotice === 'function') {
      onClearRecoveryNotice();
    }
    setToast(null);
  };

  if (!toast) return null;

  return (
    <div
      className={`connection-toast-wrap animate-slide-in ${toast.type}`}
      role="alert"
      aria-live="assertive"
    >
      <div className="connection-toast-icon">
        {toast.type === 'warning' && <WifiOffIcon size={18} />}
        {toast.type === 'success' && <CheckIcon size={18} />}
        {toast.type === 'info'    && <AlertCircleIcon size={18} />}
        {toast.type === 'error'   && <AlertCircleIcon size={18} />}
      </div>

      <div className="connection-toast-content">
        <div className="connection-toast-title">{toast.title}</div>
        <div className="connection-toast-message">{toast.message}</div>
      </div>

      <div className="connection-toast-actions">
        {toast.canRetry && typeof onReconnect === 'function' && (
          <button
            type="button"
            className="btn-toast-retry"
            onClick={() => {
              onReconnect();
              dismissToast();
            }}
          >
            <RefreshCwIcon size={12} />
            <span>Retry</span>
          </button>
        )}
        <button
          type="button"
          className="btn-toast-close"
          onClick={dismissToast}
          aria-label="Dismiss notification"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
