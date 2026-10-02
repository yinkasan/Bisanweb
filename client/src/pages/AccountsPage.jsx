import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DepotPicker } from '../components/Filters.jsx';
import {
  Alert, Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader,
  Pagination, Select, Spinner, Table, TextArea,
} from '../components/ui.jsx';
import { date, money, todayISO } from '../utils/format.js';

const CONFIGS = {
  customers: {
    endpoint: '/customers',
    pageKey: 'customers',
    title: 'Customers & Debtors',
    subtitle: 'Outstanding credit is calculated from credit sales minus payments — never typed in.',
    partner: 'Customer',
    balanceLabel: 'Outstanding Credit',
  },
  suppliers: {
    endpoint: '/suppliers',
    pageKey: 'suppliers',
    title: 'Suppliers & Creditors',
    subtitle: 'Outstanding debt is calculated from purchases minus payments — never typed in.',
    partner: 'Supplier',
    balanceLabel: 'Outstanding Debt',
  },
};

const emptyForm = {
  depotId: '', name: '', phone: '', address: '', reference: '', notes: '', isActive: true, reason: '',
};

/**
 * Customers/Debtors and Suppliers/Creditors register (one component, two modes).
 * Row click opens the ledger; balances shown are as of the chosen date.
 */
export default function AccountsPage({ kind }) {
  const cfg = CONFIGS[kind];
  const navigate = useNavigate();
  const { user, can, comp } = useAuth();
  const canInput = can(cfg.pageKey, 'input');
  const canEdit = can(cfg.pageKey, 'edit');
  // Component-level switches (set per role on the Roles page).
  const cTable = comp(cfg.pageKey, 'table');
  const cNew = comp(cfg.pageKey, 'new_entry');
  const cEdit = comp(cfg.pageKey, 'edit_action');
  const cDel = comp(cfg.pageKey, 'delete_action');

  const [filters, setFilters] = useState({
    depotId: '', search: '', isActive: 'all', withBalance: false, to: todayISO(),
  });
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
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
      setData(await api.get(`${cfg.endpoint}${qs({
        depotId: filters.depotId,
        search: filters.search,
        isActive: filters.isActive,
        withBalance: filters.withBalance ? 'true' : '',
        to: filters.to,
        page,
        pageSize: 50,
      })}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [cfg.endpoint, filters, page]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm({ ...emptyForm, depotId: filters.depotId || user?.depots?.[0]?.id || '' });
    setFormError(null);
    setModal({ mode: 'create' });
  };

  const openEdit = (account) => {
    setForm({
      depotId: account.depot_id,
      name: account.name ?? '',
      phone: account.phone ?? '',
      address: account.address ?? '',
      reference: account.reference ?? '',
      notes: account.notes ?? '',
      isActive: account.is_active,
      reason: '',
    });
    setFormError(null);
    setModal({ mode: 'edit', account });
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        name: form.name,
        phone: form.phone,
        address: form.address,
        reference: form.reference,
        notes: form.notes,
      };
      if (modal.mode === 'create') {
        await api.post(cfg.endpoint, { ...body, depotId: Number(form.depotId) });
      } else {
        await api.put(`${cfg.endpoint}/${modal.account.id}`, {
          ...body, isActive: form.isActive, reason: form.reason || undefined,
        });
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (account) => {
    if (!window.confirm(
      `Delete ${cfg.partner.toLowerCase()} "${account.name}"? This is only possible when the record has no transactions at all.`
    )) return;
    setError(null);
    try {
      await api.del(`${cfg.endpoint}/${account.id}`);
      await load();
    } catch (err) {
      setError(err);
    }
  };

  const rows = data?.items ?? [];

  return (
    <>
      <PageHeader
        title={cfg.title}
        subtitle={cfg.subtitle}
        actions={canInput && cNew.visible ? (
          <Button
            variant="primary"
            onClick={openCreate}
            disabled={!cNew.input}
            title={cNew.input ? undefined : 'Input is disabled for your role'}
          >
            + New {cfg.partner}
          </Button>
        ) : null}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <DepotPicker value={filters.depotId} onChange={(v) => patch({ depotId: v })} />
        <Field label="Search">
          <Input
            placeholder="Name, code, phone…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </Field>
        <Field label="Status">
          <Select
            value={filters.isActive}
            onChange={(e) => patch({ isActive: e.target.value })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'true', label: 'Active only' },
              { value: 'false', label: 'Inactive only' },
            ]}
          />
        </Field>
        <Field label="Balances as of">
          <Input type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300"
            checked={filters.withBalance}
            onChange={(e) => patch({ withBalance: e.target.checked })}
          />
          Only with a balance
        </label>
      </div>

      <ErrorText error={error} />

      {cTable.visible && (
      <Card
        title={
          <span>
            {data ? data.total : 0} {cfg.partner.toLowerCase()}{data && data.total === 1 ? '' : 's'} ·
            {' '}Total {cfg.balanceLabel.toLowerCase()}: <strong className="money">{money(data?.totalBalance)}</strong>
            {data?.asOf ? <span className="ml-1 font-normal text-slate-400">as of {date(data.asOf)}</span> : null}
          </span>
        }
      >
        {loading && !data ? <Spinner /> : (
          <>
            <Table
              columns={[
                { key: 'code', label: 'Code' },
                { key: 'name', label: cfg.partner },
                { key: 'depot_code', label: 'Depot' },
                { key: 'phone', label: 'Phone', render: (r) => r.phone || '—' },
                { key: 'balance', label: cfg.balanceLabel, align: 'right', render: (r) => money(r.balance) },
                { key: 'last_activity_date', label: 'Last Activity', render: (r) => (r.last_activity_date ? date(r.last_activity_date) : '—') },
                { key: 'is_active', label: 'Status', render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> },
                {
                  key: 'actions',
                  label: '',
                  render: (r) => (
                    <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      {canEdit && cEdit.visible ? <Button size="sm" disabled={!cEdit.input} onClick={() => openEdit(r)}>Edit</Button> : null}
                      {canEdit && cDel.visible && r.last_activity_date === null ? (
                        <Button size="sm" variant="ghost" className="text-rose-600" disabled={!cDel.input} onClick={() => remove(r)}>Delete</Button>
                      ) : null}
                    </span>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`${cfg.endpoint === '/customers' ? '/customers' : '/suppliers'}/${r.id}`)}
              empty={`No ${cfg.partner.toLowerCase()}s match these filters`}
            />
            {data ? (
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            ) : null}
          </>
        )}
      </Card>
      )}

      <Modal
        open={!!modal}
        title={modal?.mode === 'edit' ? `Edit ${cfg.partner} — ${modal?.account?.code ?? ''}` : `New ${cfg.partner}`}
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving || !form.name.trim()}>
              {saving ? 'Saving…' : modal?.mode === 'edit' ? 'Save Changes' : `Create ${cfg.partner}`}
            </Button>
          </>
        }
      >
        {formError ? <Alert kind="error">{formError.message}</Alert> : null}
        <form className="space-y-3" onSubmit={save}>
          {modal?.mode === 'create' ? (
            <Field label="Depot" required hint={user?.allDepots || user?.isSuperAdmin ? undefined : 'Only depots assigned to you appear here'}>
              <Select
                value={form.depotId}
                onChange={(e) => setForm((f) => ({ ...f, depotId: e.target.value }))}
                options={(user?.depots ?? []).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))}
              />
            </Field>
          ) : (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              Depot {modal?.account?.depot_code} — records cannot be moved between depots. Balances stay calculated from
              transactions at all times.
            </p>
          )}
          <Field label={`${cfg.partner} name`} required>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={160} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Phone">
              <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} maxLength={40} />
            </Field>
            <Field label="Reference">
              <Input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} maxLength={80} />
            </Field>
          </div>
          <Field label="Address">
            <Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} maxLength={300} />
          </Field>
          <Field label="Notes">
            <TextArea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} maxLength={2000} />
          </Field>
          {modal?.mode === 'edit' ? (
            <>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                />
                Active — inactive records stay in history but are marked clearly
              </label>
              <Field label="Reason for change" hint="Recorded in the adjustment log (SRS §27).">
                <Input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} maxLength={500} />
              </Field>
            </>
          ) : null}
        </form>
      </Modal>
    </>
  );
}
