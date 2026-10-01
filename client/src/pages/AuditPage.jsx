import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../api/client.js';
import {
  Alert, Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader,
  Pagination, Select, Spinner, Table,
} from '../components/ui.jsx';
import { date, dateTime, daysAgoISO, money, todayISO } from '../utils/format.js';

const TABS = [
  { key: 'activity', label: 'Activity Log' },
  { key: 'adjustments', label: 'Field Changes' },
  { key: 'reversals', label: 'Reversals' },
];

const ACTION_TONES = {
  CREATE: 'emerald',
  UPDATE: 'indigo',
  DELETE: 'rose',
  REVERSAL: 'rose',
  CORRECTION: 'amber',
  ROLE_CHANGE: 'amber',
  PERMISSION_CHANGE: 'amber',
  DEPOT_ASSIGNMENT: 'amber',
  PASSWORD_RESET: 'amber',
  REPORT_EXPORT: 'indigo',
};

const PAGE_SIZE = 50;

/**
 * Audit Trail — who did what, when, with the previous/new values (SRS §26/§27).
 * Three views: full activity log, field-level adjustments, and reversals.
 */
export default function AuditPage() {
  const [tab, setTab] = useState('activity');
  const [filters, setFilters] = useState({
    from: daysAgoISO(29), to: todayISO(), search: '', action: '', entityType: '',
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);

  useEffect(() => { setPage(1); }, [tab, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'activity') {
        setData(await api.get(`/audit-logs${qs({
          from: filters.from, to: filters.to, search: filters.search,
          action: filters.action, entityType: filters.entityType, page, pageSize: PAGE_SIZE,
        })}`));
      } else if (tab === 'adjustments') {
        setData(await api.get(`/audit-logs/adjustments${qs({ from: filters.from, to: filters.to, page, pageSize: PAGE_SIZE })}`));
      } else {
        setData(await api.get(`/audit-logs/reversals${qs({ from: filters.from, to: filters.to, page, pageSize: PAGE_SIZE })}`));
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [tab, filters, page]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Audit Trail"
        subtitle="Every create, update, correction, reversal, login and export — server-stamped and immutable."
      />

      <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
              tab === t.key ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <Field label="From">
          <Input type="date" value={filters.from} max={filters.to} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </Field>
        <Field label="To">
          <Input type="date" value={filters.to} min={filters.from} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </Field>
        {tab === 'activity' ? (
          <>
            <Field label="Search">
              <Input
                placeholder="Description, user, entity…"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              />
            </Field>
            <Field label="Action">
              <Select
                value={filters.action}
                onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
                options={[
                  { value: '', label: 'All actions' },
                  ...(data?.filters?.actions ?? []).map((a) => ({ value: a, label: a })),
                ]}
              />
            </Field>
            <Field label="Entity">
              <Select
                value={filters.entityType}
                onChange={(e) => setFilters((f) => ({ ...f, entityType: e.target.value }))}
                options={[
                  { value: '', label: 'All entities' },
                  ...(data?.filters?.entityTypes ?? []).map((t) => ({ value: t, label: t })),
                ]}
              />
            </Field>
          </>
        ) : null}
      </div>

      <ErrorText error={error} />

      <Card title={`${data?.total ?? 0} record${data?.total === 1 ? '' : 's'} shown newest first`}>
        {loading && !data ? <Spinner /> : tab === 'activity' ? (
          <Table
            columns={[
              { key: 'created_at', label: 'When', render: (r) => dateTime(r.created_at) },
              { key: 'user_name', label: 'User', render: (r) => `${r.user_name}${r.user_role ? ` · ${r.user_role}` : ''}` },
              { key: 'action', label: 'Action', render: (r) => <Badge value={r.action} tone={ACTION_TONES[r.action] ?? 'slate'} /> },
              {
                key: 'entity',
                label: 'Entity',
                render: (r) => (r.entity_type ? `${r.entity_type}${r.entity_id ? ` #${r.entity_id}` : ''}` : '—'),
              },
              { key: 'description', label: 'Description' },
              { key: 'ip_address', label: 'IP', render: (r) => r.ip_address || '—' },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setDetail(r)}
            empty="No audit records for this period"
          />
        ) : tab === 'adjustments' ? (
          <Table
            columns={[
              { key: 'created_at', label: 'When', render: (r) => dateTime(r.created_at) },
              { key: 'entity', label: 'Entity', render: (r) => `${r.entity_type}${r.entity_id ? ` #${r.entity_id}` : ''}` },
              { key: 'field', label: 'Field' },
              { key: 'old_value', label: 'Old Value', render: (r) => (r.old_value === null || r.old_value === '' ? '—' : String(r.old_value)) },
              { key: 'new_value', label: 'New Value', render: (r) => <strong>{r.new_value === null || r.new_value === '' ? '—' : String(r.new_value)}</strong> },
              { key: 'reason', label: 'Reason' },
              { key: 'adjusted_by_name', label: 'By' },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No field-level changes in this period"
          />
        ) : (
          <Table
            columns={[
              { key: 'created_at', label: 'When', render: (r) => dateTime(r.created_at) },
              { key: 'transaction_type', label: 'Type' },
              { key: 'transaction_id', label: 'Record', render: (r) => `#${r.transaction_id}` },
              { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
              { key: 'depot_code', label: 'Depot', render: (r) => r.depot_code || '—' },
              { key: 'reason', label: 'Reason' },
              { key: 'performed_by_name', label: 'By' },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No reversals in this period"
          />
        )}
        {data ? <Pagination page={data.page} pageSize={data.pageSize ?? PAGE_SIZE} total={data.total} onPage={setPage} /> : null}
      </Card>

      <Modal
        open={!!detail}
        title={`Audit record #${detail?.id ?? ''}`}
        onClose={() => setDetail(null)}
        wide
      >
        {detail ? (
          <div className="space-y-3 text-sm">
            <Alert kind="info">
              {detail.description}
            </Alert>
            <dl className="grid grid-cols-2 gap-3">
              {[
                ['User', `${detail.user_name}${detail.user_role ? ` (${detail.user_role})` : ''}`],
                ['Action', detail.action],
                ['Entity', `${detail.entity_type ?? '—'}${detail.entity_id ? ` #${detail.entity_id}` : ''}`],
                ['When', dateTime(detail.created_at)],
                ['IP address', detail.ip_address || '—'],
                ['User ID', String(detail.user_id ?? '—')],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">{k}</dt>
                  <dd className="text-slate-700">{v}</dd>
                </div>
              ))}
            </dl>
            {detail.previous_value ? (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Previous value</h4>
                <pre className="overflow-x-auto rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">
                  {JSON.stringify(detail.previous_value, null, 2)}
                </pre>
              </div>
            ) : null}
            {detail.new_value ? (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">New value</h4>
                <pre className="overflow-x-auto rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">
                  {JSON.stringify(detail.new_value, null, 2)}
                </pre>
              </div>
            ) : null}
            <p className="text-[11px] text-slate-400">
              Audit stamps are generated by the server — device date/time is never used (SRS §2).
            </p>
          </div>
        ) : <Spinner />}
      </Modal>
    </>
  );
}
