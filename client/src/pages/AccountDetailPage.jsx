import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import {
  Alert, Badge, Button, Card, ErrorText, Field, Input, PageHeader, Spinner, StatCard, Table,
} from '../components/ui.jsx';
import { date, dateTime, money, label, todayISO } from '../utils/format.js';

const CONFIGS = {
  customers: {
    endpoint: '/customers',
    listPath: '/customers',
    pageKey: 'customers',
    partner: 'Customer',
    debitLabel: 'Credit sales (to date)',
    creditLabel: 'Payments received (to date)',
    balanceLabel: 'Outstanding credit',
    tone: 'amber',
    historyHint: 'credit sales and payments, in date order with a running balance',
  },
  suppliers: {
    endpoint: '/suppliers',
    listPath: '/suppliers',
    pageKey: 'suppliers',
    partner: 'Supplier',
    debitLabel: 'Purchases (to date)',
    creditLabel: 'Payments made (to date)',
    balanceLabel: 'Outstanding debt',
    tone: 'rose',
    historyHint: 'purchases and payments, in date order with a running balance',
  },
};

/** Signed amount like "+₦500,000.00" / "−₦200,000.00". */
function signedMoney(value) {
  const n = Number(value ?? 0);
  return `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
}

/**
 * Account ledger — everything about one customer/supplier: computed totals and
 * (with the view_history permission) the full transaction history (SRS §12/§13).
 */
export default function AccountDetailPage({ kind }) {
  const cfg = CONFIGS[kind];
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canHistory = can(cfg.pageKey, 'view_history');

  const [asOf, setAsOf] = useState(todayISO());
  const [detail, setDetail] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLedger(null);
    try {
      setDetail(await api.get(`${cfg.endpoint}/${id}${qs({ to: asOf })}`));
      if (canHistory) {
        setLedger(await api.get(`${cfg.endpoint}/${id}/ledger${qs({ to: asOf })}`));
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [cfg.endpoint, id, asOf, canHistory]);

  useEffect(() => { load(); }, [load]);

  const account = detail?.account;
  const totals = detail?.totals;

  return (
    <>
      <PageHeader
        title={account ? account.name : `${cfg.partner} ledger`}
        subtitle={account ? `${account.code}${account.depot_name ? ` · ${account.depot_name}` : ''}` : undefined}
        actions={<Button onClick={() => navigate(cfg.listPath)}>← All {cfg.partner.toLowerCase()}s</Button>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <Field label="Balances as of">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        {account ? <Badge value={account.is_active ? 'active' : 'inactive'} /> : null}
      </div>

      <ErrorText error={error} />

      {loading && !detail ? <Spinner /> : !detail ? null : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label={cfg.debitLabel} value={money(totals?.debit_total)} hint="Everything charged" />
            <StatCard label={cfg.creditLabel} value={money(totals?.credit_total)} hint="Everything settled" />
            <StatCard
              label={cfg.balanceLabel}
              value={money(account.balance)}
              hint={`As of ${date(detail.asOf)}`}
              tone={cfg.tone}
            />
          </div>

          <Card title="Account details">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Code', account.code],
                ['Reference', account.reference || '—'],
                ['Phone', account.phone || '—'],
                ['Address', account.address || '—'],
                ['Depot', account.depot_code ? `${account.depot_code} — ${account.depot_name}` : '—'],
                ['Status', account.is_active ? 'Active' : 'Inactive'],
                ['Created', dateTime(account.created_at)],
                ['Created by', account.created_by_name || '—'],
                ['Last updated', dateTime(account.updated_at)],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">{k}</dt>
                  <dd className="text-slate-700">{v}</dd>
                </div>
              ))}
              {account.notes ? (
                <div className="sm:col-span-2 lg:col-span-3">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-400">Notes</dt>
                  <dd className="whitespace-pre-wrap text-slate-700">{account.notes}</dd>
                </div>
              ) : null}
            </dl>
          </Card>

          <Card title={`Transaction history — ${cfg.historyHint}`}>
            {!canHistory ? (
              <Alert kind="info">
                Your role can see this account and its totals, but not the full transaction list.
                Viewing history requires the “view history” permission on the {cfg.pageKey} page.
              </Alert>
            ) : !ledger ? <Spinner /> : (
              <>
                <Table
                  columns={[
                    { key: 'transaction_date', label: 'Date', render: (r) => date(r.transaction_date) },
                    { key: 'entry_type', label: 'Type', render: (r) => label(r.entry_type) },
                    { key: 'reference', label: 'Reference', render: (r) => r.reference || '—' },
                    {
                      key: 'signed_amount',
                      label: 'Amount',
                      align: 'right',
                      render: (r) => (
                        <span className={Number(r.signed_amount) >= 0 ? 'text-rose-600' : 'text-emerald-600'}>
                          {signedMoney(r.signed_amount)}
                        </span>
                      ),
                    },
                    { key: 'running_balance', label: 'Balance', align: 'right', render: (r) => <strong>{money(r.running_balance)}</strong> },
                    { key: 'entered_by_name', label: 'Entered By' },
                    {
                      key: 'entry',
                      label: 'Entry Stamp',
                      render: (r) => `${date(r.entry_date)}${r.entry_time ? ` ${String(r.entry_time).slice(0, 5)}` : ''}`,
                    },
                  ]}
                  rows={ledger?.ledger ?? []}
                  rowKey={(r) => `${r.entry_type}-${r.source_id}`}
                  empty="No transactions recorded for this account yet"
                />
                <p className="mt-2 text-[11px] text-slate-400">
                  Running balance as of {date(ledger?.asOf)} — every row is a posted transaction; reversed entries are excluded.
                </p>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
