/**
 * The navigation model — mirrors the SRS page list. Items are hidden when the
 * signed-in user lacks "view" on the page (Super Admin sees everything).
 */
export const NAV_SECTIONS = [
  {
    label: 'Dashboards',
    items: [
      { to: '/', label: 'Global Dashboard', pageKey: 'dashboard_global', icon: '🌍', end: true },
      { to: '/depot', label: 'Depot Dashboard', pageKey: 'dashboard_depot', icon: '🏬' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { to: '/cash-sales', label: 'Cash Sales', pageKey: 'cash_sales', icon: '💵' },
      { to: '/pos-sales', label: 'POS Sales', pageKey: 'pos_sales', icon: '💳' },
      { to: '/credit-sales', label: 'Credit Sales', pageKey: 'credit_sales', icon: '📝' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { to: '/customer-payments', label: 'Customer Payments', pageKey: 'customer_payments', icon: '💰' },
      { to: '/customers', label: 'Customers / Debtors', pageKey: 'customers', icon: '👥' },
    ],
  },
  {
    label: 'Suppliers',
    items: [
      { to: '/supplier-purchases', label: 'Supplier Purchases', pageKey: 'supplier_purchases', icon: '📦' },
      { to: '/supplier-payments', label: 'Supplier Payments', pageKey: 'supplier_payments', icon: '🏦' },
      { to: '/suppliers', label: 'Suppliers / Creditors', pageKey: 'suppliers', icon: '🏭' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/stock', label: 'Stock Balance', pageKey: 'stock_balance', icon: '📊' },
      { to: '/expenses', label: 'Depot Expenses', pageKey: 'depot_expenses', icon: '🧾' },
    ],
  },
  {
    label: 'Insight',
    items: [
      { to: '/reports', label: 'Reports', pageKey: 'reports', icon: '📈' },
      { to: '/audit', label: 'Audit Trail', pageKey: 'audit_trail', icon: '🛡️' },
      { to: '/notifications', label: 'Notifications', pageKey: 'notifications', icon: '🔔' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/users', label: 'Users', pageKey: 'users', icon: '👤' },
      { to: '/roles', label: 'Roles & Permissions', pageKey: 'roles_permissions', icon: '🔐' },
      { to: '/settings', label: 'System Settings', pageKey: 'settings', icon: '⚙️' },
    ],
  },
];
