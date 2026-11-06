import type { GstHelpers } from '../context/useGst';

/** Phase 49b — replaces the free-typed tax rate on an Australian organization's document lines. */
export default function TaxCodeSelect({
  gst,
  value,
  onChange,
  label,
  className,
  emptyLabel = 'Default',
}: {
  emptyLabel?: string;
  gst: GstHelpers;
  value: string;
  onChange: (code: string) => void;
  label: string;
  className?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{emptyLabel}</option>
      {gst.codes.map((code) => (
        <option key={code.code} value={code.code}>
          {code.label}
        </option>
      ))}
    </select>
  );
}

/** Phase 49b — whether the prices typed on this document already include GST. */
export function TaxModeSelect({
  value,
  onChange,
  className,
}: {
  value: 'EXCLUSIVE' | 'INCLUSIVE';
  onChange: (mode: 'EXCLUSIVE' | 'INCLUSIVE') => void;
  className?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[var(--muted)]">Amounts are</span>
      <select
        aria-label="Amounts are"
        value={value}
        onChange={(e) => onChange(e.target.value === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE')}
        className={className}
      >
        <option value="EXCLUSIVE">Exclusive of GST</option>
        <option value="INCLUSIVE">Inclusive of GST</option>
      </select>
    </label>
  );
}
