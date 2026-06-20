import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { AUTH_REQUIRED_EVENT, ApiError, client } from '../api/client';
import { Spinner } from './ui';

// ---------------------------------------------------------------------------
// App lock. When the server has APP_PASSWORD set, everything behind /api needs a
// session; this gate shows a login screen until the user has one, and never
// mounts the data providers (which call protected endpoints) until then. When
// auth is disabled server-side it's a transparent pass-through.
// ---------------------------------------------------------------------------

interface AuthCtx {
  /** Whether the app is password-protected. */
  required: boolean;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>({ required: false, logout: async () => {} });
export const useAuth = () => useContext(Ctx);

type State = 'loading' | 'authed' | 'login';

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('loading');
  const [required, setRequired] = useState(false);

  const check = useCallback(async () => {
    try {
      const s = await client.authStatus();
      setRequired(s.required);
      setState(!s.required || s.authenticated ? 'authed' : 'login');
    } catch {
      // Status is an open endpoint; if it can't be reached, fail open — protected
      // calls will still 401 and bounce back to the login screen via the event.
      setState('authed');
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // A protected request 401'd (session expired / never logged in) → show login.
  useEffect(() => {
    const onExpired = () => setState((s) => (s === 'authed' ? 'login' : s));
    window.addEventListener(AUTH_REQUIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onExpired);
  }, []);

  const logout = useCallback(async () => {
    try {
      await client.logout();
    } finally {
      setState('login');
    }
  }, []);

  if (state === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center bg-ink-900">
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (state === 'login') {
    return <LoginScreen onAuthed={() => setState('authed')} />;
  }
  return <Ctx.Provider value={{ required, logout }}>{children}</Ctx.Provider>;
}

function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.login(password);
      onAuthed();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Incorrect password' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center bg-ink-900 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6 space-y-4 shadow-pop">
        <div className="flex items-center gap-2 text-slate-100">
          <Lock className="h-5 w-5 text-accent" />
          <h1 className="text-lg font-semibold">Sign in</h1>
        </div>
        <p className="text-sm text-slate-400">This app is password-protected. Enter your password to continue.</p>
        <div>
          <label className="label" htmlFor="app-password">
            Password
          </label>
          <input
            id="app-password"
            type="password"
            className="input"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <div className="text-bear text-sm">{error}</div>}
        <button type="submit" className="btn-primary w-full" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
