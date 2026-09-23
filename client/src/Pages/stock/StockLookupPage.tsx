import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { lookupStock, type StockLookupMatch } from '../../services/fetchServices';

const inputClass = 'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/** A scanned QR's payload — see labelService.ts's header on the server. */
const SCAN_URL_PATTERN = /\/app\/stock\/scan\/(item|lot|serial|location)\/([0-9a-f-]{36})\s*$/i;

/**
 * StockLedger's scan-and-lookup: one input that works equally well typed
 * by hand, pasted, or "typed" by a USB/Bluetooth keyboard-wedge scanner,
 * which sends the QR payload as keystrokes ending in Enter — an ordinary
 * form submit, no scanner-specific code needed.
 */
export default function StockLookupPage() {
  const navigate = useNavigate();
  const base = useAppBasePath();

  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<StockLookupMatch[] | null>(null);
  const [searchedQ, setSearchedQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  function navigateToMatch(match: StockLookupMatch) {
    if (match.kind === 'ITEM') {
      navigate(`${base}/items/${match.id}`);
    } else if (match.kind === 'LOCATION') {
      navigate(`${base}/locations?focus=${match.id}`);
    } else if (match.itemId !== null) {
      navigate(`${base}/items/${match.itemId}`);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = q.trim();
    if (trimmed === '') return;

    const scanMatch = SCAN_URL_PATTERN.exec(trimmed);
    if (scanMatch !== null) {
      navigate(`${base}/scan/${scanMatch[1] as string}/${scanMatch[2] as string}`);
      return;
    }

    try {
      const res = await lookupStock(trimmed);
      setSearchedQ(trimmed);
      setMatches(res.matches);
      if (res.matches.length === 1) navigateToMatch(res.matches[0] as StockLookupMatch);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not search');
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-lg font-semibold text-[var(--text)]">Lookup</h1>

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      <form onSubmit={(e) => void handleSubmit(e)}>
        <label htmlFor="stock-lookup-input" className="block text-sm text-[var(--text)] mb-1">
          Scan or type a code
        </label>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- a scan target needs the caret waiting, every time this page opens */}
        <input id="stock-lookup-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} className={inputClass} />
      </form>

      {matches !== null ? (
        matches.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing matches {searchedQ}</p>
        ) : matches.length > 1 ? (
          <ul className="space-y-1">
            {matches.map((m) => (
              <li key={`${m.kind}-${m.id}`}>
                <button type="button" onClick={() => navigateToMatch(m)} className="text-sm text-[var(--text)]">
                  {m.kind}: {m.code} — {m.title}
                </button>
              </li>
            ))}
          </ul>
        ) : null
      ) : null}
    </div>
  );
}
