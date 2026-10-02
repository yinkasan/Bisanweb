import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from './ui.jsx';

/**
 * Route guard: requires a session, and (optionally) a page permission.
 * The server enforces the same rules — this keeps the UI honest.
 */
export default function Protected({ pageKey, action = 'view', children }) {
  const { user, loading, can } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="grid h-full place-items-center"><Spinner label="Checking your access…" /></div>;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (pageKey && !can(pageKey, action)) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
        <div className="text-3xl">🔒</div>
        <h2 className="mt-2 text-lg font-bold text-amber-900">Access not granted</h2>
        <p className="mt-1 text-sm text-amber-800">
          Your account does not have permission to open this page.
          Ask the Super Admin to grant you access on the Roles &amp; Permissions page.
        </p>
      </div>
    );
  }
  return children;
}
