import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { Field, Input, Select } from './ui.jsx';
import { todayISO, daysAgoISO } from '../utils/format.js';

/**
 * Depot picker driven by the user's assignments. If they have exactly one
 * depot it is selected automatically.
 */
export function DepotPicker({ value, onChange, allowAll = false, label = 'Depot', className = '' }) {
  const { user } = useAuth();
  const depots = user?.depots ?? [];

  useEffect(() => {
    if (value === undefined || value === null || value === '') {
      if (depots.length >= 1) onChange(allowAll ? depots[0].id : depots[0].id);
    }
  }, [depots, value, onChange, allowAll]);

  return (
    <Field label={label}>
      <Select
        className={className}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowAll ? <option value="">All depots</option> : null}
        {depots.length === 0 ? <option value="" disabled>No depots assigned</option> : null}
        {depots.map((d) => (
          <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Date-range bar used on every list/report page (SRS: all financial
 * information can be filtered by date and date range).
 */
export function DateRangeBar({ from, to, onFrom, onTo, onApply, extra, quickRanges = true }) {
  const set = (f, t) => { onFrom(f); onTo(t); };

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <Field label="From">
        <Input type="date" value={from} max={to} onChange={(e) => onFrom(e.target.value)} />
      </Field>
      <Field label="To">
        <Input type="date" value={to} min={from} onChange={(e) => onTo(e.target.value)} />
      </Field>
      {onApply ? (
        <button
          type="button"
          onClick={onApply}
          className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Apply
        </button>
      ) : null}
      {quickRanges ? (
        <div className="flex flex-wrap items-center gap-1 pb-0.5">
          {[
            ['Today', 0], ['7 days', 6], ['30 days', 29],
          ].map(([name, days]) => (
            <button
              key={name}
              type="button"
              onClick={() => { set(daysAgoISO(days), todayISO()); onApply?.(); }}
              className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex-1" />
      {extra}
    </div>
  );
}
