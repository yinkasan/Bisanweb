import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, Card, ErrorText, Field, Input, PageHeader, Select, Spinner, Table } from '../components/ui.jsx';
import { date, dateTime, money, monthStartISO, todayISO } from '../utils/format.js';

/**
 * Reports — 13 report kinds (sales, customers, suppliers, stock, expenses,
 * operating balance). CSV export requires the export permission (SRS §28/§37).
 */
export default function ReportsPage() {
  const { user, can } = useAuth();
  const canExport = can('reports', 'export');

  const [catalog, setCatalog] = useState([]);
  const [kind, setKind] = useState('');
  const [filters, setFilters] = useState({ from: monthStartISO(), to: todayISO(), depotId: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get('/reports');
        setCatalog(data.reports);
        setKind((k) => k || data.reports[0]?.kind || '');
      } catch (err) {
        setError(err);
      }
    })();
  }, []);

  const run = useCallback(async () => {
    if (!kind) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.get(`/reports/${kind}${qs(filters)}`));
    } catch (err) {
      setResult(null);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [kind, filters]);

  useEffect(() => { run(); }, [run]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const r of catalog) {
      if (!map.has(r.group)) map.set(r.group, []);
      map.get(r.group).push(r);
    }
    return [...map.entries()];
  }, [catalog]);

  const selected = catalog.find((r) => r.kind === kind);

  const exportCsv = () => {
    window.open(`/api/reports/${kind}${qs({ ...filters, format: 'csv' })}`, '_blank');
  };

  const renderCell = (col, row) => {
    const v = row[col.key];
    if (col.money) return money(v);
    if (v === null || v === undefined || v === '') return '—';
    if (col.key === 'transaction_date' || col.key === 'entry_date') return date(v);
    if (col.key === 'last_updated_at') return dateTime(v);
    return String(v);
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Filter by date range and depot. Every figure comes straight from posted transactions."
        actions={
          result && canExport ? (
            <Button variant="primary" onClick={exportCsv}>Export CSV</Button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card title="Available reports" className="lg:col-span-1">
          {groups.length === 0 ? <Spinner label="Loading catalogue…" /> : (
            <div className="space-y-4">
              {groups.map(([group, items]) => (
                <div key={group}>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group}</h3>
                  <div className="flex flex-col gap-1">
                    {items.map((r) => (
                      <button
                        key={r.kind}
                        type="button"
                        onClick={() => setKind(r.kind)}
                        className={`rounded-lg px-3 py-1.5 text-left text-sm transition ${
                          kind === r.kind
                            ? 'bg-indigo-50 font-medium text-indigo-700 ring-1 ring-indigo-200'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-4 lg:col-span-3">
          <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <Field label="From">
              <Input type="date" value={filters.from} max={filters.to} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
            </Field>
            <Field label="To">
              <Input type="date" value={filters.to} min={filters.from} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
            </Field>
            <Field label="Depot">
              <Select
                value={filters.depotId}
                onChange={(e) => setFilters((f) => ({ ...f, depotId: e.target.value }))}
                options={[
                  { value: '', label: 'All accessible depots' },
                  ...(user?.depots ?? []).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
                ]}
              />
            </Field>
            <Button onClick={run} disabled={!kind || loading}>{loading ? 'Running…' : 'Run'}</Button>
          </div>

          <ErrorText error={error} />

          <Card
            title={
              <span>
                {selected?.label ?? 'Report'}
                {result ? (
                  <span className="ml-2 font-normal text-slate-400">
                    {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
                    {result.range ? ` · period ${date(result.range.from)} – ${date(result.range.to)}` : ''}
                    {result.asOf ? ` · as of ${date(result.asOf)}` : ''}
                  </span>
                ) : null}
              </span>
            }
          >
            {loading && !result ? <Spinner /> : !result ? (
              <p className="py-8 text-center text-sm text-slate-400">Pick a report on the left to run it.</p>
            ) : (
              <Table
                columns={result.columns.map((c) => ({
                  key: c.key,
                  label: c.label,
                  align: c.money ? 'right' : undefined,
                  render: (row) => renderCell(c, row),
                }))}
                rows={result.rows}
                rowKey={(r, i) => i}
                empty="No data for this period"
              />
            )}
          </Card>

          {!canExport ? (
            <p className="text-[11px] text-slate-400">
              CSV export requires the “export” permission on the Reports page.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
