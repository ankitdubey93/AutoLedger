import type { ImportKindMeta, MigrationImportInspection } from '../../../services/fetchServices';
import { inputClass } from '../../../components/ui/formClasses';

/** Human-readable blockers; empty = OK to stage. */
export function mappingProblems(meta: ImportKindMeta, value: Record<string, string | null>): string[] {
  const labelOf = (key: string): string => meta.columns.find((c) => c.key === key)?.label ?? key;
  const problems: string[] = [];

  for (const column of meta.columns) {
    if (column.required && (value[column.key] ?? null) === null) {
      problems.push(`${column.label} is required`);
    }
  }

  if (meta.requiredOneOf.length > 0) {
    const satisfied = meta.requiredOneOf.some((set) => set.every((key) => (value[key] ?? null) !== null));
    if (!satisfied) {
      problems.push(`Map ${meta.requiredOneOf.map((set) => set.map(labelOf).join(' and ')).join(', or ')}`);
    }
  }

  const uses = new Map<string, number>();
  for (const column of meta.columns) {
    const header = value[column.key] ?? null;
    if (header !== null) uses.set(header, (uses.get(header) ?? 0) + 1);
  }
  for (const [header, count] of uses) {
    if (count >= 2) problems.push(`"${header}" is used for more than one field`);
  }

  return problems;
}

export default function ColumnMapper({
  meta,
  inspection,
  value,
  onChange,
}: {
  meta: ImportKindMeta;
  inspection: MigrationImportInspection;
  value: Record<string, string | null>;
  onChange: (next: Record<string, string | null>) => void;
}) {
  function samples(header: string | null): string {
    if (header === null) return '—';
    const index = inspection.headers.indexOf(header);
    if (index < 0) return '—';
    const values = inspection.sampleRows
      .map((row) => row[index] ?? '')
      .filter((cell) => cell.trim() !== '')
      .slice(0, 3);
    return values.length === 0 ? '—' : values.join(' · ');
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[40rem]">
        <thead>
          <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
            <th className="p-2 font-medium">Our field</th>
            <th className="p-2 font-medium">Column in your file</th>
            <th className="p-2 font-medium">Sample values</th>
          </tr>
        </thead>
        <tbody>
          {meta.columns.map((column) => {
            const chosen = value[column.key] ?? null;
            return (
              <tr key={column.key} className="border-t border-[var(--border)] align-top">
                <td className="p-2">
                  <div>
                    {column.label}
                    {column.required && <span className="text-[var(--bad)]"> *</span>}
                  </div>
                  <div className="text-xs text-[var(--muted)]">{column.note}</div>
                </td>
                <td className="p-2">
                  <select
                    aria-label={`Column for ${column.label}`}
                    value={chosen ?? ''}
                    onChange={(e) => onChange({ ...value, [column.key]: e.target.value === '' ? null : e.target.value })}
                    className={inputClass}
                  >
                    <option value="">— Don't import —</option>
                    {inspection.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2 text-xs text-[var(--muted)]">{samples(chosen)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
