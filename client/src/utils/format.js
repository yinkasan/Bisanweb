/** Formatting helpers shared across pages. */

const moneyFormatter = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactFormatter = new Intl.NumberFormat('en-NG', {
  notation: 'compact',
  maximumFractionDigits: 2,
});

export const CURRENCY = '₦';

/** "1234567.5" | 1234567.5 -> "₦1,234,567.50" */
export function money(value, { withSymbol = true } = {}) {
  const n = Number(value ?? 0);
  if (Number.isNaN(n)) return withSymbol ? `${CURRENCY}0.00` : '0.00';
  return `${withSymbol ? CURRENCY : ''}${moneyFormatter.format(n)}`;
}

/** Compact for dashboard tiles: "₦1.23M" */
export function moneyCompact(value) {
  const n = Number(value ?? 0);
  if (Number.isNaN(n)) return `${CURRENCY}0`;
  if (Math.abs(n) < 1000) return money(n);
  return `${CURRENCY}${compactFormatter.format(n)}`;
}

export const NEGATIVE = 'text-red-600';
export const POSITIVE = 'text-emerald-600';

/** ISO date -> "21/09/2026" (SRS displays DD/MM/YYYY). */
export function date(value) {
  if (!value) return '—';
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return String(value);
  return `${d}/${m}/${y}`;
}

/** ISO timestamp -> "21/09/2026 14:03" */
export function dateTime(value) {
  if (!value) return '—';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()} ${hh}:${mi}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function monthStartISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** "posted" -> "Posted", "reversed" -> "Reversed" */
export function label(value) {
  if (!value) return '—';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
