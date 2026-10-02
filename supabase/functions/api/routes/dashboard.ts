/**
 * /dashboard — port of server/src/routes/dashboards.routes.js. Depot and
 * consolidated global dashboards plus the drill-down endpoints (SRS §36).
 */
import { json } from '../../_shared/http.ts';
import { assertDepotAccess, assertPermission } from '../../_shared/auth.ts';
import {
  cashAtBank, customersWithBalances, depotDailySeries, depotInfo,
  depotMetrics, money, salesBreakdown, suppliersWithDebts,
} from '../../_shared/metrics.ts';
import { optionalDate, resolveRange, todayIso } from '../../_shared/stamps.ts';
import { badRequest, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

function accessibleDepotIds(user: Ctx['user']): number[] {
  return user.depots.map((d) => d.id);
}

/** resolveRange for a single-date drill-down: { to } defaults to today. */
function asOfDate(sp: URLSearchParams): string {
  return optionalDate(sp.get('to'), 'to') ?? todayIso();
}

export const handleDashboard: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const rest = under(c.path, '/dashboard');
  if (!rest) return null;
  const { method, url, user } = c;
  if (method !== 'GET') return null;
  const sp = url.searchParams;

  // GET /dashboard/depot?depotId&from&to
  if (rest === '/depot') {
    assertPermission(user, 'dashboard_depot', 'view');
    const depotId = assertDepotAccess(user, sp.get('depotId'));
    const { from, to } = resolveRange(sp);
    const [info, metrics, daily, bank] = await Promise.all([
      depotInfo(depotId),
      depotMetrics(depotId, from, to),
      depotDailySeries(depotId, from, to),
      cashAtBank(),
    ]);
    return json({ depot: info, range: { from, to }, metrics: { ...metrics, cash_at_bank: bank }, daily });
  }

  // GET /dashboard/depot/sales-breakdown?depotId&from&to — drill-down (§36)
  if (rest === '/depot/sales-breakdown') {
    assertPermission(user, 'dashboard_depot', 'view');
    const depotId = assertDepotAccess(user, sp.get('depotId'));
    const { from, to } = resolveRange(sp);
    return json({ range: { from, to }, ...(await salesBreakdown(depotId, from, to)) });
  }

  // GET /dashboard/depot/customers?depotId&to — drill-down: who owes us (§36)
  if (rest === '/depot/customers') {
    assertPermission(user, 'dashboard_depot', 'view');
    const depotId = assertDepotAccess(user, sp.get('depotId'));
    const to = asOfDate(sp);
    const rows = await customersWithBalances([depotId], to);
    return json({ asOf: to, customers: rows });
  }

  // GET /dashboard/depot/suppliers?depotId&to — drill-down: who we owe
  if (rest === '/depot/suppliers') {
    assertPermission(user, 'dashboard_depot', 'view');
    const depotId = assertDepotAccess(user, sp.get('depotId'));
    const to = asOfDate(sp);
    const rows = await suppliersWithDebts([depotId], to);
    return json({ asOf: to, suppliers: rows });
  }

  // GET /dashboard/global?from&to — consolidated across accessible depots
  if (rest === '/global') {
    assertPermission(user, 'dashboard_global', 'view');
    const { from, to } = resolveRange(sp);
    const depots = user.depots;
    if (depots.length === 0) {
      throw badRequest('You are not assigned to any depot — nothing to consolidate');
    }

    const perDepot = [];
    for (const depot of depots) {
      // eslint-disable-next-line no-await-in-loop
      const metrics = await depotMetrics(depot.id, from, to);
      perDepot.push({ depot, metrics });
    }

    const totals = perDepot.reduce(
      (acc, { metrics }) => {
        acc.cashSales += Number(metrics.cash_sales);
        acc.posSales += Number(metrics.pos_sales);
        acc.creditSales += Number(metrics.credit_sales);
        acc.totalSales += Number(metrics.total_sales);
        acc.supplierPurchases += Number(metrics.supplier_purchases);
        acc.expenses += Number(metrics.expenses);
        acc.customerCredit += Number(metrics.customer_credit);
        acc.supplierDebt += Number(metrics.supplier_debt);
        acc.cashAtHand += Number(metrics.cash_at_hand);
        acc.residualBalance += Number(metrics.residual_balance);
        return acc;
      },
      {
        cashSales: 0, posSales: 0, creditSales: 0, totalSales: 0, supplierPurchases: 0,
        expenses: 0, customerCredit: 0, supplierDebt: 0, cashAtHand: 0, residualBalance: 0,
      },
    );

    const bank = Number(await cashAtBank());
    // Business rule: total cash (global) = Σ cash at hand of the depots.
    const totalCash = totals.cashAtHand;

    return json({
      range: { from, to },
      totals: {
        cash_sales: money(totals.cashSales),
        pos_sales: money(totals.posSales),
        credit_sales: money(totals.creditSales),
        total_sales: money(totals.totalSales),
        supplier_purchases: money(totals.supplierPurchases),
        expenses: money(totals.expenses),
        cash_at_hand: money(totals.cashAtHand),
        cash_at_bank: money(bank),
        total_cash: money(totalCash),
        total_residual_balance: money(totals.residualBalance),
        customer_credit: money(totals.customerCredit),
        supplier_debt: money(totals.supplierDebt),
      },
      depots: perDepot.map(({ depot, metrics }) => ({
        id: depot.id,
        code: depot.code,
        name: depot.name,
        cash_sales: metrics.cash_sales,
        pos_sales: metrics.pos_sales,
        credit_sales: metrics.credit_sales,
        total_sales: metrics.total_sales,
        supplier_purchases: metrics.supplier_purchases,
        expenses: metrics.expenses,
        customer_credit: metrics.customer_credit,
        supplier_debt: metrics.supplier_debt,
        cash_at_hand: metrics.cash_at_hand,
        stock_value: metrics.stock_value,
        residual_balance: metrics.residual_balance,
      })),
    });
  }

  // GET /dashboard/global/customers?to — consolidated customer credit drill-down
  if (rest === '/global/customers') {
    assertPermission(user, 'dashboard_global', 'view');
    const to = asOfDate(sp);
    const rows = await customersWithBalances(accessibleDepotIds(user), to);
    return json({ asOf: to, customers: rows });
  }

  // GET /dashboard/global/suppliers?to — consolidated supplier debt drill-down
  if (rest === '/global/suppliers') {
    assertPermission(user, 'dashboard_global', 'view');
    const to = asOfDate(sp);
    const rows = await suppliersWithDebts(accessibleDepotIds(user), to);
    return json({ asOf: to, suppliers: rows });
  }

  return null;
};
