import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Button, Field, Input } from '../components/ui.jsx';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const idleNotice = Boolean(location.state?.idle);

  if (!loading && user) {
    return <Navigate to={location.state?.from?.pathname ?? '/'} replace />;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(location.state?.from?.pathname ?? '/', { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-slate-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-indigo-600 text-2xl font-bold text-white">B</span>
          <h1 className="mt-3 text-xl font-bold text-white">Bisan Ventures</h1>
          <p className="mt-1 text-sm text-slate-400">Multi-Depot Financial &amp; Operations System</p>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl bg-white p-6 shadow-xl">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Sign in to your account</h2>
          {idleNotice && !error ? (
            <Alert kind="info">You were signed out due to inactivity. Please sign in again.</Alert>
          ) : null}
          <Alert kind="error" onClose={() => setError(null)}>{error}</Alert>

          <div className="space-y-3">
            <Field label="Username" required>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                placeholder="e.g. admin"
                required
              />
            </Field>
            <Field label="Password" required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
                required
              />
            </Field>
          </div>

          <Button type="submit" variant="primary" className="mt-5 w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400">
            Every entry you make is stamped with your user, date and time — the server records it automatically.
          </p>
        </form>
      </div>
    </div>
  );
}
