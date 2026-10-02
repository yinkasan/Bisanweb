/**
 * Component catalogue for the role-level access editor (Roles & Permissions).
 * Direct port of server/src/services/permissionCatalog.js — the api function
 * serves it on GET /roles/access and the web client reads component overrides
 * through useAuth().comp(pageKey, componentKey).
 */

export interface CatalogComponent {
  key: string;
  label: string;
  input?: boolean;
}

const FLOW_COMPONENTS: CatalogComponent[] = [
  { key: 'table', label: 'Transactions table' },
  { key: 'new_entry', label: 'New Entry button', input: true },
  { key: 'edit_action', label: 'Correction (edit) action', input: true },
  { key: 'reverse_action', label: 'Reversal action', input: true },
];

export const COMPONENT_CATALOG: Record<string, CatalogComponent[]> = {
  dashboard_global: [
    { key: 'card_total_sales', label: 'Total Sales card' },
    { key: 'card_total_residual', label: 'Total Residual Balance card' },
    { key: 'card_customer_credit', label: 'Total Customer Credit card' },
    { key: 'card_supplier_debt', label: 'Total Supplier Debt card' },
    { key: 'card_total_cash', label: 'Total Cash card' },
    { key: 'card_supplier_purchases', label: 'Supplier Purchases card' },
    { key: 'card_expenses', label: 'Expenses card' },
    { key: 'card_depots_reporting', label: 'Depots Reporting card' },
    { key: 'depot_comparison', label: 'Per-Depot Comparison table' },
  ],
  dashboard_depot: [
    { key: 'card_total_sales', label: 'Total Sales card' },
    { key: 'card_customer_credit', label: 'Customer Credit card' },
    { key: 'card_supplier_debt', label: 'Supplier Debt card' },
    { key: 'card_residual_balance', label: 'Residual Balance card' },
    { key: 'card_cash_at_hand', label: 'Cash at Hand card' },
    { key: 'card_cash_sales', label: 'Cash Sales card' },
    { key: 'card_pos_sales', label: 'POS Sales card' },
    { key: 'card_supplier_purchases', label: 'Supplier Purchases card' },
    { key: 'card_customer_payments', label: 'Customer Payments card' },
    { key: 'card_expenses', label: 'Expenses card' },
    { key: 'card_stock_value', label: 'Stock Value card' },
    { key: 'daily_movement', label: 'Daily Movement table' },
  ],
  cash_sales: FLOW_COMPONENTS,
  pos_sales: FLOW_COMPONENTS,
  credit_sales: FLOW_COMPONENTS,
  customer_payments: FLOW_COMPONENTS,
  supplier_purchases: FLOW_COMPONENTS,
  supplier_payments: FLOW_COMPONENTS,
  depot_expenses: FLOW_COMPONENTS,
  customers: [
    { key: 'table', label: 'Customer list' },
    { key: 'new_entry', label: 'New Customer button', input: true },
    { key: 'edit_action', label: 'Edit action', input: true },
    { key: 'delete_action', label: 'Delete action', input: true },
  ],
  suppliers: [
    { key: 'table', label: 'Supplier list' },
    { key: 'new_entry', label: 'New Supplier button', input: true },
    { key: 'edit_action', label: 'Edit action', input: true },
    { key: 'delete_action', label: 'Delete action', input: true },
  ],
};
