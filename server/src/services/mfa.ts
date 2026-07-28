import { deleteSetting, getSetting, setSetting } from '../db/settings';
import { config } from '../config';
import { authRequired } from './auth';
import { matchTotpStep } from './totp';

// ---------------------------------------------------------------------------
// Two-factor (TOTP) state, toggled from the app and persisted in the settings
// table. `mfa` holds the active config; `mfaPending` holds a secret mid-setup
// (before the user has proven they can generate a code). Enforcement also
// requires a base password (APP_PASSWORD) and honors the DISABLE_MFA recovery
// switch — set that env if you lose your authenticator, then re-enroll.
// ---------------------------------------------------------------------------

interface MfaState {
  enabled: boolean;
  secret: string;
}

const MFA_KEY = 'mfa';
const PENDING_KEY = 'mfaPending';
const LAST_STEP_KEY = 'mfaLastAcceptedStep';

export function getMfa(): MfaState {
  return getSetting<MfaState>(MFA_KEY) ?? { enabled: false, secret: '' };
}

/** Has the user finished enrolling a second factor? */
export function mfaEnabled(): boolean {
  const m = getMfa();
  return m.enabled && !!m.secret;
}

/** Should login actually require a code right now? */
export function mfaEnforced(): boolean {
  return authRequired() && mfaEnabled() && !config.auth.mfaDisabled;
}

export function setPendingSecret(secret: string): void {
  setSetting(PENDING_KEY, { secret });
}

export function getPendingSecret(): string | undefined {
  return getSetting<{ secret: string }>(PENDING_KEY)?.secret;
}

export function enableMfa(secret: string): void {
  setSetting(MFA_KEY, { enabled: true, secret });
  deleteSetting(PENDING_KEY);
  // A fresh secret starts a fresh one-time-use history.
  deleteSetting(LAST_STEP_KEY);
}

export function disableMfa(): void {
  setSetting(MFA_KEY, { enabled: false, secret: '' });
  deleteSetting(PENDING_KEY);
  deleteSetting(LAST_STEP_KEY);
}

/**
 * Verify a code against the ACTIVE secret AND consume its time-step, enforcing
 * one-time use (RFC 6238 §5.2: a verifier must not accept a code it has
 * already accepted). Without this, anyone who observes a valid code — over a
 * shoulder, in a log, via phishing — can reuse it for the rest of its ±1-step
 * window (~90s). The last accepted step only ever moves forward, so a replay
 * (same step, or an older skew-window step than one already used) fails while
 * every future code keeps working. The visible cost is honest: two protected
 * actions inside one 30s step need two codes — i.e. a short wait — which is
 * how authenticator-backed logins behave everywhere.
 */
export function consumeTotp(code: string, time = Date.now()): boolean {
  const step = matchTotpStep(getMfa().secret, code, time);
  if (step === undefined) return false;
  const last = getSetting<{ step: number }>(LAST_STEP_KEY)?.step ?? -1;
  if (step <= last) return false;
  setSetting(LAST_STEP_KEY, { step });
  return true;
}
