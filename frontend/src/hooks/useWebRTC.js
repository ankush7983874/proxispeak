/**
 * useWebRTC.js
 * Manages WebRTC peer connections for proximity-based spatial audio.
 *
 * ARCHITECTURE
 * ─ Each pair of users creates ONE RTCPeerConnection (the offerer is the user
 *   whose socket.id is lexicographically smaller, to avoid offer collisions).
 * ─ Socket.IO carries WebRTC signaling (offer, answer, ICE candidates).
 * ─ Audio volume is controlled via the Web Audio API GainNode (not
 *   HTMLAudioElement.volume) for reliable cross-browser behaviour.
 * ─ Connections are created only when two users are within earshot.
 * ─ Connections are closed when a user leaves or moves out of earshot.
 *
 * STUN / TURN
 * ─ Development uses Google's public STUN servers.
 * ─ Production behind restrictive NATs requires a TURN server.
 *   Add TURN URLs + credentials via environment variables — NEVER hardcode.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { volumeFromDistance, EARSHOT_RADIUS, calculateAudioObstruction } from '../utils/proximity.js';
import socket from '../services/socket.js';

// STUN / TURN configuration — loaded from Vite env or fallback to public STUN
const STUN_URLS = (import.meta.env.VITE_STUN_URLS || 'stun:stun.l.google.com:19302')
  .split(',')
  .map((u) => u.trim());

const DEFAULT_ICE_SERVERS = [{ urls: STUN_URLS }];

// Optional TURN configuration via client-side environment
if (import.meta.env.VITE_TURN_URL) {
  DEFAULT_ICE_SERVERS.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME || '',
    credential: import.meta.env.VITE_TURN_CREDENTIAL || '',
  });
}

export function useWebRTC(myId) {
  const [micState, setMicState] = useState('idle'); // idle | requesting | active | muted | denied | error
  const [audioConnections, setAudioConnections] = useState(0);
  const [webrtcError, setWebrtcError] = useState(null);

  const localStreamRef    = useRef(null);   // MediaStream from getUserMedia
  const audioContextRef   = useRef(null);   // AudioContext (created on first mic grant)
  const peersRef          = useRef({});     // { [remoteId]: { pc, gainNode, audioEl, retryCount } }
  const pendingCandidates = useRef({});     // ICE candidates buffered before remote desc is set
  const iceServersRef     = useRef(DEFAULT_ICE_SERVERS);
  const nearbyUsersRef    = useRef([]);

  // Fetch server ICE configuration dynamically if available
  useEffect(() => {
    fetch('/api/ice-servers')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.iceServers && Array.isArray(data.iceServers)) {
          iceServersRef.current = data.iceServers;
        }
      })
      .catch(() => {
        // Fall back gracefully to DEFAULT_ICE_SERVERS
      });
  }, []);

  // ── Mic control ────────────────────────────────────────────────────────────

  const requestMic = useCallback(async () => {
    if (localStreamRef.current) return; // already granted
    setMicState('requesting');
    setWebrtcError(null);

    // Verify browser media devices support and secure context (HTTPS / localhost required)
    if (!navigator?.mediaDevices?.getUserMedia) {
      setMicState('error');
      setWebrtcError(
        window.isSecureContext === false
          ? 'Microphone requires a secure context (HTTPS or http://localhost). Insecure network origins are blocked by browser security.'
          : 'Microphone API (navigator.mediaDevices.getUserMedia) is not supported in this browser.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      localStreamRef.current = stream;

      // Handle microphone device unplugged / tracks stopped externally
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          disableMic();
        };
      });

      // Create or resume audio context for gain control
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioContext();
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      setMicState('active');
      socket.emit('update-mic-status', { micEnabled: true });

      const audioTrack = stream.getAudioTracks()[0];

      // Attach audio track to all existing peer connections with nearby peers
      for (const [remoteId, peer] of Object.entries(peersRef.current)) {
        if (!peer.pc || peer.pc.signalingState === 'closed') continue;

        let needsRenegotiate = false;
        const senders = typeof peer.pc.getSenders === 'function' ? peer.pc.getSenders() : [];
        const existingAudioSender = senders.find((s) => s.track?.kind === 'audio' || s.dtmf !== undefined);

        if (existingAudioSender && typeof existingAudioSender.replaceTrack === 'function') {
          existingAudioSender.replaceTrack(audioTrack).catch(() => {});
          peer.sender = existingAudioSender;
        } else if (typeof peer.pc.addTrack === 'function') {
          peer.sender = peer.pc.addTrack(audioTrack, stream);
          needsRenegotiate = true;
        }

        if (needsRenegotiate && myId && myId < remoteId) {
          initiateOffer(remoteId);
        }
      }

      // If we already have nearby users, initiate connections
      if (myId && nearbyUsersRef.current.length > 0) {
        nearbyUsersRef.current.forEach(({ user }) => {
          if (user.id === myId || peersRef.current[user.id]) return;
          const isOfferer = myId < user.id;
          if (isOfferer) {
            initiateOffer(user.id);
          }
        });
      }
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setMicState('denied');
        setWebrtcError('Microphone permission denied. Allow microphone in your browser settings (lock icon in address bar) and click Retry.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setMicState('error');
        setWebrtcError('No microphone hardware detected on this device.');
      } else {
        setMicState('error');
        setWebrtcError(err.message || 'Unable to access microphone.');
      }
      console.warn('[WebRTC] Mic error:', err.message);
    }
  }, [myId]); // eslint-disable-line react-hooks/exhaustive-deps

  const disableMic = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setMicState('idle');
    setWebrtcError(null);
    socket.emit('update-mic-status', { micEnabled: false });

    // Silence outgoing audio on all existing peers without destroying incoming audio connections
    for (const peer of Object.values(peersRef.current)) {
      if (peer.sender && typeof peer.sender.replaceTrack === 'function') {
        peer.sender.replaceTrack(null).catch(() => {});
      }
    }
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;
    const enabled = !audioTrack.enabled;
    stream.getAudioTracks().forEach((t) => { t.enabled = enabled; });
    setMicState(enabled ? 'active' : 'muted');
    socket.emit('update-mic-status', { micEnabled: enabled });
  }, []);

  // ── Peer connection helpers ────────────────────────────────────────────────

  const createPeer = useCallback((remoteId) => {
    if (peersRef.current[remoteId]?.pc) return peersRef.current[remoteId].pc;

    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    let sender = null;

    // Add local audio tracks if available
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        sender = pc.addTrack(audioTrack, localStreamRef.current);
      }
    } else {
      // If we don't have mic permission yet, add receive-only transceiver so we can receive remote peer's audio
      try {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      } catch {
        // Fallback for older browsers
      }
    }

    // ICE candidate → signal to remote peer
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit('webrtc-ice-candidate', { target: remoteId, candidate });
      }
    };

    // Remote audio stream → create GainNode for distance-based volume
    pc.ontrack = ({ streams, track }) => {
      const remoteStream = streams[0] || new MediaStream([track]);
      if (!remoteStream) return;

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioContext();
      }
      const audioCtx = audioContextRef.current;

      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      if (peersRef.current[remoteId]?.gainNode) {
        try { peersRef.current[remoteId].gainNode.disconnect(); } catch {}
      }
      if (peersRef.current[remoteId]?.pannerNode) {
        try { peersRef.current[remoteId].pannerNode.disconnect(); } catch {}
      }

      const source   = audioCtx.createMediaStreamSource(remoteStream);
      let pannerNode = null;
      if (typeof audioCtx.createStereoPanner === 'function') {
        pannerNode = audioCtx.createStereoPanner();
        pannerNode.pan.setValueAtTime(0, audioCtx.currentTime);
      }
      const gainNode = audioCtx.createGain();

      // Set initial volume based on current distance
      const nearbyEntry = nearbyUsersRef.current.find((n) => n.user.id === remoteId);
      const initialGain = nearbyEntry ? volumeFromDistance(nearbyEntry.dist) : 0;
      gainNode.gain.setValueAtTime(initialGain, audioCtx.currentTime);

      if (pannerNode) {
        source.connect(pannerNode);
        pannerNode.connect(gainNode);
      } else {
        source.connect(gainNode);
      }
      gainNode.connect(audioCtx.destination);

      // Also attach to an audio element as fallback for autoplay compliance
      let audioEl = peersRef.current[remoteId]?.audioEl;
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.muted = true; // muted because audio is routed through Web Audio GainNode
      }
      audioEl.srcObject = remoteStream;
      audioEl.play().catch(() => {});

      peersRef.current[remoteId] = {
        ...peersRef.current[remoteId],
        pc,
        pannerNode,
        gainNode,
        audioEl,
        sender: peersRef.current[remoteId]?.sender || sender,
      };
      setAudioConnections((n) => n + 1);
    };

    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === 'failed' ||
        pc.iceConnectionState === 'closed' ||
        pc.iceConnectionState === 'disconnected'
      ) {
        const peer = peersRef.current[remoteId];
        // Retry once if disconnected and peer is still nearby
        if (pc.iceConnectionState === 'failed' && peer && (!peer.retryCount || peer.retryCount < 1)) {
          console.warn(`[WebRTC] ICE failed with ${remoteId}. Attempting restart...`);
          peer.retryCount = (peer.retryCount || 0) + 1;
          if (typeof pc.restartIce === 'function') {
            pc.restartIce();
            return;
          }
        }
        closePeer(remoteId);
      }
    };

    peersRef.current[remoteId] = { pc, pannerNode: null, gainNode: null, audioEl: null, retryCount: 0, sender };
    return pc;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closePeer = useCallback((remoteId) => {
    const peer = peersRef.current[remoteId];
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {
      // ignore already closed
    }
    if (peer.pannerNode) {
      try {
        peer.pannerNode.disconnect();
      } catch {
        // ignore already disconnected
      }
    }
    if (peer.gainNode) {
      try {
        peer.gainNode.disconnect();
      } catch {
        // ignore already disconnected
      }
    }
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
    }
    delete peersRef.current[remoteId];
    delete pendingCandidates.current[remoteId];
    setAudioConnections((n) => Math.max(0, n - 1));
  }, []);

  const cleanAllPeers = useCallback(() => {
    Object.keys(peersRef.current).forEach((rid) => {
      closePeer(rid);
    });
    setAudioConnections(0);
  }, [closePeer]);

  // ── Spatial Audio & Volume Attenuation ─────────────────────────────────────

  /**
   * Called by App.jsx whenever positions or rooms change.
   * nearbyUsers: Array<{ user: object, dist: number }>
   * me: { x: number, y: number, id: string }
   * obstacles: Array<{ x, y, w, h, soundAbsorption, ... }>
   */
  const updateVolumes = useCallback((nearbyUsers, me = null, obstacles = []) => {
    nearbyUsersRef.current = nearbyUsers;
    const nearbyIds = new Set(nearbyUsers.map((n) => n.user.id));

    // Close connections for users who moved out of earshot (>100px)
    Object.keys(peersRef.current).forEach((rid) => {
      if (!nearbyIds.has(rid)) {
        closePeer(rid);
      }
    });

    // Update spatial panning and attenuated gain for users within earshot
    nearbyUsers.forEach(({ user, dist }) => {
      const peer = peersRef.current[user.id];
      if (audioContextRef.current) {
        const currentTime = audioContextRef.current.currentTime;

        // 1. Stereo Panning (relative left/right avatar positioning)
        if (peer?.pannerNode && me && typeof user.x === 'number' && typeof me.x === 'number') {
          const dx = user.x - me.x;
          const pan = Math.max(-1, Math.min(1, dx / EARSHOT_RADIUS));
          peer.pannerNode.pan.setTargetAtTime(pan, currentTime, 0.05);
        }

        // 2. Distance-based volume falloff + physical obstacle acoustic obstruction
        if (peer?.gainNode) {
          const distanceGain = volumeFromDistance(dist, EARSHOT_RADIUS);
          let obstructionMultiplier = 1.0;
          if (me && Array.isArray(obstacles) && obstacles.length > 0) {
            const { transmission } = calculateAudioObstruction(me, user, obstacles);
            obstructionMultiplier = transmission;
          }
          const finalGain = Math.max(0, Math.min(1, distanceGain * obstructionMultiplier));
          peer.gainNode.gain.setTargetAtTime(finalGain, currentTime, 0.05);
        }
      }
    });

    // Initiate connections to newly nearby users (deterministic offerer selection)
    if (myId) {
      nearbyUsers.forEach(({ user }) => {
        if (user.id === myId || peersRef.current[user.id]) return;
        const isOfferer = myId < user.id;
        if (isOfferer) {
          initiateOffer(user.id);
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId, closePeer]);

  const initiateOffer = async (remoteId) => {
    const pc = createPeer(remoteId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { target: remoteId, offer });
    } catch (err) {
      console.warn('[WebRTC] Offer failed:', err.message);
      closePeer(remoteId);
    }
  };

  // ── Socket.IO signaling handlers ───────────────────────────────────────────

  useEffect(() => {
    const onOffer = async ({ from, offer }) => {
      const pc = createPeer(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        // Flush buffered ICE candidates
        if (pendingCandidates.current[from]) {
          for (const c of pendingCandidates.current[from]) {
            await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
          delete pendingCandidates.current[from];
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-answer', { target: from, answer });
      } catch (err) {
        console.warn('[WebRTC] Answer failed:', err.message);
        closePeer(from);
      }
    };

    const onAnswer = async ({ from, answer }) => {
      const peer = peersRef.current[from];
      if (!peer) return;
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));

        // Flush buffered ICE candidates
        if (pendingCandidates.current[from]) {
          for (const c of pendingCandidates.current[from]) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
          delete pendingCandidates.current[from];
        }
      } catch (err) {
        console.warn('[WebRTC] setRemoteDescription (answer) failed:', err.message);
      }
    };

    const onIceCandidate = async ({ from, candidate }) => {
      const peer = peersRef.current[from];
      if (peer && peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      } else {
        // Buffer until remote description is set
        if (!pendingCandidates.current[from]) pendingCandidates.current[from] = [];
        pendingCandidates.current[from].push(candidate);
      }
    };

    const onUserLeft = (id) => closePeer(id);

    socket.on('webrtc-offer',         onOffer);
    socket.on('webrtc-answer',        onAnswer);
    socket.on('webrtc-ice-candidate', onIceCandidate);
    socket.on('user-left',            onUserLeft);

    return () => {
      socket.off('webrtc-offer',         onOffer);
      socket.off('webrtc-answer',        onAnswer);
      socket.off('webrtc-ice-candidate', onIceCandidate);
      socket.off('user-left',            onUserLeft);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      Object.keys(peersRef.current).forEach(closePeer);
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    micState,
    audioConnections,
    webrtcError,
    requestMic,
    disableMic,
    toggleMute,
    updateVolumes,
    cleanAllPeers,
  };
}
