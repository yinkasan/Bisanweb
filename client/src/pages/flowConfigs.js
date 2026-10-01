/**
 * Configuration for the seven financial flow pages. One FlowPage component
 * reads these to render list + entry + correction + reversal for each page.
 */
export const FLOW_PAGE_CONFIGS = {
  cash_sales: {
    key: 'cash_sales',
    path: '/cash-sales',
    pageKey: 'cash_sales',
    endpoint: '/cash-sales',
    title: 'Cash Sales',
    subtitle: 'Direct cash received at the depot',
    referencePlaceholder: 'Receipt number',
  },
  pos_sales: {
    key: 'pos_sales',
    path: '/pos-sales',
    pageKey: 'pos_sales',
    endpoint: '/pos-sales',
    title: 'POS Sales',
    subtitle: 'Sales settled through the POS terminal',
    referencePlaceholder: 'POS terminal reference',
  },
  credit_sales: {
    key: 'credit_sales',
    path: '/credit-sales',
    pageKey: 'credit_sales',
    endpoint: '/credit-sales',
    title: 'Credit Sales',
    subtitle: 'Sales on credit — linked to a customer (debtor)',
    referencePlaceholder: 'Invoice number',
    fields: { customer: true },
  },
  customer_payments: {
    key: 'customer_payments',
    path: '/customer-payments',
    pageKey: 'customer_payments',
    endpoint: '/customer-payments',
    title: 'Customer Payments',
    subtitle: 'Money received from customers against outstanding credit',
    referencePlaceholder: 'Receipt / teller reference',
    fields: { customer: true, paymentMethod: true },
  },
  supplier_purchases: {
    key: 'supplier_purchases',
    path: '/supplier-purchases',
    pageKey: 'supplier_purchases',
    endpoint: '/supplier-purchases',
    title: 'Supplier Purchases',
    subtitle: 'Stock and goods received from suppliers (creditors)',
    referencePlaceholder: 'Waybill / invoice number',
    fields: { supplier: true, purchaseType: true },
  },
  supplier_payments: {
    key: 'supplier_payments',
    path: '/supplier-payments',
    pageKey: 'supplier_payments',
    endpoint: '/supplier-payments',
    title: 'Supplier Payments',
    subtitle: 'Money paid to suppliers against outstanding debt',
    referencePlaceholder: 'Payment voucher / transfer reference',
    fields: { supplier: true, paymentMethod: true },
  },
  depot_expenses: {
    key: 'depot_expenses',
    path: '/expenses',
    pageKey: 'depot_expenses',
    endpoint: '/depot-expenses',
    title: 'Depot Expenses',
    subtitle: 'Day-to-day running costs paid from the depot',
    referencePlaceholder: 'Voucher number',
    fields: { description: true, paymentMethod: true },
  },
};

export const PAYMENT_METHOD_FALLBACK = ['Cash', 'POS', 'Bank Transfer', 'Cheque', 'Bank Deposit'];
