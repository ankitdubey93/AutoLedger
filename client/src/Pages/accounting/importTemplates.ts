import type { ImportKindMeta, MigrationImportKind } from '../../services/fetchServices';

/**
 * CSV-quotes a single field — wraps in double quotes and doubles any embedded
 * quote whenever the value contains a comma, quote or newline. Exported so
 * `ConversionBalancesPage` (Phase 30) can build its own CSV body with the same
 * quoting rule rather than writing a second escaper.
 */
export function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Header row = inTemplate columns' `header`; second row = their `example`. Trailing newline. */
export function templateCsv(meta: ImportKindMeta): string {
  const headers = meta.columns
    .filter((c) => c.inTemplate)
    .map((c) => csvField(c.header))
    .join(',');
  const examples = meta.columns
    .filter((c) => c.inTemplate)
    .map((c) => csvField(c.example))
    .join(',');
  return `${headers}\n${examples}\n`;
}

export function templateFileName(kind: MigrationImportKind): string {
  return `autoledger-${kind.toLowerCase().replace(/_/g, '-')}-template.csv`;
}
