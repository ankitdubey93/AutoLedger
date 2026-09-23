import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { buildStockLabels, lookupStock, type StockLabel, type StockLabelKind, type StockLookupMatch } from '../../services/fetchServices';

const inputClass = 'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

const SIZE_OPTIONS = [
  { value: 'label-sm', label: 'Small 38 × 25 mm' },
  { value: 'label-md', label: 'Medium 50 × 30 mm' },
  { value: 'label-lg', label: 'Large 100 × 50 mm' },
] as const;
type SizeClass = (typeof SIZE_OPTIONS)[number]['value'];

interface TargetEntry {
  kind: StockLabelKind;
  id: string;
  copies: number;
  displayLabel: string;
}

/**
 * StockLedger's QR label sheet. Targets arrive from router state (a "Print
 * label(s)" action elsewhere in the app) or are added here by searching.
 * The QR renders as `<img src="data:image/svg+xml...">`, never
 * `dangerouslySetInnerHTML` — an `<img>` cannot execute script even if the
 * SVG payload were somehow hostile.
 */
export default function StockLabelsPage() {
  const location = useLocation();
  const initialTargets =
    (location.state as { targets?: { kind: StockLabelKind; id: string; copies: number }[] } | null)?.targets ?? [];

  const [targets, setTargets] = useState<TargetEntry[]>(initialTargets.map((t) => ({ ...t, displayLabel: t.id })));
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<StockLookupMatch[]>([]);
  const [sizeClass, setSizeClass] = useState<SizeClass>('label-md');
  const [labels, setLabels] = useState<StockLabel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  function handleSearchChange(q: string) {
    setSearch(q);
    if (q.trim() === '') {
      setSearchResults([]);
      return;
    }
    lookupStock(q)
      .then((res) => setSearchResults(res.matches.filter((m) => m.kind === 'ITEM' || m.kind === 'LOCATION')))
      .catch(() => undefined);
  }

  function addTarget(match: StockLookupMatch) {
    setTargets((current) => [...current, { kind: match.kind, id: match.id, copies: 1, displayLabel: `${match.code} — ${match.title}` }]);
    setSearch('');
    setSearchResults([]);
  }

  function updateCopies(index: number, copies: number) {
    setTargets((current) => current.map((t, i) => (i === index ? { ...t, copies } : t)));
  }

  function removeTarget(index: number) {
    setTargets((current) => current.filter((_, i) => i !== index));
  }

  async function handleGenerate() {
    setError(null);
    setGenerating(true);
    try {
      const res = await buildStockLabels(targets.map(({ kind, id, copies }) => ({ kind, id, copies })));
      setLabels(res.labels);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate labels');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text)] no-print">Labels</h1>

      <div className="no-print space-y-4">
        {error !== null ? (
          <p role="alert" className="text-sm text-[var(--bad)]">
            {error}
          </p>
        ) : null}

        <div>
          <input
            aria-label="Add item or location"
            placeholder="Search items or locations"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className={`${inputClass} w-full`}
          />
          {searchResults.length > 0 ? (
            <ul className="mt-1 border border-[var(--border)] rounded-md divide-y divide-[var(--border)]">
              {searchResults.map((m) => (
                <li key={`${m.kind}-${m.id}`}>
                  <button type="button" onClick={() => addTarget(m)} className="w-full text-left px-2.5 py-1.5 text-sm text-[var(--text)]">
                    {m.kind}: {m.code} — {m.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <ul className="space-y-1">
          {targets.map((t, i) => (
            <li key={`${t.kind}-${t.id}`} className="flex items-center gap-2 text-sm">
              <span className="text-[var(--text)]">
                {t.kind}: {t.displayLabel}
              </span>
              <label className="text-sm text-[var(--text)]">
                Copies
                <input
                  aria-label={`Copies for ${t.displayLabel}`}
                  type="number"
                  min={1}
                  max={100}
                  value={t.copies}
                  onChange={(e) => updateCopies(i, Number(e.target.value))}
                  className={`${inputClass} w-16 ml-1`}
                />
              </label>
              <button type="button" onClick={() => removeTarget(i)} className="text-xs text-[var(--muted)]">
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <label className="text-sm text-[var(--text)]">
            Size
            <select aria-label="Label size" value={sizeClass} onChange={(e) => setSizeClass(e.target.value as SizeClass)} className={`${inputClass} ml-1`}>
              {SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={targets.length === 0 || generating}
            onClick={() => void handleGenerate()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            Generate
          </button>
          {labels !== null ? (
            <button type="button" onClick={() => window.print()} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]">
              Print
            </button>
          ) : null}
        </div>
      </div>

      {labels !== null ? (
        <div className="label-sheet grid grid-cols-3 gap-4">
          {labels.flatMap((label) =>
            Array.from({ length: label.copies }, (_, copyIndex) => (
              <div key={`${label.kind}-${label.id}-${copyIndex}`} className={`label border border-[var(--border)] p-2 flex flex-col justify-center gap-1 ${sizeClass}`}>
                <img
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(label.qrSvg)}`}
                  alt={`QR code for ${label.code}`}
                  className="w-16 h-16"
                />
                <p className="font-mono font-bold text-sm m-0">{label.code}</p>
                <p className="text-sm m-0">{label.title}</p>
                <p className="text-xs text-[var(--muted)] m-0">{label.subtitle}</p>
              </div>
            )),
          )}
        </div>
      ) : null}
    </div>
  );
}
