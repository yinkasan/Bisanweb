import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, clearToken, getToken } from '../api/client.js';

const AuthContext = createContext(null);

/**
 * Holds the signed-in user's full access context (role, page permissions,
 * depot assignments) and exposes can() for UI gating. The server re-checks
 * every call — this only drives what the UI shows.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Idle sign-out window in minutes, delivered by the server (login + /auth/me)
  // and set by the Super Admin on System Settings. Null until a session answers.
  const [idleMinutes, setIdleMinutes] = useState(null);

  const refresh = useCallback(async () => {
    // Without a stored bearer token there is nothing to validate — skip the
    // round trip and land on the sign-in screen.
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const data = await api.get('/auth/me');
      setUser(data.user);
      setIdleMinutes(data.policy?.sessionIdleMinutes ?? null);
      return data.user;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        // Network hiccup — treat as signed out rather than crashing.
        console.error('Failed to load session', err);
      }
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (username, password) => {
    // client.js persists `data.token` (localStorage) from this response; every
    // later call is signed with it as Authorization: Bearer.
    const data = await api.post('/auth/login', { username, password });
    setUser(data.user);
    setIdleMinutes(data.policy?.sessionIdleMinutes ?? null);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* best effort */ }
    clearToken();
    setUser(null);
  }, []);

  /** can('cash_sales', 'input') — Super Admin always true (server mirrors this). */
  const can = useCallback(
    (pageKey, action = 'view') => {
      if (!user) return false;
      if (user.isSuperAdmin) return true;
      return Boolean(user.permissions?.[pageKey]?.[action]);
    },
    [user]
  );

  /**
   * comp('dashboard_depot', 'card_total_sales') — component-level access the
   * Super Admin sets per role on the Roles page. Absent overrides default to
   * visible + input allowed; Super Admin sees and inputs everything.
   */
  const comp = useCallback(
    (pageKey, componentKey) => {
      if (!user) return { visible: false, input: false };
      if (user.isSuperAdmin) return { visible: true, input: true };
      const c = user.components?.[pageKey]?.[componentKey];
      if (!c) return { visible: true, input: true };
      return { visible: c.visible, input: c.input && c.visible };
    },
    [user]
  );

  const value = useMemo(
    () => ({ user, loading, idleMinutes, login, logout, refresh, can, comp }),
    [user, loading, idleMinutes, login, logout, refresh, can, comp]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
