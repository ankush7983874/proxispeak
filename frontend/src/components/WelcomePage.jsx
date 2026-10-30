/**
 * WelcomePage.jsx — ProxiSpeak Premium Welcome & Guest Login Screen
 *
 * Implements Part 1 (Reference 1 Inspiration):
 *  • Royal blue backdrop with atmospheric lighting and subtle grid.
 *  • Large rounded white container with two-column layout:
 *     - Left Column: Form with ONLY Full Name and Email Address + "Enter Virtual Office →".
 *     - Right Column: Promotional blue panel with "Work Together. Feel Closer.",
 *       spatial audio highlights, and interactive office artwork.
 *  • Clear input validation: Name (2-30 chars) and Email format.
 *  • Honest live connection indicators (never claims "Connected" before joining).
 *  • Lightweight guest-identification flow (no password, OTP, or email verification).
 */
import { useState, useId } from 'react';
import {
  BuildingIcon,
  UsersIcon,
  RadioIcon,
  VolumeIcon,
  SparklesIcon,
  ArrowRightIcon,
  AlertCircleIcon,
  CheckIcon,
} from './Icons.jsx';

// RFC 5322 compliant simplified email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WelcomePage({
  onJoin,
  connected,
  connecting,
  initialProfile,
  serverError,
  clearServerError,
}) {
  const nameInputId = useId();
  const emailInputId = useId();

  const [name, setName] = useState(() => initialProfile?.name || '');
  const [email, setEmail] = useState(() => initialProfile?.email || '');
  const [validationError, setValidationError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Connection indicator text and styling
  let connectionLabel = 'Connection failed';
  let connectionDotClass = 'connection-pill-dot error';

  if (connecting) {
    connectionLabel = 'Connecting';
    connectionDotClass = 'connection-pill-dot connecting';
  } else if (connected) {
    connectionLabel = 'Ready to connect';
    connectionDotClass = 'connection-pill-dot ready';
  }

  const handleNameChange = (e) => {
    if (clearServerError) clearServerError();
    setValidationError('');
    setName(e.target.value);
  };

  const handleEmailChange = (e) => {
    if (clearServerError) clearServerError();
    setValidationError('');
    setEmail(e.target.value);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return; // Prevent duplicate join requests while in progress
    if (clearServerError) clearServerError();

    // Check if backend connection is established
    if (!connected) {
      setValidationError('Cannot connect to office server. Please verify the backend is running on port 5000.');
      return;
    }

    // 1. Sanitize & validate Full Name
    const cleanName = name.replace(/<[^>]*>?/gm, '').trim();
    if (!cleanName || cleanName.length < 2) {
      setValidationError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (cleanName.length > 30) {
      setValidationError('Full name must not exceed 30 characters.');
      return;
    }

    // 2. Validate Email Address format
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setValidationError('Please enter your email address.');
      return;
    }
    if (!EMAIL_REGEX.test(cleanEmail)) {
      setValidationError('Please enter a valid email address (e.g. name@company.com).');
      return;
    }

    setValidationError('');
    setIsSubmitting(true);

    try {
      await onJoin({
        name: cleanName,
        email: cleanEmail,
      });
    } catch (err) {
      setIsSubmitting(false);
      setValidationError(err.message || 'Failed to enter virtual office. Please check connection and try again.');
    }
  };

  const activeError = validationError || serverError;

  return (
    <div className="login-page-wrapper">
      {/* Background ambient lighting effects */}
      <div className="login-bg-glow glow-top-left" aria-hidden="true" />
      <div className="login-bg-glow glow-bottom-right" aria-hidden="true" />
      <div className="login-bg-grid" aria-hidden="true" />

      {/* Main Large White Rounded Container (Reference 1 Inspiration) */}
      <div className="login-master-card">
        {/* ── LEFT PANEL: LOGIN FORM ────────────────────────────────────────── */}
        <div className="login-form-panel">
          {/* Logo & Header */}
          <div className="login-header">
            <div className="login-brand">
              <div className="login-brand-icon">
                <RadioIcon size={22} />
              </div>
              <div className="login-brand-meta">
                <span className="login-brand-name">ProxiSpeak</span>
                <span className="login-brand-badge">Guest Portal</span>
              </div>
            </div>

            <div className="login-title-group">
              <h1 className="login-title">Welcome to ProxiSpeak</h1>
              <p className="login-subtitle">Your virtual office starts here.</p>
            </div>
          </div>

          {/* Connection Status Pill (Never claims "Connected" until inside the office) */}
          <div className="login-connection-row">
            <div className="welcome-connection-pill" role="status" aria-live="polite">
              <span className={connectionDotClass} />
              <span className="connection-pill-text">{connectionLabel}</span>
            </div>
            <span className="guest-mode-note">Guest Mode · Instant Access</span>
          </div>

          {/* Error Banner */}
          {activeError && (
            <div className="login-error-banner" role="alert">
              <AlertCircleIcon size={16} />
              <span>{activeError}</span>
            </div>
          )}

          {/* Login Form (ONLY Full Name and Email Address) */}
          <form onSubmit={handleSubmit} className="login-form" noValidate>
            {/* Field 1: Full Name */}
            <div className="login-field-group">
              <label htmlFor={nameInputId} className="login-field-label">
                Full Name <span className="label-required">*</span>
              </label>
              <div className="login-input-wrap">
                <input
                  id={nameInputId}
                  type="text"
                  className="login-input"
                  placeholder="Enter your name"
                  value={name}
                  onChange={handleNameChange}
                  maxLength={30}
                  autoComplete="name"
                  autoFocus
                  required
                />
                {name.trim().length >= 2 && (
                  <span className="input-check-icon" aria-hidden="true">
                    <CheckIcon size={15} />
                  </span>
                )}
              </div>
              <span className="login-field-hint">Your avatar will display this name across the office.</span>
            </div>

            {/* Field 2: Email Address */}
            <div className="login-field-group">
              <label htmlFor={emailInputId} className="login-field-label">
                Email Address <span className="label-required">*</span>
              </label>
              <div className="login-input-wrap">
                <input
                  id={emailInputId}
                  type="email"
                  className="login-input"
                  placeholder="Enter your email address"
                  value={email}
                  onChange={handleEmailChange}
                  maxLength={60}
                  autoComplete="email"
                  required
                />
                {EMAIL_REGEX.test(email.trim()) && (
                  <span className="input-check-icon" aria-hidden="true">
                    <CheckIcon size={15} />
                  </span>
                )}
              </div>
              <span className="login-field-hint">Used for guest identification. No password or email confirmation required.</span>
            </div>

            {/* Primary Action Button */}
            <div className="login-actions">
              <button
                type="submit"
                className="login-submit-btn"
                disabled={!name.trim() || name.trim().length < 2 || !email.trim() || isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <span className="btn-spinner" />
                    <span>Entering Virtual Office…</span>
                  </>
                ) : (
                  <>
                    <span>Enter Virtual Office</span>
                    <ArrowRightIcon size={17} />
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Privacy & Guest Session Notice */}
          <div className="login-footer-notice">
            <span className="notice-lock">🔒</span>
            <span>Unverified guest session. Name and email are stored locally to remember your preferences.</span>
          </div>
        </div>

        {/* ── RIGHT PANEL: PROMOTIONAL BLUE PANEL (REFERENCE 1) ─────────────── */}
        <div className="login-promo-panel">
          <div className="promo-inner-content">
            {/* Tagline Badge */}
            <div className="promo-badge">
              <SparklesIcon size={13} />
              <span>Virtual Office. Real Conversations.</span>
            </div>

            {/* Hero Heading & Description */}
            <h2 className="promo-headline">
              Work Together. <br />
              <span className="promo-headline-highlight">Feel Closer.</span>
            </h2>
            <p className="promo-subheadline">
              Step into an interactive 2D workplace with real-time proximity audio. Move freely, collaborate at desks, and have spontaneous hallway conversations.
            </p>

            {/* Office Visual Artwork (Animated Radar & Teammates) */}
            <div className="promo-office-card" aria-hidden="true">
              <div className="promo-radar-box">
                <div className="radar-ring radar-ring-3" />
                <div className="radar-ring radar-ring-2" />
                <div className="radar-ring radar-ring-1" />

                {/* Desk Pods */}
                <div className="preview-desk desk-left">
                  <span className="desk-label">Workstation Pod 1</span>
                </div>
                <div className="preview-desk desk-right">
                  <span className="desk-label">Glass Conference</span>
                </div>

                {/* Floating Avatars */}
                <div className="preview-avatar avatar-you">
                  <div className="avatar-pulse" />
                  <div className="avatar-circle you-circle">
                    <span>{(name.trim() || 'You').slice(0, 2).toUpperCase()}</span>
                  </div>
                  <div className="avatar-nametag you-tag">
                    <span className="tag-dot online" />
                    <span>{name.trim() || 'You'}</span>
                  </div>
                </div>

                <div className="preview-avatar avatar-peer-1">
                  <div className="avatar-circle peer-1-circle">
                    <span>AL</span>
                  </div>
                  <div className="avatar-nametag">
                    <span className="tag-dot online" />
                    <span>Alex</span>
                    <VolumeIcon size={10} className="tag-icon" />
                  </div>
                </div>

                <div className="preview-avatar avatar-peer-2">
                  <div className="avatar-circle peer-2-circle">
                    <span>SA</span>
                  </div>
                  <div className="avatar-nametag">
                    <span className="tag-dot busy" />
                    <span>Sarah</span>
                  </div>
                </div>

                <div className="preview-badge-pill">
                  <span className="badge-pulse-dot" />
                  <span>Proximity Audio Mesh · Active</span>
                </div>
              </div>
            </div>

            {/* 3 Core Value Propositions */}
            <div className="promo-features-grid">
              <div className="promo-feature-card">
                <div className="promo-feature-icon">
                  <RadioIcon size={16} />
                </div>
                <div className="promo-feature-info">
                  <strong>Real-time Spatial Audio</strong>
                  <p>Voice volume naturally attenuates with distance—just like talking across an office.</p>
                </div>
              </div>

              <div className="promo-feature-card">
                <div className="promo-feature-icon">
                  <BuildingIcon size={16} />
                </div>
                <div className="promo-feature-info">
                  <strong>Interactive Office Spaces</strong>
                  <p>Desks, conference rooms, focus booths, coffee corner, and breakout lounges.</p>
                </div>
              </div>

              <div className="promo-feature-card">
                <div className="promo-feature-icon">
                  <UsersIcon size={16} />
                </div>
                <div className="promo-feature-info">
                  <strong>Natural Team Collaboration</strong>
                  <p>Live avatar movement, private meetings, and instant in-room conversation.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WelcomePage;
