import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createMigrationImport, type MigrationImportKind } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';

/**
 * Stages a new chart-of-accounts or opening-balance CSV (Phase 9b).
 *
 * The CSV's text goes straight into the JSON body — never a multipart
 * upload — the same shape `BankImportPage` uses, and for the same reason:
 * file storage belongs to a later phase, not this one.
 */

const MAX_CSV_CHARS = 900_000;

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

export default function NewMigrationImportPage() {
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [kind, setKind] = useState<MigrationImportKind>('CHART_OF_ACCOUNTS');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function handleFile(file: File) {
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (text.length > MAX_CSV_CHARS) {
        setError('That file is too large to import.');
        setContent('');
        return;
      }
      setContent(text);
    };
    reader.onerror = () => {
      setError('Could not read that file.');
    };
    reader.readAsText(file);
  }

  const canSubmit = fileName.trim() !== '' && content !== '' && !busy;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);

    try {
      const res = await createMigrationImport({ kind, fileName: fileName.trim(), content });
      navigate(`${base}/migration-imports/${res.import.id}`, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not stage the import');
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 max-w-2xl">
      <BackLink to={`${base}/migration-imports`} label="Back to imports" />

      <header>
        <h2 className="text-lg font-semibold m-0">New import</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Every row stages, good and bad — fix what's wrong before committing.
        </p>
      </header>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">What are you importing?</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as MigrationImportKind)}
            className={inputClass}
          >
            <option value="CHART_OF_ACCOUNTS">Chart of accounts</option>
            <option value="OPENING_BALANCES">Opening balances</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) handleFile(file);
            }}
            className={inputClass}
          />
        </label>

        {content !== '' && (
          <p className="text-xs text-[var(--muted)] m-0">
            {fileName} loaded ({content.length.toLocaleString()} characters).
          </p>
        )}

        {error !== null && <p className="status status--bad">{error}</p>}

        <div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Staging…' : 'Stage import'}
          </button>
        </div>
      </form>
    </section>
  );
}
