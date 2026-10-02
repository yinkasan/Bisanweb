import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DateRangeBar, DepotPicker } from '../components/Filters.jsx';
import {
  Alert, Badge, Button, Card, ErrorText, Field, Input, Modal, MoneyInput, PageHeader,
  Pagination, Select, Spinner, StatCard, Table, TextArea,
} from '../components/ui.jsx';
import { date, dateTime, money, monthStartISO, todayISO } from '../utils/format.js';

const emptyForm = {
  depotId: '', transactionDate: todayISO(), stockValue: '', reference: '', notes: '', reason: '',
};

/**
 * Stock Balance — record the stock value for a day per depot. Corrections keep
 * the original value in a history ledger and require a reason (SRS §6.4/§27).
 */
export default function StockPage() {
  const { user, can } = useAuth();
  const canInput = can('stock_balance', 'input');
  const canEdit = can('stock_balance', 'edit');
  const canHistory = can('stock_balance', 'view_history');

  const [filters, setFilters] = useState({
    depotId: '', from: monthStartISO(), to: todayISO(), status: 'all', search: '',
  });
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { mode: 'record'|'correct'|'reverse'|'history', item }
  const [form, setForm] = useState(emptyForm);
  const [history, setHistory] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const patch = (p) => { setFilters((f) => ({ ...f, ...p })); setPage(1); };

  useEffect(() => {
    const t = setTimeout(() => patch({ search: searchInput.trim() }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get(`/stock-value${qs({
        depotId: filters.depotId,
        from: filters.from,
        to: filters.to,
        status: filters.status,
        search: filters.search,
        page,
        pageSize: 50,
      })}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);

  const openRecord = () => {
    setForm({ ...emptyForm, depotId: filters.depotId || user?.depots?.[0]?.id || '' });
    setFormError(null);
    setModal({ mode: 'record' });
  };

  const openCorrect = (item) => {
    setForm({ ...emptyForm, stockValue: item.stock_value, reason: '' });
    setFormError(null);
    setModal({ mode: 'correct', item });
  };

  const openReverse = (item) => {
    setForm({ ...emptyForm, reason: '' });
    setFormError(null);
    setModal({ mode: 'reverse', item });
  };

  const openHistory = async (item) => {
    setFormError(null);
    setHistory(null);
    setModal({ mode: 'history', item });
    try {
      setHistory(await api.get(`/stock-value/${item.id}/history`));
    } catch (err) {
      setFormError(err);
    }
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (modal.mode === 'record') {
        await api.post('/stock-value', {
          depotId: Number(form.depotId),
          transactionDate: form.transactionDate,
          stockValue: Number(form.stockValue),
          reference: form.reference,
          notes: form.notes,
        });
      } else if (modal.mode === 'correct') {
        await api.put(`/stock-value/${modal.item.id}`, {
          stockValue: Number(form.stockValue),
          reason: form.reason,
        });
      } else if (modal.mode === 'reverse') {
        await api.post(`/stock-value/${modal.item.id}/reverse`, { reason: form.reason });
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  const rows = data?.items ?? [];
  const canSave = modal?.mode === 'record'
    ? Boolean(form.depotId && form.transactionDate && form.stockValue !== '')
    : modal?.mode === 'correct'
      ? Boolean(form.stockValue !== '' && (form.reason ?? '').trim().length >= 3)
      : (form.reason ?? '').trim().length >= 3;

  return (
    <>
      <PageHeader
        title="Stock Balance"
        subtitle="Day-by-day stock valuation per depot. Corrections keep the original value in history."
        actions={canInput ? <Button variant="primary" onClick={openRecord}>+ Record Stock Value</Button> : null}
      />

      <DateRangeBar
        from={filters.from}
        to={filters.to}
        onFrom={(v) => patch({ from: v })}
        onTo={(v) => patch({ to: v })}
        extra={<DepotPicker value={filters.depotId} onChange={(v) => patch({ depotId: v })} />}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Search">
          <Input
            placeholder="Reference, notes, who entered…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </Field>
        <Field label="Status">
          <Select
            value={filters.status}
            onChange={(e) => patch({ status: e.target.value })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'posted', label: 'Posted only' },
              { value: 'reversed', label: 'Reversed only' },
            ]}
          />
        </Field>
      </div>

      <ErrorText error={error} />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard label="Records in view" value={String(data?.total ?? 0)} hint="Stock value entries matching the filters" />
        <StatCard
          label="Highest recorded value (posted)"
          value={data?.latestValue == null ? '—' : money(data.latestValue)}
          hint="Out of the records currently in view"
          tone="emerald"
        />
      </div>

      <Card>
        {loading && !data ? <Spinner /> : (
          <>
            <Table
              columns={[
                { key: 'transaction_date', label: 'Date', render: (r) => date(r.transaction_date) },
                { key: 'depot_code', label: 'Depot' },
                { key: 'stock_value', label: 'Stock Value', align: 'right', render: (r) => <strong>{money(r.stock_value)}</strong> },
                { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
                { key: 'entered_by_name', label: 'Entered By' },
                {
                  key: 'entry',
                  label: 'Entry Stamp',
                  render: (r) => `${date(r.entry_date)}${r.entry_time ? ` ${String(r.entry_time).slice(0, 5)}` : ''}`,
                },
                {
                  key: 'correction_count',
                  label: 'Corrections',
                  align: 'right',
                  render: (r) => (r.correction_count > 0
                    ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">{r.correction_count}</span>
                    : <span className="text-slate-300">0</span>),
                },
                {
                  key: 'actions',
                  label: '',
                  render: (r) => (
                    <span className="flex justify-end gap-1">
                      {canHistory ? <Button size="sm" onClick={() => openHistory(r)}>History</Button> : null}
                      {canEdit && r.status === 'posted' ? (
                        <>
                          <Button size="sm" onClick={() => openCorrect(r)}>Correct</Button>
                          <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => openReverse(r)}>Reverse</Button>
                        </>
                      ) : null}
                    </span>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(r) => r.id}
              empty="No stock values recorded for this period"
            />
            {data ? <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /> : null}
          </>
        )}
      </Card>

      {/* Record a new daily stock value */}
      <Modal
        open={modal?.mode === 'record'}
        title="Record Stock Value"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving || !canSave}>
              {saving ? 'Saving…' : 'Record Value'}
            </Button>
          </>
        }
      >
        {formError ? <Alert kind="error">{formError.message}</Alert> : null}
        <div className="space-y-3">
          <Alert kind="info">
            One stock value per depot per day. If a value already exists for the date, open it and use “Correct”.
          </Alert>
          <Field label="Depot" required>
            <Select
              value={form.depotId}
              onChange={(e) => setForm((f) => ({ ...f, depotId: e.target.value }))}
              options={(user?.depots ?? []).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Transaction date" required>
              <Input
                type="date"
                value={form.transactionDate}
                onChange={(e) => setForm((f) => ({ ...f, transactionDate: e.target.value }))}
              />
            </Field>
            <Field label="Stock value (₦)" required>
              <MoneyInput
                value={form.stockValue}
                onChange={(e) => setForm((f) => ({ ...f, stockValue: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Reference">
            <Input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} maxLength={120} />
          </Field>
          <Field label="Notes">
            <TextArea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} maxLength={2000} />
          </Field>
        </div>
      </Modal>

      {/* Correct a stock value — original stays in history */}
      <Modal
        open={modal?.mode === 'correct'}
        title={`Correct stock value — ${date(modal?.item?.transaction_date)}`}
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving || !canSave}>
              {saving ? 'Saving…' : 'Save Correction'}
            </Button>
          </>
        }
      >
        {formError ? <Alert kind="error">{formError.message}</Alert> : null}
        <div className="space-y-3">
          <Alert kind="warning">
            The current value of {money(modal?.item?.stock_value)} stays in the history ledger (original → new), together
            with your reason and stamp.
          </Alert>
          <Field label="New stock value (₦)" required>
            <MoneyInput
              value={form.stockValue}
              onChange={(e) => setForm((f) => ({ ...f, stockValue: e.target.value }))}
            />
          </Field>
          <Field label="Reason for correction" required hint="Minimum 3 characters — recorded in the adjustment log (SRS §27).">
            <TextArea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} maxLength={500} />
          </Field>
        </div>
      </Modal>

      {/* Reverse a stock value */}
      <Modal
        open={modal?.mode === 'reverse'}
        title={`Reverse stock value — ${date(modal?.item?.transaction_date)}`}
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)} disabled={saving}>Cancel</Button>
            <Button variant="danger" onClick={save} disabled={saving || !canSave}>
              {saving ? 'Reversing…' : 'Reverse Record'}
            </Button>
          </>
        }
      >
        {formError ? <Alert kind="error">{formError.message}</Alert> : null}
        <div className="space-y-3">
          <Alert kind="error">
            Reversing {money(modal?.item?.stock_value)} of {date(modal?.item?.transaction_date)} removes it from all
            balances. The row stays visible marked “reversed” with your reason (SRS §6.4).
          </Alert>
          <Field label="Reason for reversal" required>
            <TextArea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} maxLength={500} />
          </Field>
        </div>
      </Modal>

      {/* Correction history */}
      <Modal
        open={modal?.mode === 'history'}
        title={`Correction history — ${date(modal?.item?.transaction_date)}`}
        onClose={() => setModal(null)}
        wide
      >
        {formError ? <Alert kind="error">{formError.message}</Alert> : null}
        {!history ? <Spinner /> : (
          <Table
            columns={[
              {
                key: 'action',
                label: 'Action',
                render: (r) => (
                  <Badge
                    value={r.action === 'correction' ? 'Correction' : 'Creation'}
                    tone={r.action === 'correction' ? 'amber' : 'emerald'}
                  />
                ),
              },
              { key: 'original_value', label: 'Original', align: 'right', render: (r) => (r.original_value === null ? '—' : money(r.original_value)) },
              { key: 'new_value', label: 'New Value', align: 'right', render: (r) => <strong>{money(r.new_value)}</strong> },
              { key: 'reason', label: 'Reason', render: (r) => r.reason || '—' },
              { key: 'changed_by_name', label: 'Changed By' },
              { key: 'changed_at', label: 'When', render: (r) => dateTime(r.changed_at) },
            ]}
            rows={history?.history ?? []}
            rowKey={(r) => r.id}
            empty="No history recorded"
          />
        )}
      </Modal>
    </>
  );
}
