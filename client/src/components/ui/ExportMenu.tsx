import { useState } from 'react';
import { Download } from 'lucide-react';
import { downloadReport, type ReportFormat } from '../../services/fetchServices';
import Menu, { type MenuItem } from './Menu';

/**
 * Export a report as PDF, Excel or CSV. The server renders the file from the
 * same query as the on-screen report, so the export and the page cannot drift.
 * Google Sheets has no separate path: it imports the .xlsx (or .csv) file.
 */
export default function ExportMenu({
  path,
  params,
  disabled = false,
}: {
  path: string;
  params: Record<string, string | null>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportAs(format: ReportFormat) {
    setBusy(true);
    setError(null);
    try {
      await downloadReport(path, params, format);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not export that report');
    } finally {
      setBusy(false);
    }
  }

  const items: MenuItem[] = [
    { label: 'PDF', onSelect: () => void exportAs('pdf') },
    { label: 'Excel (.xlsx)', onSelect: () => void exportAs('xlsx') },
    { label: 'CSV', onSelect: () => void exportAs('csv') },
    { type: 'separator' },
    { label: 'Google Sheets: File → Import the .xlsx', disabled: true },
  ];

  return (
    <div className="flex flex-col items-end gap-1">
      <Menu
        align="right"
        panelLabel="Export report"
        items={items}
        trigger={({ buttonProps }) => (
          <button
            {...buttonProps}
            type="button"
            disabled={busy || disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-sm text-[var(--text)] disabled:opacity-50"
          >
            <Download size={15} aria-hidden="true" />
            Export
          </button>
        )}
      />
      {error !== null && <p className="status status--bad">{error}</p>}
    </div>
  );
}
