import { Router } from 'express';
import { asyncHandler, badRequest } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { assertDepotAccess } from '../services/accessService.js';
import { resolveRange } from '../utils/stamps.js';
import { money } from '../db/pool.js';
import {
  depotMetrics, depotDailySeries, cashAtBank, depotInfo,
  customersWithBalances, suppliersWithDebts, salesBreakdown,
} from '../services/dashboardService.js';

const router = Router();
router.use(requireAuth);

function accessibleDepotIds(user) {
  return user.depots.map((d) => d.id);
}

// GET /api/dashboard/depot?depotId&from&to
router.get(
  '/depot',
  requirePermission('dashboard_depot', 'view'),
  asyncHandler(async (req, res) => {
    const depotId = assertDepotAccess(req.user, req.query.depotId);
    const { from, to } = resolveRange(req.query);
    const [info, metrics, daily, bank] = await Promise.all([
      depotInfo(depotId),
      depotMetrics(depotId, from, to),
      depotDailySeries(depotId, from, to),
      cashAtBank(),
    ]);
    res.json({ depot: info, range: { from, to }, metrics: { ...metrics, cash_at_bank: bank }, daily });
  })
);

// GET /api/dashboard/depot/sales-breakdown?depotId&from&to — drill-down (§36)
router.get(
  '/depot/sales-breakdown',
  requirePermission('dashboard_depot', 'view'),
  asyncHandler(async (req, res) => {
    const depotId = assertDepotAccess(req.user, req.query.depotId);
    const { from, to } = resolveRange(req.query);
    res.json({ range: { from, to }, ...(await salesBreakdown(depotId, from, to)) });
  })
);

// GET /api/dashboard/depot/customers?depotId&to — drill-down: who owes us (§36)
router.get(
  '/depot/customers',
  requirePermission('dashboard_depot', 'view'),
  asyncHandler(async (req, res) => {
    const depotId = assertDepotAccess(req.user, req.query.depotId);
    const { to } = resolveRange({ from: req.query.to, to: req.query.to });
    const rows = await customersWithBalances([depotId], to);
    res.json({ asOf: to, customers: rows });
  })
);

// GET /api/dashboard/depot/suppliers?depotId&to — drill-down: who we owe
router.get(
  '/depot/suppliers',
  requirePermission('dashboard_depot', 'view'),
  asyncHandler(async (req, res) => {
    const depotId = assertDepotAccess(req.user, req.query.depotId);
    const { to } = resolveRange({ from: req.query.to, to: req.query.to });
    const rows = await suppliersWithDebts([depotId], to);
    res.json({ asOf: to, suppliers: rows });
  })
);

// GET /api/dashboard/global?from&to — consolidated across accessible depots
router.get(
  '/global',
  requirePermission('dashboard_global', 'view'),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    const depots = req.user.depots;
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
      }
    );

    const bank = Number(await cashAtBank());
    // Business rule: total cash (global) = Σ cash at hand of the depots.
    const totalCash = totals.cashAtHand;

    res.json({
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
  })
);

// GET /api/dashboard/global/customers?to — consolidated customer credit drill-down
router.get(
  '/global/customers',
  requirePermission('dashboard_global', 'view'),
  asyncHandler(async (req, res) => {
    const { to } = resolveRange({ from: req.query.to, to: req.query.to });
    const rows = await customersWithBalances(accessibleDepotIds(req.user), to);
    res.json({ asOf: to, customers: rows });
  })
);

// GET /api/dashboard/global/suppliers?to — consolidated supplier debt drill-down
router.get(
  '/global/suppliers',
  requirePermission('dashboard_global', 'view'),
  asyncHandler(async (req, res) => {
    const { to } = resolveRange({ from: req.query.to, to: req.query.to });
    const rows = await suppliersWithDebts(accessibleDepotIds(req.user), to);
    res.json({ asOf: to, suppliers: rows });
  })
);

export default router;
