import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DateRangeBar } from '../components/Filters.jsx';
import {
  Alert, Card, ErrorText, Modal, PageHeader, Spinner, StatCard, Table,
} from '../components/ui.jsx';
import { money, moneyCompact, date, monthStartISO, todayISO } from '../utils/format.js';

/**
 * Global Dashboard — consolidated view across every depot the user can see
 * (SRS §10). Each tile and each depot row drills into its transactions.
 */
export default function GlobalDashboardPage() {
  const { comp } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ from: monthStartISO(), to: todayISO() });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get(`/dashboard/global${qs(filters)}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const openDrill = async (kind) => {
    try {
      if (kind === 'customers') {
        setDrill({ kind, payload: await api.get(`/dashboard/global/customers${qs({ to: filters.to })}`) });
      } else if (kind === 'suppliers') {
        setDrill({ kind, payload: await api.get(`/dashboard/global/suppliers${qs({ to: filters.to })}`) });
      } else {
        setDrill({ kind, payload: null });
      }
    } catch (err) {
      setError(err);
    }
  };

  const t = data?.totals;
  // Component-level access (set per role on the Roles page).
  const show = (key) => comp('dashboard_global', key).visible;
  const residualPositive = Number(t?.total_residual_balance ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="Global Dashboard"
        subtitle="Consolidated position across all depots you can access"
      />

      <DateRangeBar
        from={filters.from}
        to={filters.to}
        onFrom={(v) => setFilters((f) => ({ ...f, from: v }))}
        onTo={(v) => setFilters((f) => ({ ...f, to: v }))}
      />

      <ErrorText error={error} />

      {loading || !t ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {show('card_total_sales') && (
              <StatCard
                label="Total Sales (all depots)"
                value={money(t.total_sales)}
                hint={`Cash ${moneyCompact(t.cash_sales)} · POS ${moneyCompact(t.pos_sales)} · Credit ${moneyCompact(t.credit_sales)}`}
                tone="indigo"
                onClick={() => openDrill('sales')}
              />
            )}
            {show('card_total_residual') && (
              <StatCard
                label="Total Residual Balance"
                value={money(t.total_residual_balance)}
                hint="Sum of every depot's residual balance"
                tone={residualPositive ? 'emerald' : 'rose'}
                onClick={() => openDrill('residual')}
              />
            )}
            {show('card_customer_credit') && (
              <StatCard
                label="Total Customer Credit"
                value={money(t.customer_credit)}
                hint="Who owes the company"
                tone="amber"
                onClick={() => openDrill('customers')}
              />
            )}
            {show('card_supplier_debt') && (
              <StatCard
                label="Total Supplier Debt"
                value={money(t.supplier_debt)}
                hint="What the company owes"
                tone="rose"
                onClick={() => openDrill('suppliers')}
              />
            )}
            {show('card_total_cash') && (
              <StatCard label="Total Cash" value={money(t.total_cash)} hint="Sum of every depot's cash at hand" />
            )}
            {show('card_supplier_purchases') && (
              <StatCard label="Supplier Purchases (period)" value={money(t.supplier_purchases)} hint="Restocking across depots" />
            )}
            {show('card_expenses') && (
              <StatCard label="Expenses (period)" value={money(t.expenses)} hint="Running costs" />
            )}
            {show('card_depots_reporting') && (
              <StatCard label="Depots reporting" value={String(data.depots.length)} hint="Accessible depots" />
            )}
          </div>

          {show('depot_comparison') && (
          <Card title="Per-Depot Comparison — click a row for the depot dashboard">
            <Table
              columns={[
                { key: 'code', label: 'Depot' },
                { key: 'name', label: 'Name' },
                { key: 'cash_sales', label: 'Cash', align: 'right', render: (r) => money(r.cash_sales) },
                { key: 'pos_sales', label: 'POS', align: 'right', render: (r) => money(r.pos_sales) },
                { key: 'credit_sales', label: 'Credit', align: 'right', render: (r) => money(r.credit_sales) },
                { key: 'total_sales', label: 'Total Sales', align: 'right', render: (r) => <strong>{money(r.total_sales)}</strong> },
                { key: 'supplier_purchases', label: 'Purchases', align: 'right', render: (r) => money(r.supplier_purchases) },
                { key: 'expenses', label: 'Expenses', align: 'right', render: (r) => money(r.expenses) },
                { key: 'customer_credit', label: 'Cust. Credit', align: 'right', render: (r) => money(r.customer_credit) },
                { key: 'supplier_debt', label: 'Supp. Debt', align: 'right', render: (r) => money(r.supplier_debt) },
                { key: 'cash_at_hand', label: 'Cash at Hand', align: 'right', render: (r) => money(r.cash_at_hand) },
                { key: 'stock_value', label: 'Stock', align: 'right', render: (r) => (r.stock_value === null ? '—' : money(r.stock_value)) },
                { key: 'residual_balance', label: 'Residual Balance', align: 'right', render: (r) => <strong className={Number(r.residual_balance) > 0 ? 'text-emerald-700' : 'text-rose-600'}>{money(r.residual_balance)}</strong> },
              ]}
              rows={data.depots}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/depot?depotId=${r.id}`)}
            />
            <p className="mt-2 text-[11px] text-slate-400">
              Period {date(filters.from)} – {date(filters.to)} · outstanding balances are cumulative to {date(filters.to)}.
            </p>
          </Card>
          )}
        </div>
      )}

      <Modal open={drill?.kind === 'residual'} title="Total Residual Balance" onClose={() => setDrill(null)}>
        {t && data ? (
          <div className="space-y-2 text-sm">
            <Alert kind="info">
              Total Residual Balance = the sum of every depot's residual balance
              (total sales + present stock − previous stock − purchases).
            </Alert>
            <div className="divide-y divide-slate-100">
              {data.depots.map((d) => (
                <div key={d.id} className="flex items-center justify-between py-2">
                  <span className="text-slate-500">{d.code} — {d.name}</span>
                  <span className={`money ${Number(d.residual_balance) > 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{money(d.residual_balance)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between py-2">
                <span className="font-semibold text-slate-800">= Total</span>
                <span className={`money font-bold ${residualPositive ? 'text-emerald-700' : 'text-rose-600'}`}>{money(t.total_residual_balance)}</span>
              </div>
            </div>
          </div>
        ) : <Spinner />}
      </Modal>

      <Modal open={drill?.kind === 'customers'} title="Total Customer Credit — consolidated debtors" onClose={() => setDrill(null)} wide>
        <Table
          columns={[
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Customer' },
            { key: 'depot_code', label: 'Depot' },
            { key: 'balance', label: 'Outstanding', align: 'right', render: (r) => money(r.balance) },
          ]}
          rows={drill?.payload?.customers ?? []}
          rowKey={(r) => r.id}
          empty="No outstanding customer balances"
          onRowClick={(r) => navigate(`/customers/${r.id}`)}
        />
      </Modal>

      <Modal open={drill?.kind === 'suppliers'} title="Total Supplier Debt — consolidated creditors" onClose={() => setDrill(null)} wide>
        <Table
          columns={[
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Supplier' },
            { key: 'depot_code', label: 'Depot' },
            { key: 'debt', label: 'Outstanding', align: 'right', render: (r) => money(r.debt) },
          ]}
          rows={drill?.payload?.suppliers ?? []}
          rowKey={(r) => r.id}
          empty="No outstanding supplier debt"
          onRowClick={(r) => navigate(`/suppliers/${r.id}`)}
        />
      </Modal>

      <Modal open={drill?.kind === 'sales'} title="Total Sales — per depot" onClose={() => setDrill(null)} wide>
        {data ? (
          <Table
            columns={[
              { key: 'code', label: 'Depot' },
              { key: 'cash_sales', label: 'Cash', align: 'right', render: (r) => money(r.cash_sales) },
              { key: 'pos_sales', label: 'POS', align: 'right', render: (r) => money(r.pos_sales) },
              { key: 'credit_sales', label: 'Credit', align: 'right', render: (r) => money(r.credit_sales) },
              { key: 'total_sales', label: 'Total', align: 'right', render: (r) => <strong>{money(r.total_sales)}</strong> },
            ]}
            rows={data.depots}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/depot?depotId=${r.id}`)}
          />
        ) : <Spinner />}
      </Modal>
    </>
  );
}
