/**
 * Shared UI primitives. Small, dependency-free, Tailwind-styled.
 */
import { useEffect } from 'react';

// --- Layout -----------------------------------------------------------------

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          {title ? <h2 className="text-sm font-semibold text-slate-700">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </div>
  );
}

const TONES = {
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
  slate: 'bg-slate-50 text-slate-700 ring-slate-200',
};

export function StatCard({ label, value, hint, tone = 'slate', onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition
        ${clickable ? 'cursor-pointer hover:border-indigo-300 hover:shadow' : 'cursor-default'}`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold money ${tone === 'rose' ? 'text-rose-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-slate-900'}`}>
        {value}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        {hint ? <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${TONES[tone] ?? TONES.slate}`}>{hint}</span> : <span />}
        {clickable ? <span className="text-[11px] font-medium text-indigo-600">View details →</span> : null}
      </div>
    </button>
  );
}

// --- Controls ---------------------------------------------------------------

const BUTTON_VARIANTS = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  ghost: 'text-slate-600 hover:bg-slate-100',
};

export function Button({ variant = 'secondary', size = 'md', className = '', ...props }) {
  const sizes = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm' };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed
        ${sizes[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, required, children, error, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">
        {label}{required ? <span className="text-rose-500"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-slate-400">{hint}</span> : null}
      {error ? <span className="mt-1 block text-[11px] text-rose-600">{error}</span> : null}
    </label>
  );
}

// text-base on phones prevents iOS from zooming when a field is focused;
// desktop keeps the denser text-sm.
const INPUT_CLASS = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-400';

export function Input({ className = '', ...props }) {
  return <input className={`${INPUT_CLASS} ${className}`} {...props} />;
}

export function MoneyInput({ className = '', ...props }) {
  return <input type="number" step="0.01" min="0" className={`${INPUT_CLASS} money ${className}`} {...props} />;
}

export function TextArea({ className = '', ...props }) {
  return <textarea rows={2} className={`${INPUT_CLASS} ${className}`} {...props} />;
}

export function Select({ options, className = '', children, ...props }) {
  return (
    <select className={`${INPUT_CLASS} ${className}`} {...props}>
      {options
        ? options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
          ))
        : children}
    </select>
  );
}

// --- Modal ------------------------------------------------------------------

export function Modal({ open, title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-3 sm:p-4 sm:pt-12" onMouseDown={onClose}>
      <div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl bg-white shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={onClose}>✕</button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto px-4 py-4 sm:max-h-[70vh]">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

// --- Table ------------------------------------------------------------------

export function Table({ columns, rows, rowKey, empty = 'No records found', onRowClick, footer }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
            {columns.map((c) => (
              <th key={c.key} className={`whitespace-nowrap px-3 py-2 font-semibold ${c.align === 'right' ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-slate-400">{empty}</td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey ? rowKey(row) : i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-slate-100 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-indigo-50/40' : 'hover:bg-slate-50/60'}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 align-middle ${c.align === 'right' ? 'money' : ''}`}>
                    {c.render ? c.render(row) : row[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) {
    return <div className="px-3 py-2 text-xs text-slate-400">{total} record{total === 1 ? '' : 's'}</div>;
  }
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs text-slate-500">
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</Button>
        <span>Page {page} / {pages}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</Button>
      </div>
    </div>
  );
}

// --- Feedback ---------------------------------------------------------------

export function Badge({ value, tone }) {
  const map = {
    posted: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    reversed: 'bg-rose-50 text-rose-700 ring-rose-200',
    active: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    inactive: 'bg-slate-100 text-slate-500 ring-slate-200',
  };
  const chosen = tone ? TONES[tone] : map[String(value).toLowerCase()] ?? TONES.slate;
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ${chosen}`}>
      {value}
    </span>
  );
}

export function Alert({ kind = 'info', children, onClose }) {
  if (!children) return null;
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-rose-200 bg-rose-50 text-rose-800',
  };
  return (
    <div className={`mb-3 flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${tones[kind]}`}>
      <span>{children}</span>
      {onClose ? <button type="button" className="text-xs opacity-60 hover:opacity-100" onClick={onClose}>✕</button> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
      {label}
    </div>
  );
}

export function ErrorText({ error }) {
  if (!error) return null;
  return <Alert kind="error">{error.message ?? String(error)}</Alert>;
}
