import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import {
  Alert, Badge, Button, Card, ErrorText, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, Table,
} from '../components/ui.jsx';
import { date, dateTime, money } from '../utils/format.js';

const emptyDepot = {
  code: '', name: '', location: '', phone: '',
  openingBalanceDate: '2026-01-01', openingOperatingBalance: '0', openingCashAtHand: '0',
  isActive: true,
};

/**
 * System Settings — company profile, system-wide settings (cash at bank,
 * alert thresholds) and the depots register with opening balances (SRS §18-§20).
 */
export default function SettingsPage() {
  const { can } = useAuth();
  const canEdit = can('settings', 'edit');
  const canInput = can('settings', 'input');

  const [company, setCompany] = useState(null);
  const [companyForm, setCompanyForm] = useState(null);
  const [settings, setSettings] = useState([]);
  const [settingsForm, setSettingsForm] = useState({});
  const [depots, setDepots] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingCompany, setSavingCompany] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [depotModal, setDepotModal] = useState(null);
  const [depotForm, setDepotForm] = useState(emptyDepot);
  const [savingDepot, setSavingDepot] = useState(false);
  const [depotError, setDepotError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.get('/settings');
      setCompany(s.company);
      setCompanyForm({
        name: s.company?.name ?? '',
        address: s.company?.address ?? '',
        phone: s.company?.phone ?? '',
        email: s.company?.email ?? '',
        currencySymbol: s.company?.currency_symbol ?? '₦',
      });
      setSettings(s.settings);
      setSettingsForm(Object.fromEntries(s.settings.map((x) => [x.key, String(x.value ?? '')])));
      const d = await api.get('/depots/all').catch(() => api.get('/depots'));
      setDepots(d.depots);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const changedKeys = useMemo(
    () => settings
      .filter((s) => settingsForm[s.key] !== String(s.value ?? ''))
      .map((s) => s.key),
    [settings, settingsForm]
  );

  const saveCompany = async () => {
    setSavingCompany(true);
    setMsg(null);
    try {
      await api.put('/settings/company', companyForm);
      setMsg({ kind: 'success', text: 'Company profile saved.' });
      await load();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setSavingCompany(false);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    setMsg(null);
    try {
      for (const key of changedKeys) {
        await api.put(`/settings/${key}`, { value: settingsForm[key] });
      }
      setMsg({ kind: 'success', text: `${changedKeys.length} setting${changedKeys.length === 1 ? '' : 's'} saved.` });
      await load();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setSavingSettings(false);
    }
  };

  const openCreateDepot = () => {
    setDepotForm(emptyDepot);
    setDepotError(null);
    setDepotModal({ mode: 'create' });
  };

  const openEditDepot = (d) => {
    setDepotForm({
      code: d.code,
      name: d.name ?? '',
      location: d.location ?? '',
      phone: d.phone ?? '',
      openingBalanceDate: d.opening_balance_date ?? '2026-01-01',
      openingOperatingBalance: d.opening_operating_balance ?? '0',
      openingCashAtHand: d.opening_cash_at_hand ?? '0',
      isActive: d.is_active,
    });
    setDepotError(null);
    setDepotModal({ mode: 'edit', depot: d });
  };

  const saveDepot = async () => {
    setSavingDepot(true);
    setDepotError(null);
    try {
      if (depotModal.mode === 'create') {
        await api.post('/depots', {
          code: depotForm.code,
          name: depotForm.name,
          location: depotForm.location,
          phone: depotForm.phone,
          openingBalanceDate: depotForm.openingBalanceDate,
          openingOperatingBalance: depotForm.openingOperatingBalance || 0,
          openingCashAtHand: depotForm.openingCashAtHand || 0,
        });
      } else {
        await api.put(`/depots/${depotModal.depot.id}`, {
          name: depotForm.name,
          location: depotForm.location,
          phone: depotForm.phone,
          isActive: depotForm.isActive,
          openingBalanceDate: depotForm.openingBalanceDate,
          openingOperatingBalance: depotForm.openingOperatingBalance || 0,
          openingCashAtHand: depotForm.openingCashAtHand || 0,
        });
      }
      setDepotModal(null);
      await load();
    } catch (err) {
      setDepotError(err);
    } finally {
      setSavingDepot(false);
    }
  };

  return (
    <>
      <PageHeader
        title="System Settings"
        subtitle="Company profile, alert thresholds, cash at bank and the depots register."
      />

      <ErrorText error={error} />
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}

      {loading && !company ? <Spinner /> : (
        <div className="space-y-4">
          <Card title="Company profile">
            {!companyForm ? <Spinner /> : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Company name" required>
                    <Input value={companyForm.name} disabled={!canEdit} onChange={(e) => setCompanyForm((f) => ({ ...f, name: e.target.value }))} />
                  </Field>
                  <Field label="Phone">
                    <Input value={companyForm.phone} disabled={!canEdit} onChange={(e) => setCompanyForm((f) => ({ ...f, phone: e.target.value }))} />
                  </Field>
                  <Field label="Email">
                    <Input value={companyForm.email} disabled={!canEdit} onChange={(e) => setCompanyForm((f) => ({ ...f, email: e.target.value }))} />
                  </Field>
                  <Field label="Address">
                    <Input value={companyForm.address} disabled={!canEdit} onChange={(e) => setCompanyForm((f) => ({ ...f, address: e.target.value }))} />
                  </Field>
                  <Field label="Currency symbol" hint={`Currency code: ${company?.currency_code ?? '—'} (fixed)`}>
                    <Input value={companyForm.currencySymbol} disabled={!canEdit} onChange={(e) => setCompanyForm((f) => ({ ...f, currencySymbol: e.target.value }))} maxLength={8} />
                  </Field>
                </div>
                {canEdit ? (
                  <div className="mt-3 flex justify-end">
                    <Button variant="primary" size="sm" disabled={savingCompany || !companyForm.name.trim()} onClick={saveCompany}>
                      {savingCompany ? 'Saving…' : 'Save company profile'}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>

          <Card
            title="System settings"
            actions={canEdit && changedKeys.length > 0 ? (
              <Button variant="primary" size="sm" disabled={savingSettings} onClick={saveSettings}>
                {savingSettings ? 'Saving…' : `Save ${changedKeys.length} change${changedKeys.length === 1 ? '' : 's'}`}
              </Button>
            ) : null}
          >
            {settings.length === 0 ? <Spinner /> : (
              <div>
                {settings.map((s) => (
                  <div key={s.key} className="grid grid-cols-1 items-end gap-3 border-b border-slate-100 py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_260px]">
                    <div>
                      <div className="text-sm font-medium text-slate-700">{s.label ?? s.key}</div>
                      <div className="text-[11px] text-slate-400">
                        {s.key} · updated {dateTime(s.updated_at)}{s.updated_by_name ? ` by ${s.updated_by_name}` : ''}
                      </div>
                      {s.type === 'minutes' ? (
                        <div className="text-[11px] text-slate-400">Whole minutes (1–240). Applies to all signed-in users on their next activity check.</div>
                      ) : null}
                    </div>
                    <div>
                      {s.type === 'boolean' ? (
                        <Select
                          value={settingsForm[s.key] ?? 'false'}
                          disabled={!canEdit}
                          onChange={(e) => setSettingsForm((f) => ({ ...f, [s.key]: e.target.value }))}
                          options={[{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }]}
                        />
                      ) : s.type === 'number' ? (
                        <MoneyInput
                          value={settingsForm[s.key] ?? ''}
                          disabled={!canEdit}
                          onChange={(e) => setSettingsForm((f) => ({ ...f, [s.key]: e.target.value }))}
                        />
                      ) : s.type === 'minutes' ? (
                        <Input
                          type="number"
                          min={1}
                          max={240}
                          step={1}
                          value={settingsForm[s.key] ?? ''}
                          disabled={!canEdit}
                          onChange={(e) => setSettingsForm((f) => ({ ...f, [s.key]: e.target.value }))}
                        />
                      ) : (
                        <Input
                          value={settingsForm[s.key] ?? ''}
                          disabled={!canEdit}
                          onChange={(e) => setSettingsForm((f) => ({ ...f, [s.key]: e.target.value }))}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-slate-400">
              Cash at Bank feeds the “Total Cash” formula; the thresholds trigger notifications when a depot dips below them.
              The inactivity window signs every user out automatically after that many minutes with no activity.
            </p>
          </Card>

          <Card
            title="Depots & opening balances (SRS §19)"
            actions={canInput ? <Button variant="primary" size="sm" onClick={openCreateDepot}>+ New Depot</Button> : null}
          >
            <Table
              columns={[
                { key: 'code', label: 'Code' },
                { key: 'name', label: 'Name' },
                { key: 'location', label: 'Location', render: (r) => r.location || '—' },
                { key: 'phone', label: 'Phone', render: (r) => r.phone || '—' },
                { key: 'opening_balance_date', label: 'Opening Date', render: (r) => date(r.opening_balance_date) },
                { key: 'opening_operating_balance', label: 'Opening OB', align: 'right', render: (r) => money(r.opening_operating_balance) },
                { key: 'opening_cash_at_hand', label: 'Opening Cash', align: 'right', render: (r) => money(r.opening_cash_at_hand) },
                { key: 'is_active', label: 'Status', render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> },
                {
                  key: 'actions',
                  label: '',
                  render: (r) => (
                    <span className="flex justify-end">
                      {canEdit ? <Button size="sm" onClick={() => openEditDepot(r)}>Edit</Button> : null}
                    </span>
                  ),
                },
              ]}
              rows={depots}
              rowKey={(r) => r.id}
              empty="No depots yet — create one to start recording transactions"
            />
            <p className="mt-2 text-[11px] text-slate-400">
              Opening balances are the starting point of the operating-balance chain. Changing them affects reports
              from the opening date onward — the change is written to the adjustment log.
            </p>
          </Card>
        </div>
      )}

      <Modal
        open={!!depotModal}
        title={depotModal?.mode === 'edit' ? `Edit depot — ${depotModal?.depot?.code ?? ''}` : 'New Depot'}
        onClose={() => setDepotModal(null)}
        footer={
          <>
            <Button onClick={() => setDepotModal(null)} disabled={savingDepot}>Cancel</Button>
            <Button
              variant="primary"
              onClick={saveDepot}
              disabled={savingDepot || !depotForm.name.trim() || (depotModal?.mode === 'create' && !depotForm.code.trim())}
            >
              {savingDepot ? 'Saving…' : depotModal?.mode === 'edit' ? 'Save Changes' : 'Create Depot'}
            </Button>
          </>
        }
      >
        {depotError ? <Alert kind="error">{depotError.message}</Alert> : null}
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Code" required hint={depotModal?.mode === 'edit' ? 'Codes cannot be changed' : 'Short unique code, e.g. DPD'}>
              <Input
                value={depotForm.code}
                disabled={depotModal?.mode === 'edit'}
                onChange={(e) => setDepotForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                maxLength={20}
              />
            </Field>
            <Field label="Name" required>
              <Input value={depotForm.name} onChange={(e) => setDepotForm((f) => ({ ...f, name: e.target.value }))} maxLength={120} />
            </Field>
            <Field label="Location">
              <Input value={depotForm.location} onChange={(e) => setDepotForm((f) => ({ ...f, location: e.target.value }))} maxLength={200} />
            </Field>
            <Field label="Phone">
              <Input value={depotForm.phone} onChange={(e) => setDepotForm((f) => ({ ...f, phone: e.target.value }))} maxLength={40} />
            </Field>
          </div>

          <h4 className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Opening balances</h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Opening date" required>
              <Input
                type="date"
                value={depotForm.openingBalanceDate}
                onChange={(e) => setDepotForm((f) => ({ ...f, openingBalanceDate: e.target.value }))}
              />
            </Field>
            <Field label="Opening operating balance (₦)">
              <MoneyInput
                value={depotForm.openingOperatingBalance}
                onChange={(e) => setDepotForm((f) => ({ ...f, openingOperatingBalance: e.target.value }))}
              />
            </Field>
            <Field label="Opening cash at hand (₦)">
              <MoneyInput
                value={depotForm.openingCashAtHand}
                onChange={(e) => setDepotForm((f) => ({ ...f, openingCashAtHand: e.target.value }))}
              />
            </Field>
          </div>

          {depotModal?.mode === 'edit' ? (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={depotForm.isActive}
                onChange={(e) => setDepotForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              Active — inactive depots disappear from dropdowns but keep their history
            </label>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
