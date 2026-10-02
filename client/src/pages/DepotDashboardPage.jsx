import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DepotPicker, DateRangeBar } from '../components/Filters.jsx';
import {
  Alert, Badge, Button, Card, ErrorText, Modal, PageHeader, Spinner, StatCard, Table,
} from '../components/ui.jsx';
import { money, moneyCompact, date, monthStartISO, todayISO } from '../utils/format.js';

/**
 * Depot Dashboard — every figure links to the transactions behind it (SRS §36).
 */
export default function DepotDashboardPage() {
  const { comp } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    depotId: searchParams.get('depotId') ?? '',
    from: monthStartISO(),
    to: todayISO(),
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null); // { kind: 'sales'|'customers'|'suppliers'|'residual', payload }

  const load = useCallback(async () => {
    if (!filters.depotId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get(`/dashboard/depot${qs(filters)}`);
      setData(result);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const openDrill = async (kind) => {
    try {
      if (kind === 'sales') {
        const payload = await api.get(`/dashboard/depot/sales-breakdown${qs(filters)}`);
        setDrill({ kind, payload });
      } else if (kind === 'customers') {
        const payload = await api.get(`/dashboard/depot/customers${qs({ depotId: filters.depotId, to: filters.to })}`);
        setDrill({ kind, payload });
      } else if (kind === 'suppliers') {
        const payload = await api.get(`/dashboard/depot/suppliers${qs({ depotId: filters.depotId, to: filters.to })}`);
        setDrill({ kind, payload });
      } else if (kind === 'residual') {
        setDrill({ kind, payload: null });
      }
    } catch (err) {
      setError(err);
    }
  };

  const m = data?.metrics;
  // Component-level access (set per role on the Roles page).
  const show = (key) => comp('dashboard_depot', key).visible;
  const residualPositive = Number(m?.residual_balance ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="Depot Dashboard"
        subtitle={data?.depot ? `${data.depot.code} — ${data.depot.name}${data.depot.location ? ` · ${data.depot.location}` : ''}` : 'Live figures calculated from transactions'}
      />

      <DateRangeBar
        from={filters.from}
        to={filters.to}
        onFrom={(v) => setFilters((f) => ({ ...f, from: v }))}
        onTo={(v) => setFilters((f) => ({ ...f, to: v }))}
        extra={<DepotPicker value={filters.depotId} onChange={(v) => { setFilters((f) => ({ ...f, depotId: v })); setSearchParams({ depotId: v }); }} />}
      />

      <ErrorText error={error} />

      {loading || !m ? <Spinner /> : (
        <div className="space-y-4">
          {/* KPI grid — click a tile to see the transactions behind the number */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {show('card_total_sales') && (
              <StatCard
                label="Total Sales"
                value={money(m.total_sales)}
                hint={`Cash ${moneyCompact(m.cash_sales)} · POS ${moneyCompact(m.pos_sales)} · Credit ${moneyCompact(m.credit_sales)}`}
                tone="indigo"
                onClick={() => openDrill('sales')}
              />
            )}
            {show('card_customer_credit') && (
              <StatCard
                label="Customer Credit (to date)"
                value={money(m.customer_credit)}
                hint="Who owes us"
                tone="amber"
                onClick={() => openDrill('customers')}
              />
            )}
            {show('card_supplier_debt') && (
              <StatCard
                label="Supplier Debt (to date)"
                value={money(m.supplier_debt)}
                hint="Who we owe"
                tone="rose"
                onClick={() => openDrill('suppliers')}
              />
            )}
            {show('card_residual_balance') && (
              <StatCard
                label="Residual Balance"
                value={money(m.residual_balance)}
                hint="Sales + stock Δ − purchases"
                tone={residualPositive ? 'emerald' : 'rose'}
                onClick={() => openDrill('residual')}
              />
            )}
            {show('card_cash_at_hand') && (
              <StatCard label="Cash at Hand" value={money(m.cash_at_hand)} hint="Cash sales − expenses" />
            )}
            {show('card_cash_sales') && (
              <StatCard label="Cash Sales" value={money(m.cash_sales)} hint="Cash received in period" />
            )}
            {show('card_pos_sales') && (
              <StatCard label="POS Sales (period)" value={money(m.pos_sales)} hint="Settled via terminal" />
            )}
            {show('card_supplier_purchases') && (
              <StatCard label="Supplier Purchases (period)" value={money(m.supplier_purchases)} hint="Stock bought" />
            )}
            {show('card_customer_payments') && (
              <StatCard label="Customer Payments (period)" value={money(m.customer_payments)} hint="Collected from debtors" />
            )}
            {show('card_expenses') && (
              <StatCard label="Expenses (period)" value={money(m.expenses)} hint="Running costs" />
            )}
            {show('card_stock_value') && (
              <StatCard
                label="Stock Value"
                value={m.stock_value === null ? 'Not recorded' : money(m.stock_value)}
                hint={m.stock_value_date ? `As of ${date(m.stock_value_date)}` : 'No stock record yet'}
                onClick={() => navigate('/stock')}
              />
            )}
          </div>

          {/* Daily movement against the operating-balance chain */}
          {show('daily_movement') && (
          <Card title="Daily Movement & Operating Balance (SRS §17 chain)">
            <Table
              columns={[
                { key: 'transaction_date', label: 'Date', render: (r) => date(r.transaction_date) },
                { key: 'cash_sales', label: 'Cash Sales', align: 'right', render: (r) => money(r.cash_sales) },
                { key: 'pos_sales', label: 'POS Sales', align: 'right', render: (r) => money(r.pos_sales) },
                { key: 'credit_sales', label: 'Credit Sales', align: 'right', render: (r) => money(r.credit_sales) },
                { key: 'total_sales', label: 'Total Sales', align: 'right', render: (r) => money(r.total_sales) },
                { key: 'supplier_purchases', label: 'Purchases', align: 'right', render: (r) => money(r.supplier_purchases) },
                { key: 'expenses', label: 'Expenses', align: 'right', render: (r) => money(r.expenses) },
                { key: 'operating_balance', label: 'Operating Balance', align: 'right', render: (r) => <strong>{money(r.operating_balance)}</strong> },
              ]}
              rows={data.daily ?? []}
              rowKey={(r) => r.transaction_date}
              empty="No transactions in this period"
            />
            <p className="mt-2 text-[11px] text-slate-400">
              Operating balance day by day = previous balance + supplier purchases − total sales,
              starting from the depot opening balance of {money(m.opening_operating_balance)}.
            </p>
          </Card>
          )}
        </div>
      )}

      {/* Drill-down modals */}
      <Modal open={drill?.kind === 'sales'} title="Total Sales — breakdown (drill-down)" onClose={() => setDrill(null)} wide>
        {drill?.payload ? (
          <div className="space-y-4">
            {[['cash_sales', 'Cash Sales'], ['pos_sales', 'POS Sales'], ['credit_sales', 'Credit Sales']].map(([key, title]) => (
              <div key={key}>
                <h3 className="mb-1 flex items-center justify-between text-sm font-semibold text-slate-700">
                  <span>{title}</span>
                  <span className="money text-indigo-700">{money(drill.payload[key]?.total)}</span>
                </h3>
                <Table
                  columns={[
                    { key: 'transaction_date', label: 'Date', render: (r) => date(r.transaction_date) },
                    { key: 'reference', label: 'Reference', render: (r) => r.reference || '—' },
                    ...(key === 'credit_sales' ? [{ key: 'customer_name', label: 'Customer' }] : []),
                    { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
                    { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
                    { key: 'entered_by_name', label: 'Entered By' },
                  ]}
                  rows={(drill.payload[key]?.entries ?? []).slice(0, 25)}
                  rowKey={(r) => r.id}
                  empty="Nothing recorded"
                />
              </div>
            ))}
          </div>
        ) : <Spinner />}
      </Modal>

      <Modal open={drill?.kind === 'customers'} title="Customer Credit — who owes us (drill-down)" onClose={() => setDrill(null)} wide>
        <Table
          columns={[
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Customer' },
            { key: 'balance', label: 'Outstanding', align: 'right', render: (r) => money(r.balance) },
          ]}
          rows={drill?.payload?.customers ?? []}
          rowKey={(r) => r.id}
          empty="No outstanding customer balances"
          onRowClick={(r) => navigate(`/customers/${r.id}`)}
        />
        <p className="mt-2 text-[11px] text-slate-400">As of {date(drill?.payload?.asOf)} · click a customer to open their ledger.</p>
      </Modal>

      <Modal open={drill?.kind === 'suppliers'} title="Supplier Debt — who we owe (drill-down)" onClose={() => setDrill(null)} wide>
        <Table
          columns={[
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Supplier' },
            { key: 'debt', label: 'Outstanding', align: 'right', render: (r) => money(r.debt) },
          ]}
          rows={drill?.payload?.suppliers ?? []}
          rowKey={(r) => r.id}
          empty="No outstanding supplier debt"
          onRowClick={(r) => navigate(`/suppliers/${r.id}`)}
        />
        <p className="mt-2 text-[11px] text-slate-400">As of {date(drill?.payload?.asOf)} · click a supplier to open their ledger.</p>
      </Modal>

      <Modal open={drill?.kind === 'residual'} title="Residual Balance — how it is calculated" onClose={() => setDrill(null)}>
        {m ? (
          <div className="space-y-2 text-sm">
            <Alert kind="info">
              Residual Balance = Total Sales + Present Stock Value − Previous Stock Value − Supplier
              Purchases (period). Positive shows green, negative shows red.
            </Alert>
            <div className="divide-y divide-slate-100">
              {[
                ['Total sales (period)', money(m.total_sales)],
                ['+ Present stock value (as of To)', m.stock_value === null ? 'Not recorded' : money(m.stock_value)],
                ['− Previous stock value (before From)', money(m.previous_stock_value)],
                ['− Supplier purchases (period)', money(m.supplier_purchases)],
                ['= Residual balance', money(m.residual_balance)],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between py-2">
                  <span className={k.startsWith('=') ? 'font-semibold text-slate-800' : 'text-slate-500'}>{k}</span>
                  <span className={`money ${k.startsWith('=') ? (residualPositive ? 'font-bold text-emerald-700' : 'font-bold text-rose-600') : ''}`}>{v}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">
              Present stock value = latest stock record up to To · Previous stock value = latest stock
              record before From (0 when none exists yet).
            </p>
          </div>
        ) : <Spinner />}
      </Modal>
    </>
  );
}
