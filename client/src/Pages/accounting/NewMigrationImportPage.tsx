import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import {
  createMigrationImport,
  inspectMigrationImport,
  type ImportDateFormat,
  type MigrationImportInspection,
  type MigrationImportKind,
} from '../../services/fetchServices';
import { templateCsv, templateFileName } from './importTemplates';
import { safeReturnTo } from '../../utils/safeReturnTo';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';
import ColumnMapper, { mappingProblems } from './imports/ColumnMapper';
import ImportGuidePanel from './imports/ImportGuidePanel';
import ImportSteps from './imports/ImportSteps';
import { useImportKinds } from './imports/useImportKinds';

/**
 * The import wizard's first two steps: Upload, then Map columns (Phase 9b;
 * rebuilt Phase 36a). Templates, columns and notes all come from the server's
 * kind registry (`GET /migration-imports/kinds`), so this page holds no
 * per-kind knowledge. The file is inspected (nothing persisted) before it is
 * staged, so a mismatched header row can be mapped by hand.
 *
 * The CSV's text goes straight into the JSON body — never a multipart
 * upload — the same shape `BankImportPage` uses.
 */

const MAX_CSV_CHARS = 900_000;

export default function NewMigrationImportPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { kinds, error: kindsError } = useImportKinds();

  const kindParam = params.get('kind');
  const returnTo = safeReturnTo(params.get('returnTo'));

  const [kindState, setKindState] = useState<MigrationImportKind | null>(null);
  const [stage, setStage] = useState<'upload' | 'map'>('upload');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [inspection, setInspection] = useState<MigrationImportInspection | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [showMapper, setShowMapper] = useState(false);
  const [dateFormat, setDateFormat] = useState<ImportDateFormat | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (kindsError !== null) return <p className="status status--bad">{kindsError}</p>;
  if (kinds === null) return <LoadingState />;

  const locked = kinds.find((k) => k.kind === kindParam);
  const kind: MigrationImportKind = kindState ?? locked?.kind ?? 'CHART_OF_ACCOUNTS';
  const meta = kinds.find((k) => k.kind === kind);
  if (meta === undefined) return <p className="status status--bad">Unknown import kind.</p>;

  function downloadTemplate() {
    if (meta === undefined) return;
    const blob = new Blob([templateCsv(meta)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = templateFileName(kind);
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

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
      inspectMigrationImport({ kind, content: text })
        .then((res) => {
          setInspection(res.inspection);
          setMapping(res.inspection.suggestedMap);
          setShowMapper(!res.inspection.exactMatch);
          setDateFormat(res.inspection.suggestedDateFormat ?? '');
          setStage('map');
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Could not read that file');
        });
    };
    reader.onerror = () => {
      setError('Could not read that file.');
    };
    reader.readAsText(file);
  }

  function backToUpload() {
    setStage('upload');
    setContent('');
    setInspection(null);
    setError(null);
  }

  const hasDates = meta.columns.some((c) => c.type === 'date');
  const problems = stage === 'map' ? mappingProblems(meta, mapping) : [];
  if (stage === 'map' && hasDates && dateFormat === '') problems.push('Choose the date format your file uses');

  async function handleStage() {
    if (busy || problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createMigrationImport({
        kind,
        fileName: fileName.trim(),
        content,
        columnMap: showMapper ? mapping : null,
        ...(hasDates && dateFormat !== '' ? { dateFormat } : {}),
      });
      const suffix = returnTo !== null ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
      navigate(`/migration-imports/${res.import.id}${suffix}`, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not stage the import');
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={returnTo ?? '/migration-imports'} label={returnTo !== null ? 'Back' : 'Back to imports'} />
      <ImportSteps current={stage === 'upload' ? 1 : 2} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-4">
          <header>
            <h2 className="text-lg font-semibold m-0">
              {locked !== undefined ? `Import ${meta.label.toLowerCase()}` : 'New import'}
            </h2>
            <p className="text-sm text-[var(--muted)] m-0 mt-1">
              Every row stages, good and bad — fix what's wrong before committing.
            </p>
          </header>

          {stage === 'upload' && (
            <>
              {locked === undefined && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">What are you importing?</span>
                  <select
                    value={kind}
                    onChange={(e) => {
                      const next = kinds.find((k) => k.kind === e.target.value);
                      if (next !== undefined) setKindState(next.kind);
                    }}
                    className={inputClass}
                  >
                    {kinds.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-sm font-medium m-0">{`${meta.label} template`}</h3>
                  <button
                    type="button"
                    onClick={downloadTemplate}
                    className="flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border-0 cursor-pointer p-0"
                  >
                    <Download size={14} aria-hidden="true" /> Download template
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="text-left text-[var(--muted)] uppercase tracking-wide">
                        <th className="py-1 pr-3 font-medium">Column</th>
                        <th className="py-1 pr-3 font-medium">Required</th>
                        <th className="py-1 font-medium">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meta.columns.map((column) => (
                        <tr key={column.key} className="border-t border-[var(--border)]">
                          <td className="py-1 pr-3">{column.header}</td>
                          <td className="py-1 pr-3">{column.required ? 'Yes' : 'No'}</td>
                          <td className="py-1 text-[var(--muted)]">{column.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-[var(--muted)] m-0">
                  Headings starting with * are required. Keep headings unchanged to skip the mapping step.
                </p>
              </div>

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
            </>
          )}

          {stage === 'map' && inspection !== null && (
            <>
              <p className="text-sm m-0">
                {`${fileName} · ${String(inspection.rowCount)} row(s)`}
              </p>

              {hasDates && (
                <label className="flex flex-col gap-1 text-sm max-w-xs">
                  <span className="text-[var(--muted)]">Date format in your file</span>
                  <select
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value as ImportDateFormat | '')}
                    className={inputClass}
                  >
                    <option value="">Choose…</option>
                    <option value="ISO">YYYY-MM-DD</option>
                    <option value="DMY">DD/MM/YYYY</option>
                    <option value="MDY">MM/DD/YYYY</option>
                  </select>
                </label>
              )}

              {!showMapper ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <p className="status status--good m-0">
                    {`Every column matches the ${meta.label.toLowerCase()} template.`}
                  </p>
                  <button type="button" className="btn btn--ghost" onClick={() => setShowMapper(true)}>
                    Review column mapping
                  </button>
                </div>
              ) : (
                <ColumnMapper meta={meta} inspection={inspection} value={mapping} onChange={setMapping} />
              )}

              {problems.length > 0 && (
                <ul className="status status--bad">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-3">
                <button type="button" className={secondaryButtonClass} onClick={backToUpload}>
                  Choose a different file
                </button>
                <button
                  type="button"
                  className={primaryButtonClass}
                  disabled={problems.length > 0 || busy}
                  onClick={() => void handleStage()}
                >
                  {busy ? 'Staging…' : 'Stage import'}
                </button>
              </div>
            </>
          )}

          {error !== null && <p className="status status--bad">{error}</p>}
        </div>

        <ImportGuidePanel kind={kind} />
      </div>
    </section>
  );
}
