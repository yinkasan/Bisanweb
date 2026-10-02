import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { NAV_SECTIONS } from '../nav.js';
import { api } from '../api/client.js';
import IdleGuard from './IdleGuard.jsx';

/**
 * App shell: dark sidebar (permission-filtered), top bar with notification
 * bell + user chip, and the routed page content.
 */
export default function Layout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const loadUnread = useCallback(async () => {
    if (!can('notifications', 'view')) return;
    try {
      const data = await api.get('/notifications/unread-count');
      setUnread(data.unread ?? 0);
    } catch { /* the bell is best-effort */ }
  }, [can]);

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 60000);
    return () => clearInterval(t);
  }, [loadUnread]);

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-full">
      <IdleGuard />
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 transform overflow-y-auto bg-slate-900 text-slate-300 transition-transform lg:static lg:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-600 text-lg font-bold text-white">B</span>
          <div>
            <div className="text-sm font-bold text-white">Bisan Ventures</div>
            <div className="text-[11px] text-slate-400">Multi-Depot Financials</div>
          </div>
        </div>

        <nav className="px-2 pb-6">
          {NAV_SECTIONS.map((section) => {
            const visible = section.items.filter((item) => can(item.pageKey));
            if (visible.length === 0) return null;
            return (
              <div key={section.label} className="mt-3">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {section.label}
                </div>
                {visible.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={() => setMenuOpen(false)}
                    className={({ isActive }) =>
                      `mb-0.5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition
                       ${isActive ? 'bg-indigo-600 text-white' : 'hover:bg-slate-800 hover:text-white'}`
                    }
                  >
                    <span className="w-5 text-center text-sm">{item.icon}</span>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>

      {menuOpen ? (
        <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setMenuOpen(false)} />
      ) : null}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
          <button type="button" className="rounded p-1 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setMenuOpen(true)}>
            ☰
          </button>
          <div className="flex-1" />

          {can('notifications', 'view') ? (
            <button
              type="button"
              onClick={() => navigate('/notifications')}
              className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              title="Notifications"
            >
              🔔
              {unread > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
            </button>
          ) : null}

          <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
            <div className="hidden text-right sm:block">
              <div className="text-xs font-semibold text-slate-700">{user?.fullName ?? user?.username}</div>
              <div className="text-[11px] text-slate-400">
                {user?.isSuperAdmin ? 'Super Admin' : user?.roleName}
                {user?.isSuperAdmin || user?.allDepots ? ' · All depots' : ` · ${user?.depots?.length ?? 0} depot(s)`}
              </div>
            </div>
            <span className="grid h-8 w-8 place-items-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
              {(user?.fullName ?? user?.username ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <button
              type="button"
              onClick={onLogout}
              className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-rose-600"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
