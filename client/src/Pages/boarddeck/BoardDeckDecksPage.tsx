import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  createBoardDeckDeck,
  deleteBoardDeckDeck,
  downloadBoardDeckDeck,
  getBoardDeckDeck,
  getFiscalPeriods,
  listBoardDeckDecks,
  listForecasterPlans,
  retryBoardDeckDeck,
  type BoardDeckDeck,
  type FiscalPeriod,
  type ForecasterPlan,
} from '../../services/fetchServices';
import { useAuth } from '../../context/AuthContext';
import ConfirmDialog from '../../components/ConfirmDialog';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

const POLL_INTERVAL_MS = 3000;

/**
 * Generated board decks — a title, a fiscal period, and an optional plan. A
 * PENDING or GENERATING deck polls its own status every 3 seconds until it
 * leaves those states, and stops polling on unmount.
 *
 * Delete is OWNER/ADMIN only and HIDDEN (not merely disabled) for anyone
 * else, gated by ConfirmDialog — the posture UniteconSettingsPage
 * established for its own destructive action.
 */
export default function BoardDeckDecksPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canDelete = role === 'OWNER' || role === 'ADMIN';

  const [decks, setDecks] = useState<BoardDeckDeck[]>([]);
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [plans, setPlans] = useState<ForecasterPlan[]>([]);
  const [title, setTitle] = useState('');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [planId, setPlanId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  function reload() {
    setError(null);
    Promise.all([listBoardDeckDecks(), getFiscalPeriods(), listForecasterPlans()])
      .then(([decksRes, periodsRes, plansRes]) => {
        setDecks(decksRes.decks);
        setPeriods(periodsRes.periods);
        setPlans(plansRes.plans);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load decks'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timers = pollTimers.current;
    for (const deck of decks) {
      const inFlight = deck.status === 'PENDING' || deck.status === 'GENERATING';
      if (!inFlight || timers.has(deck.id)) continue;

      const poll = () => {
        getBoardDeckDeck(deck.id)
          .then((res) => {
            setDecks((prev) => prev.map((d) => (d.id === deck.id ? res.deck : d)));
            if (res.deck.status === 'PENDING' || res.deck.status === 'GENERATING') {
              const t = setTimeout(poll, POLL_INTERVAL_MS);
              timers.set(deck.id, t);
            } else {
              timers.delete(deck.id);
            }
          })
          .catch(() => {
            timers.delete(deck.id);
          });
      };
      const t = setTimeout(poll, POLL_INTERVAL_MS);
      timers.set(deck.id, t);
    }
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decks.map((d) => d.id).join(',')]);

  async function handleCreate() {
    if (title.trim() === '' || fiscalPeriodId === '') return;
    setCreating(true);
    setError(null);
    try {
      await createBoardDeckDeck({ title: title.trim(), fiscalPeriodId, planId: planId === '' ? null : planId });
      setTitle('');
      setFiscalPeriodId('');
      setPlanId('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create deck');
    } finally {
      setCreating(false);
    }
  }

  async function handleRetry(id: string) {
    setError(null);
    try {
      await retryBoardDeckDeck(id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not retry deck');
    }
  }

  async function handleDownload(deck: BoardDeckDeck) {
    setError(null);
    try {
      const { blob } = await downloadBoardDeckDeck(deck.id);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${deck.title}.pptx`;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download deck');
    }
  }

  async function handleConfirmDelete() {
    if (pendingDeleteId === null) return;
    setDeleting(true);
    try {
      await deleteBoardDeckDeck(pendingDeleteId);
      setPendingDeleteId(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete deck');
    } finally {
      setDeleting(false);
    }
  }

  const pendingDeleteDeck = decks.find((d) => d.id === pendingDeleteId) ?? null;

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Board decks</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Generate a .pptx board deck from a fiscal period's statements, close checklist, and optional budget
          variance.
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Fiscal period</span>
          <select value={fiscalPeriodId} onChange={(e) => setFiscalPeriodId(e.target.value)} className={inputClass}>
            <option value="">Select…</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fiscalYearLabel} — period {p.periodNumber}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Plan (optional)</span>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={inputClass}>
            <option value="">None</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={creating || title.trim() === '' || fiscalPeriodId === ''}
          onClick={handleCreate}
        >
          {creating ? 'Generating…' : 'Generate deck'}
        </button>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Title</th>
              <th className="p-3 font-medium">Period</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {decks.map((deck) => (
              <tr key={deck.id} className="border-t border-[var(--border)]">
                <td className="p-3">{deck.title}</td>
                <td className="p-3">
                  {deck.periodStartsOn} to {deck.periodEndsOn}
                </td>
                <td className="p-3">
                  {deck.status}
                  {deck.status === 'FAILED' && deck.errorMessage !== null && (
                    <span className="text-[var(--muted)]"> — {deck.errorMessage}</span>
                  )}
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    {deck.status === 'READY' && (
                      <button type="button" className="btn btn--ghost" onClick={() => handleDownload(deck)}>
                        Download
                      </button>
                    )}
                    {deck.status === 'FAILED' && (
                      <button type="button" className="btn btn--ghost" onClick={() => handleRetry(deck.id)}>
                        Retry
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        aria-label={`Delete ${deck.title}`}
                        className="btn btn--ghost"
                        onClick={() => setPendingDeleteId(deck.id)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {decks.length === 0 && (
              <tr>
                <td className="p-3 text-sm text-[var(--muted)]" colSpan={4}>
                  No decks generated yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pendingDeleteDeck !== null && (
        <ConfirmDialog
          title="Delete deck?"
          body={
            <>
              Deleting <strong>{pendingDeleteDeck.title}</strong> removes it permanently. This cannot be undone.
            </>
          }
          confirmLabel="Delete"
          tone="danger"
          busy={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </section>
  );
}
