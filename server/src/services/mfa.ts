import { deleteSetting, getSetting, setSetting } from '../db/settings';
import { config } from '../config';
import { authRequired } from './auth';

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
}

export function disableMfa(): void {
  setSetting(MFA_KEY, { enabled: false, secret: '' });
  deleteSetting(PENDING_KEY);
}
