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
import { volumeFromDistance } from '../utils/proximity.js';
import socket from '../services/socket.js';

// STUN configuration — loaded from Vite env or falling back to public STUN
const STUN_URLS = (import.meta.env.VITE_STUN_URLS || 'stun:stun.l.google.com:19302')
  .split(',')
  .map((u) => u.trim());

const ICE_SERVERS = [{ urls: STUN_URLS }];

export function useWebRTC(myId) {
  const [micState, setMicState] = useState('idle'); // idle | requesting | active | muted | denied | error
  const [audioConnections, setAudioConnections] = useState(0);

  const localStreamRef    = useRef(null);   // MediaStream from getUserMedia
  const audioContextRef   = useRef(null);   // AudioContext (created on first mic grant)
  const peersRef          = useRef({});     // { [remoteId]: { pc, gainNode, audioEl } }
  const pendingCandidates = useRef({});     // ICE candidates buffered before remote desc is set

  // ── Mic control ────────────────────────────────────────────────────────────

  const requestMic = useCallback(async () => {
    if (localStreamRef.current) return; // already granted
    setMicState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;

      // Create audio context for gain control
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContextRef.current = new AudioContext();

      setMicState('active');
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setMicState('denied');
      } else {
        setMicState('error');
      }
      console.warn('[WebRTC] Mic error:', err.message);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const enabled = !stream.getAudioTracks()[0]?.enabled;
    stream.getAudioTracks().forEach((t) => { t.enabled = enabled; });
    setMicState(enabled ? 'active' : 'muted');
  }, []);

  // ── Peer connection helpers ────────────────────────────────────────────────

  const createPeer = useCallback((remoteId) => {
    if (peersRef.current[remoteId]) return peersRef.current[remoteId].pc;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local audio tracks if available
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // ICE candidate → signal to remote peer
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit('webrtc-ice-candidate', { target: remoteId, candidate });
      }
    };

    // Remote audio stream → create GainNode for distance-based volume
    pc.ontrack = ({ streams }) => {
      const remoteStream = streams[0];
      if (!remoteStream) return;

      const audioCtx = audioContextRef.current;
      if (!audioCtx) return;

      const source   = audioCtx.createMediaStreamSource(remoteStream);
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0; // start silent; updated by updateVolume()
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      // Also attach to an audio element as fallback for browsers that need it
      const audioEl  = new Audio();
      audioEl.srcObject = remoteStream;
      audioEl.muted  = true; // muted because we route through Web Audio API
      audioEl.play().catch(() => {});

      peersRef.current[remoteId] = {
        ...peersRef.current[remoteId],
        gainNode,
        audioEl,
      };
      setAudioConnections((n) => n + 1);
    };

    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === 'failed' ||
        pc.iceConnectionState === 'closed' ||
        pc.iceConnectionState === 'disconnected'
      ) {
        closePeer(remoteId);
      }
    };

    peersRef.current[remoteId] = { pc, gainNode: null, audioEl: null };
    return pc;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closePeer = useCallback((remoteId) => {
    const peer = peersRef.current[remoteId];
    if (!peer) return;
    peer.pc.close();
    if (peer.gainNode) peer.gainNode.disconnect();
    if (peer.audioEl)  peer.audioEl.pause();
    delete peersRef.current[remoteId];
    delete pendingCandidates.current[remoteId];
    setAudioConnections((n) => Math.max(0, n - 1));
  }, []);

  // ── Volume attenuation ─────────────────────────────────────────────────────

  /**
   * Called by App.jsx whenever positions change.
   * nearbyUsers: Array<{ user: object, dist: number }>
   */
  const updateVolumes = useCallback((nearbyUsers, allUsers) => {
    const nearbyIds = new Set(nearbyUsers.map((n) => n.user.id));

    // Close connections for users who moved out of earshot
    Object.keys(peersRef.current).forEach((rid) => {
      if (!nearbyIds.has(rid)) closePeer(rid);
    });

    // Set gain for users in earshot
    nearbyUsers.forEach(({ user, dist }) => {
      const peer = peersRef.current[user.id];
      if (peer?.gainNode) {
        const gain = volumeFromDistance(dist);
        peer.gainNode.gain.setTargetAtTime(gain, audioContextRef.current.currentTime, 0.1);
      }
    });

    // Initiate connections to newly nearby users (if mic is active)
    if (localStreamRef.current && myId) {
      nearbyUsers.forEach(({ user }) => {
        if (user.id === myId || peersRef.current[user.id]) return;
        const isOfferer = myId < user.id; // deterministic offerer selection
        if (isOfferer) initiateOffer(user.id);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

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
    requestMic,
    toggleMute,
    updateVolumes,
  };
}
