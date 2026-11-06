import type { GstSettings } from '../../services/fetchServices';
import { inputClass } from '../../components/ui/formClasses';

export const AU_TIME_ZONES = [
  { value: 'Australia/Sydney', label: 'Sydney / Canberra (NSW, ACT)' },
  { value: 'Australia/Melbourne', label: 'Melbourne (VIC)' },
  { value: 'Australia/Brisbane', label: 'Brisbane (QLD)' },
  { value: 'Australia/Adelaide', label: 'Adelaide (SA)' },
  { value: 'Australia/Darwin', label: 'Darwin (NT)' },
  { value: 'Australia/Perth', label: 'Perth (WA)' },
  { value: 'Australia/Hobart', label: 'Hobart (TAS)' },
] as const;

export const DEFAULT_GST: GstSettings = {
  registered: true,
  basis: 'CASH',
  basCycle: 'QUARTERLY',
  basMethod: 'SIMPLER',
};

/** The Australian tax choices, shared by the setup wizard and Settings. */
export default function GstFields({
  value,
  onChange,
  timeZone,
  onTimeZoneChange,
  disabled = false,
}: {
  value: GstSettings;
  onChange: (next: GstSettings) => void;
  timeZone: string;
  onTimeZoneChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Time zone</span>
        <select value={timeZone} onChange={(e) => onTimeZoneChange(e.target.value)} disabled={disabled} className={inputClass}>
          {AU_TIME_ZONES.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.registered}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, registered: e.target.checked })}
        />
        Registered for GST
      </label>
      <p className="text-xs text-[var(--muted)] m-0">
        You must register once your GST turnover reaches $75,000 ($150,000 for a non-profit).
      </p>

      {value.registered && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">GST accounting basis</span>
            <select
              value={value.basis}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, basis: e.target.value === 'ACCRUAL' ? 'ACCRUAL' : 'CASH' })}
              className={inputClass}
            >
              <option value="CASH">Cash: report GST when paid</option>
              <option value="ACCRUAL">Accruals: report GST when invoiced</option>
            </select>
          </label>
          <p className="text-xs text-[var(--muted)] m-0">
            Cash is available when aggregated turnover is under $10 million, or if you account for income tax on a cash
            basis. Check with your BAS agent if you're unsure.
          </p>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">BAS frequency</span>
            <select
              value={value.basCycle}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, basCycle: e.target.value === 'MONTHLY' ? 'MONTHLY' : 'QUARTERLY' })}
              className={inputClass}
            >
              <option value="QUARTERLY">Quarterly</option>
              <option value="MONTHLY">Monthly (required at $20 million GST turnover or more)</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">BAS reporting method</span>
            <select
              value={value.basMethod}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, basMethod: e.target.value === 'FULL' ? 'FULL' : 'SIMPLER' })}
              className={inputClass}
            >
              <option value="SIMPLER">Simpler BAS (G1, 1A, 1B): under $10 million GST turnover</option>
              <option value="FULL">Full reporting (adds G2, G3, G10, G11)</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}
