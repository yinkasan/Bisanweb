import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Idle sign-out watchdog for the web app.
 *
 * The Super Admin sets the window on System Settings (`session_idle_minutes`);
 * the server delivers it on login and every `/auth/me` refresh, so all signed-in
 * users share the same rule. Any real interaction (mouse, keyboard, scroll,
 * touch) resets the clock. Once the window is nearly up we warn with a
 * countdown; if it elapses with no activity the session is dropped and the user
 * is returned to the login page.
 */
const WARNING_SECONDS = 30;   // how long the "still there?" modal stays up
const TICK_MS = 1000;         // watchdog resolution

// Events that count as activity. Kept to deliberate interactions so a moving
// cursor or a page auto-scroll can't keep a unattended session alive forever.
const ACTIVITY_EVENTS = ['mousedown', 'click', 'keydown', 'wheel', 'scroll', 'touchstart'];

export default function IdleGuard() {
  const { user, idleMinutes, logout } = useAuth();
  const navigate = useNavigate();

  const lastActivity = useRef(Date.now());
  const [secondsLeft, setSecondsLeft] = useState(null); // non-null ⇒ warning visible

  const active = Boolean(user) && Number.isInteger(idleMinutes) && idleMinutes > 0;
  const idleMs = (idleMinutes ?? 0) * 60_000;
  const warnMs = Math.min(WARNING_SECONDS * 1000, idleMs / 2);

  // Reset the clock whenever the user interacts.
  useEffect(() => {
    if (!active) return undefined;
    lastActivity.current = Date.now();
    setSecondsLeft(null);
    const onTouch = () => { lastActivity.current = Date.now(); };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onTouch, { passive: true }));
    // Returning to the tab should not instantly expire a session that only
    // lapsed while backgrounded — treat regaining focus as activity.
    const onVisible = () => { if (document.visibilityState === 'visible') onTouch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onTouch));
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active]);

  // The watchdog: evaluate the idle gap once per second while signed in.
  useEffect(() => {
    if (!active) return undefined;
    let timer;
    const check = async () => {
      const idle = Date.now() - lastActivity.current;
      const remaining = idleMs - idle;
      if (remaining <= 0) {
        clearInterval(timer);
        setSecondsLeft(null);
        await logout();
        navigate('/login', { replace: true, state: { idle: true } });
        return;
      }
      setSecondsLeft(remaining <= warnMs ? Math.ceil(remaining / 1000) : null);
    };
    check();
    timer = setInterval(check, TICK_MS);
    return () => clearInterval(timer);
  }, [active, idleMs, warnMs, logout, navigate]);

  const staySignedIn = () => {
    lastActivity.current = Date.now();
    setSecondsLeft(null);
  };

  if (secondsLeft === null) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 text-center shadow-xl">
        <div className="text-3xl">⏳</div>
        <h2 className="mt-2 text-base font-bold text-slate-800">Are you still there?</h2>
        <p className="mt-1 text-sm text-slate-500">
          For your security you’ll be signed out automatically due to inactivity.
        </p>
        <div className="mt-4 text-4xl font-bold tabular-nums text-indigo-600">{secondsLeft}s</div>
        <button
          type="button"
          onClick={staySignedIn}
          className="mt-5 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          Stay signed in
        </button>
      </div>
    </div>
  );
}
