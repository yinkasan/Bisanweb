import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api, qs } from '../api/client.js';
import { DepotPicker, DateRangeBar } from '../components/Filters.jsx';
import {
  Alert, Badge, Button, Card, ErrorText, Field, Input, Modal, MoneyInput,
  PageHeader, Pagination, Select, Spinner, Table, TextArea,
} from '../components/ui.jsx';
import { money, date, dateTime, todayISO, monthStartISO, label } from '../utils/format.js';

/**
 * Generic list + entry + correction + reversal page for a financial flow.
 * Behaviour is driven entirely by the config from flowConfigs.js.
 */
export default function FlowPage({ config }) {
  const { can, comp, user } = useAuth();
  const fields = config.fields ?? {};

  const canInput = can(config.pageKey, 'input');
  const canEdit = can(config.pageKey, 'edit');
  const canHistory = can(config.pageKey, 'view_history');

  // Component-level switches (set per role on the Roles page).
  const cTable = comp(config.pageKey, 'table');
  const cNew = comp(config.pageKey, 'new_entry');
  const cEdit = comp(config.pageKey, 'edit_action');
  const cReverse = comp(config.pageKey, 'reverse_action');

  const [filters, setFilters] = useState({
    depotId: user?.depots?.[0]?.id ?? '',
    from: monthStartISO(),
    to: todayISO(),
    status: 'all',
    search: '',
    customerId: '',
    supplierId: '',
  });
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [options, setOptions] = useState({ customers: [], suppliers: [], categories: [], methods: [] });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // row being corrected
  const [detail, setDetail] = useState(null);   // row shown in detail modal
  const [reversing, setReversing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = qs({
        depotId: filters.depotId,
        from: filters.from,
        to: filters.to,
        status: filters.status,
        search: filters.search,
        customerId: fields.customer ? filters.customerId : undefined,
        supplierId: fields.supplier ? filters.supplierId : undefined,
        page,
        pageSize: 50,
      });
      const result = await api.get(`${config.endpoint}${query}`);
      setData(result);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [config.endpoint, filters, page, fields.customer, fields.supplier]);

  useEffect(() => { load(); }, [load]);

  // Option lists for the form + filters (accounts scoped to the chosen depot).
  useEffect(() => {
    let cancelled = false;
    async function loadOptions() {
      try {
        const jobs = [];
        if (fields.customer) {
          jobs.push(api.get(`/customers${qs({ depotId: filters.depotId, isActive: 'true', pageSize: 200 })}`)
            .then((r) => ({ key: 'customers', items: r.items ?? [] })));
        }
        if (fields.supplier) {
          jobs.push(api.get(`/suppliers${qs({ depotId: filters.depotId, isActive: 'true', pageSize: 200 })}`)
            .then((r) => ({ key: 'suppliers', items: r.items ?? [] })));
        }
        if (fields.category) {
          jobs.push(api.get('/meta/expense-categories').then((r) => ({ key: 'categories', items: r.categories ?? [] })));
        }
        if (fields.paymentMethod) {
          jobs.push(api.get('/meta/payment-methods').then((r) => ({ key: 'methods', items: r.methods ?? [] })));
        }
        const results = await Promise.all(jobs);
        if (cancelled) return;
        setOptions((prev) => {
          const next = { ...prev };
          for (const r of results) next[r.key] = r.items;
          return next;
        });
      } catch { /* dropdowns degrade gracefully */ }
    }
    loadOptions();
    return () => { cancelled = true; };
  }, [fields.customer, fields.supplier, fields.category, fields.paymentMethod, filters.depotId]);

  const columns = useMemo(() => {
    const cols = [
      { key: 'transaction_date', label: 'Trans. Date', render: (r) => date(r.transaction_date) },
      { key: 'reference', label: 'Reference', render: (r) => r.reference || '—' },
    ];
    if (fields.customer) {
      cols.push({
        key: 'customer_name',
        label: 'Customer',
        render: (r) => (r.customer_name ? (
          <span>
            <span className="font-medium text-slate-700">{r.customer_name}</span>
            <span className="ml-1 text-[11px] text-slate-400">{r.customer_code}</span>
          </span>
        ) : '—'),
      });
    }
    if (fields.supplier) {
      cols.push({
        key: 'supplier_name',
        label: 'Supplier',
        render: (r) => (r.supplier_name ? (
          <span>
            <span className="font-medium text-slate-700">{r.supplier_name}</span>
            <span className="ml-1 text-[11px] text-slate-400">{r.supplier_code}</span>
          </span>
        ) : '—'),
      });
    }
    if (fields.category) {
      cols.push({ key: 'category_name', label: 'Category', render: (r) => r.category_name || 'Uncategorised' });
      cols.push({ key: 'description', label: 'Description', render: (r) => r.description || '—' });
    }
    if (fields.paymentMethod) {
      cols.push({ key: 'payment_method', label: 'Method' });
    }
    if (fields.purchaseType) {
      cols.push({ key: 'purchase_type', label: 'Type', render: (r) => label(r.purchase_type) });
    }
    cols.push(
      { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
      { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
      { key: 'entered_by_name', label: 'Entered By' },
      { key: 'entry_date', label: 'Entry Date', render: (r) => date(r.entry_date) },
      { key: 'entry_time', label: 'Entry Time', render: (r) => String(r.entry_time ?? '').slice(0, 5) }
    );
    return cols;
  }, [fields]);

  const applySearch = () => { setFilters((f) => ({ ...f, search: searchDraft })); setPage(1); };

  return (
    <>
      <PageHeader
        title={config.title}
        subtitle={config.subtitle}
        actions={canInput && cNew.visible ? (
          <Button
            variant="primary"
            onClick={() => { setEditing(null); setFormOpen(true); }}
            disabled={!cNew.input}
            title={cNew.input ? undefined : 'Input is disabled for your role'}
          >
            + New Entry
          </Button>
        ) : null}
      />

      <DateRangeBar
        from={filters.from}
        to={filters.to}
        onFrom={(v) => { setFilters((f) => ({ ...f, from: v })); setPage(1); }}
        onTo={(v) => { setFilters((f) => ({ ...f, to: v })); setPage(1); }}
        quickRanges={false}
        extra={(
          <>
            <DepotPicker value={filters.depotId} onChange={(v) => { setFilters((f) => ({ ...f, depotId: v })); setPage(1); }} />
            <Field label="Status">
              <Select
                value={filters.status}
                onChange={(e) => { setFilters((f) => ({ ...f, status: e.target.value })); setPage(1); }}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'posted', label: 'Posted' },
                  { value: 'reversed', label: 'Reversed' },
                ]}
              />
            </Field>
            {fields.customer ? (
              <Field label="Customer">
                <Select
                  value={filters.customerId}
                  onChange={(e) => { setFilters((f) => ({ ...f, customerId: e.target.value })); setPage(1); }}
                >
                  <option value="">All customers</option>
                  {options.customers.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </Select>
              </Field>
            ) : null}
            {fields.supplier ? (
              <Field label="Supplier">
                <Select
                  value={filters.supplierId}
                  onChange={(e) => { setFilters((f) => ({ ...f, supplierId: e.target.value })); setPage(1); }}
                >
                  <option value="">All suppliers</option>
                  {options.suppliers.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
                </Select>
              </Field>
            ) : null}
            <Field label="Search">
              <Input
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
                placeholder="Reference, notes, person…"
              />
            </Field>
            <Button className="mb-0.5" onClick={applySearch}>Search</Button>
          </>
        )}
      />

      <ErrorText error={error} />

      {cTable.visible && (
      <Card
        title={data ? `${data.total} entr${data.total === 1 ? 'y' : 'ies'} · posted total ${money(data.postedTotal)}` : 'Loading…'}
        className="overflow-hidden"
      >
        {loading ? <Spinner /> : (
          <>
            <Table
              columns={columns}
              rows={data?.items ?? []}
              rowKey={(r) => r.id}
              onRowClick={(row) => setDetail(row)}
              empty="No transactions match the selected filters"
            />
            <Pagination page={page} pageSize={50} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
      )}

      <EntryModal
        config={config}
        open={formOpen || Boolean(editing)}
        editing={editing}
        options={options}
        defaultDepot={filters.depotId}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        onSaved={() => { setFormOpen(false); setEditing(null); load(); }}
      />

      <DetailModal
        config={config}
        row={detail}
        canEdit={canEdit && cEdit.visible && cEdit.input}
        canReverse={canEdit && cReverse.visible && cReverse.input}
        canHistory={canHistory}
        onClose={() => setDetail(null)}
        onCorrect={(row) => { setDetail(null); setEditing(row); }}
        onReverse={(row) => { setDetail(null); setReversing(row); }}
      />

      <ReverseModal
        config={config}
        row={reversing}
        onClose={() => setReversing(null)}
        onDone={() => { setReversing(null); load(); }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Entry / correction form
// ---------------------------------------------------------------------------
function EntryModal({ config, open, editing, options, defaultDepot, onClose, onSaved }) {
  const fields = config.fields ?? {};
  const isEdit = Boolean(editing);
  const depotOptions = useDepotOptions();

  const [form, setForm] = useState({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setReason('');
    if (isEdit) {
      setForm({
        depotId: editing.depot_id,
        transactionDate: String(editing.transaction_date).slice(0, 10),
        amount: editing.amount,
        reference: editing.reference ?? '',
        notes: editing.notes ?? '',
        customerId: editing.customer_id ?? '',
        supplierId: editing.supplier_id ?? '',
        categoryId: editing.category_id ?? '',
        description: editing.description ?? '',
        paymentMethod: editing.payment_method ?? '',
        purchaseType: editing.purchase_type ?? 'credit',
      });
    } else {
      setForm({
        depotId: defaultDepot || '',
        transactionDate: todayISO(),
        amount: '',
        reference: '',
        notes: '',
        customerId: '',
        supplierId: '',
        categoryId: '',
        description: '',
        paymentMethod: fields.paymentMethod ? (options.methods[0] ?? 'Cash') : undefined,
        purchaseType: fields.purchaseType ? 'credit' : undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  if (!open) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = isEdit
        ? { ...form, reason }
        : { ...form, notes: form.notes || undefined, reference: form.reference || undefined };
      if (isEdit) {
        await api.put(`${config.endpoint}/${editing.id}`, body);
      } else {
        await api.post(config.endpoint, body);
      }
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={isEdit ? `Correct ${config.title.replace(/s$/, '')} #${editing.id}` : `New ${config.title.replace(/s$/, '')}`}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save correction' : 'Record entry'}
          </Button>
        </>
      )}
    >
      <form onSubmit={submit} className="space-y-3">
        <ErrorText error={error} />

        {isEdit ? (
          <Alert kind="warning">
            The original values are kept in the audit trail. A reason is required for every correction.
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!isEdit ? (
            <Field label="Depot" required>
              <Select
                value={form.depotId ?? ''}
                onChange={(e) => set('depotId', e.target.value)}
                options={depotOptions}
                required
              />
            </Field>
          ) : null}
          <Field label="Transaction date" required>
            <Input
              type="date"
              value={form.transactionDate ?? ''}
              max={todayISO()}
              onChange={(e) => set('transactionDate', e.target.value)}
              required
            />
          </Field>
          <Field label="Amount" required>
            <MoneyInput
              value={form.amount ?? ''}
              onChange={(e) => set('amount', e.target.value)}
              placeholder="0.00"
              required
            />
          </Field>

          {fields.customer ? (
            <Field label="Customer" required>
              <Select value={form.customerId ?? ''} onChange={(e) => set('customerId', e.target.value)} required>
                <option value="" disabled>Select customer…</option>
                {options.customers.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </Select>
            </Field>
          ) : null}
          {fields.supplier ? (
            <Field label="Supplier" required>
              <Select value={form.supplierId ?? ''} onChange={(e) => set('supplierId', e.target.value)} required>
                <option value="" disabled>Select supplier…</option>
                {options.suppliers.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
              </Select>
            </Field>
          ) : null}
          {fields.category ? (
            <Field label="Expense category" required>
              <Select value={form.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value)} required>
                <option value="" disabled>Select category…</option>
                {options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          ) : null}
          {fields.paymentMethod ? (
            <Field label="Payment method" required>
              <Select
                value={form.paymentMethod ?? ''}
                onChange={(e) => set('paymentMethod', e.target.value)}
                options={(options.methods.length ? options.methods : ['Cash']).map((m) => ({ value: m, label: m }))}
              />
            </Field>
          ) : null}
          {fields.purchaseType ? (
            <Field label="Purchase type" required>
              <Select
                value={form.purchaseType ?? 'credit'}
                onChange={(e) => set('purchaseType', e.target.value)}
                options={[
                  { value: 'credit', label: 'Credit (adds to supplier debt)' },
                  { value: 'cash', label: 'Cash (paid immediately)' },
                ]}
              />
            </Field>
          ) : null}
          {fields.description ? (
            <Field label="Description" required>
              <Input value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} required />
            </Field>
          ) : null}

          <Field label="Reference">
            <Input
              value={form.reference ?? ''}
              onChange={(e) => set('reference', e.target.value)}
              placeholder={config.referencePlaceholder}
            />
          </Field>
        </div>

        <Field label="Notes">
          <TextArea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Field>

        {isEdit ? (
          <Field label="Reason for correction" required>
            <TextArea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being corrected?"
              required
            />
          </Field>
        ) : null}
      </form>
    </Modal>
  );
}

/** Small helper so the create form uses the user's assigned depots. */
function useDepotOptions() {
  const { user } = useAuth();
  return (user?.depots ?? []).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }));
}

// ---------------------------------------------------------------------------
// Detail modal — the "view history" surface (stamps, reversal info)
// ---------------------------------------------------------------------------
function DetailModal({ config, row, canEdit, canReverse, canHistory, onClose, onCorrect, onReverse }) {
  if (!row) return null;
  const fields = config.fields ?? {};

  const rows = [
    ['Transaction date', date(row.transaction_date)],
    ['Amount', money(row.amount)],
    ['Depot', `${row.depot_code} — ${row.depot_name}`],
    ['Reference', row.reference || '—'],
    fields.customer ? ['Customer', row.customer_name ? `${row.customer_code} — ${row.customer_name}` : '—'] : null,
    fields.supplier ? ['Supplier', row.supplier_name ? `${row.supplier_code} — ${row.supplier_name}` : '—'] : null,
    fields.category ? ['Category', row.category_name || 'Uncategorised'] : null,
    fields.category ? ['Description', row.description || '—'] : null,
    fields.paymentMethod ? ['Payment method', row.payment_method] : null,
    fields.purchaseType ? ['Purchase type', label(row.purchase_type)] : null,
    ['Notes', row.notes || '—'],
    ['Status', <Badge key="s" value={row.status} />],
  ];

  if (canHistory) {
    rows.push(
      ['Entered by', `${row.entered_by_name} (${row.entered_by_role ?? '—'})`],
      ['Entry date', date(row.entry_date)],
      ['Entry time', String(row.entry_time ?? '').slice(0, 5)],
      ['Recorded at', dateTime(row.created_at)]
    );
    if (row.is_reversed) {
      rows.push(
        ['Reversed by', row.reversed_by_name ?? '—'],
        ['Reversed at', dateTime(row.reversed_at)],
        ['Reversal reason', row.reversal_reason ?? '—']
      );
    }
  }

  return (
    <Modal
      open
      title={`${config.title.replace(/s$/, '')} #${row.id}`}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Close</Button>
          {row.status === 'posted' && (canEdit || canReverse) ? (
            <>
              {canEdit ? <Button onClick={() => onCorrect(row)}>Correct entry</Button> : null}
              {canReverse ? <Button variant="danger" onClick={() => onReverse(row)}>Reverse</Button> : null}
            </>
          ) : null}
        </>
      )}
    >
      <dl className="divide-y divide-slate-100">
        {rows.filter(Boolean).map(([k, v]) => (
          <div key={String(k)} className="flex items-start justify-between gap-4 py-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{k}</dt>
            <dd className="text-right text-sm text-slate-700">{v}</dd>
          </div>
        ))}
      </dl>
      {!canHistory ? (
        <p className="mt-3 text-[11px] text-slate-400">
          Entry stamps (user, date, time) are visible with the "view history" permission.
        </p>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reversal modal
// ---------------------------------------------------------------------------
function ReverseModal({ config, row, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setReason(''); setError(null); }, [row]);
  if (!row) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${config.endpoint}/${row.id}/reverse`, { reason });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Reverse entry #${row.id}`}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={submit} disabled={busy || reason.trim().length < 3}>
            {busy ? 'Reversing…' : 'Reverse transaction'}
          </Button>
        </>
      )}
    >
      <ErrorText error={error} />
      <Alert kind="warning">
        The transaction of {money(row.amount)} will be marked <strong>reversed</strong> and excluded
        from balances. The original entry is never deleted — it stays in the audit trail.
      </Alert>
      <Field label="Reason for reversal" required>
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being reversed?" />
      </Field>
    </Modal>
  );
}
