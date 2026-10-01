import { Router } from 'express';

import authRoutes from './auth.routes.js';
import usersRoutes from './users.routes.js';
import rolesRoutes from './roles.routes.js';
import depotsRoutes from './depots.routes.js';
import settingsRoutes from './settings.routes.js';
import notificationsRoutes from './notifications.routes.js';
import auditRoutes from './audit.routes.js';
import reportsRoutes from './reports.routes.js';
import dashboardRoutes from './dashboards.routes.js';
import stockValueRoutes from './stockValue.routes.js';
import metaRoutes from './meta.routes.js';
import { createAccountRouter } from './accounts.routes.js';
import { createFlowRouter } from './flowRoutes.js';

/**
 * Every router here is mounted under /api. Page routers carry their own
 * requirePermission checks so authorization lives next to each endpoint.
 */
export function buildApiRouter() {
  const api = Router();

  // Identity & administration
  api.use('/auth', authRoutes);
  api.use('/users', usersRoutes);
  api.use('/roles', rolesRoutes);
  api.use('/depots', depotsRoutes);
  api.use('/settings', settingsRoutes);
  api.use('/notifications', notificationsRoutes);
  api.use('/audit-logs', auditRoutes);
  api.use('/reports', reportsRoutes);
  api.use('/dashboard', dashboardRoutes);
  api.use('/meta', metaRoutes);

  // Accounts (debtors / creditors)
  api.use('/customers', createAccountRouter('customers'));
  api.use('/suppliers', createAccountRouter('suppliers'));

  // Financial flows — one router per page, all sharing the same engine
  api.use('/cash-sales', createFlowRouter('cash_sales'));
  api.use('/pos-sales', createFlowRouter('pos_sales'));
  api.use('/credit-sales', createFlowRouter('credit_sales'));
  api.use('/customer-payments', createFlowRouter('customer_payments'));
  api.use('/supplier-purchases', createFlowRouter('supplier_purchases'));
  api.use('/supplier-payments', createFlowRouter('supplier_payments'));
  api.use('/depot-expenses', createFlowRouter('depot_expenses'));

  // Stock (special flow: one record per depot per day, corrections keep history)
  api.use('/stock-value', stockValueRoutes);

  return api;
}
