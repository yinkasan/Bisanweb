import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Button, Card, ErrorText, PageHeader, Spinner } from '../components/ui.jsx';
import { dateTime, label } from '../utils/format.js';

const SEVERITY_DOTS = {
  critical: 'bg-rose-500',
  danger: 'bg-rose-500',
  high: 'bg-rose-500',
  warning: 'bg-amber-400',
  success: 'bg-emerald-500',
  info: 'bg-slate-300',
};

/**
 * Notifications centre — threshold alerts (low cash / low operating balance)
 * and system messages (SRS §25). Unread items are highlighted.
 */
export default function NotificationsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get('/notifications'));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const markRead = async (id) => {
    setBusy(true);
    try {
      await api.post(`/notifications/${id}/read`);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const markAll = async () => {
    setBusy(true);
    try {
      await api.post('/notifications/read-all');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const notifications = data?.notifications ?? [];

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Threshold alerts and system messages. Alerts fire when cash at hand or operating balance drops below the configured limits."
        actions={
          <Button
            variant="primary"
            onClick={markAll}
            disabled={busy || !data || data.unread === 0}
          >
            Mark all as read
          </Button>
        }
      />

      <ErrorText error={error} />

      <Card
        title={
          <span>
            {data ? (
              <>
                <strong>{data.unread}</strong> unread · {notifications.length} total
              </>
            ) : 'Loading…'}
          </span>
        }
      >
        {loading && !data ? <Spinner /> : notifications.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">
            Nothing here yet. You will be alerted when a depot dips below its thresholds.
          </p>
        ) : (
          <div className="space-y-2">
            {notifications.map((n) => (
              <div
                key={n.id}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition ${
                  n.is_read ? 'border-slate-200 bg-white' : 'border-indigo-200 bg-indigo-50/40'
                }`}
              >
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${SEVERITY_DOTS[n.severity] ?? 'bg-slate-300'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm ${n.is_read ? 'font-medium text-slate-700' : 'font-semibold text-slate-900'}`}>
                      {n.title}
                    </span>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ${
                      n.severity === 'warning' ? 'bg-amber-50 text-amber-700 ring-amber-200'
                        : n.severity === 'critical' || n.severity === 'danger' ? 'bg-rose-50 text-rose-700 ring-rose-200'
                          : n.severity === 'success' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                            : 'bg-slate-50 text-slate-500 ring-slate-200'
                    }`}>
                      {n.severity}
                    </span>
                    {!n.is_read ? (
                      <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">NEW</span>
                    ) : null}
                  </div>
                  {n.message ? <p className="mt-0.5 text-sm text-slate-600">{n.message}</p> : null}
                  <p className="mt-1 text-[11px] text-slate-400">
                    {label(n.type)}
                    {n.entity_type ? ` · ${n.entity_type}${n.entity_id ? ` #${n.entity_id}` : ''}` : ''}
                    {' · '}{dateTime(n.created_at)}
                  </p>
                </div>
                {!n.is_read ? (
                  <Button size="sm" onClick={() => markRead(n.id)} disabled={busy}>Mark read</Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="mt-3 text-[11px] text-slate-400">
        Alert thresholds can be changed by an administrator on the System Settings page.
      </p>
    </>
  );
}
