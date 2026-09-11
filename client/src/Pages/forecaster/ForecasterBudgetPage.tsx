import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import {
  addForecasterBudgetLine,
  approveForecasterBudgetVersion,
  compileForecasterBudgetVersion,
  createForecasterBudgetVersion,
  deleteForecasterBudgetVersion,
  getForecasterBudgetVersion,
  listAccounts,
  listForecasterBudgetVersions,
  type Account,
  type ForecasterBudgetVersion,
  type ForecasterBudgetVersionDetail,
} from '../../services/fetchServices';
import { formatCents, parseCentsInput } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

const SOURCE_BADGE: Record<string, string> = {
  DRIVER: 'bg-sky-500/10 text-sky-300',
  HEADCOUNT: 'bg-violet-500/10 text-violet-300',
  MANUAL: 'bg-[var(--border)] text-[var(--muted)]',
};

/**
 * Zero-based budget versions on a plan. A version's editing controls —
 * compile, add line, edit, delete — are HIDDEN once it leaves DRAFT, not
 * merely disabled: an approved budget is a decision of record, frozen by
 * migration 039's trigger, and the UI should not invite an edit the server
 * will refuse.
 */
export default function ForecasterBudgetPage() {
  const { planId } = useParams<{ planId: string }>();
  const base = useAppBasePath();

  const [versions, setVersions] = useState<ForecasterBudgetVersion[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ForecasterBudgetVersionDetail | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [showNewVersion, setShowNewVersion] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);

  const [compiling, setCompiling] = useState(false);
  const [pendingApprove, setPendingApprove] = useState(false);
  const [approving, setApproving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [showLineForm, setShowLineForm] = useState(false);
  const [lineAccountId, setLineAccountId] = useState('');
  const [lineMonth, setLineMonth] = useState('');
  const [lineAmount, setLineAmount] = useState('');
  const [lineJustification, setLineJustification] = useState('');
  const [lineBusy, setLineBusy] = useState(false);

  useEffect(() => {
    if (planId === undefined) return;
    let ignore = false;
    listForecasterBudgetVersions(planId)
      .then((res) => {
        if (ignore) return;
        setVersions(res.versions);
        setSelectedId((current) => current ?? res.versions[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load budget versions');
      });
    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts.filter((a) => a.isPostable && a.isActive));
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [planId, reloadToken]);

  useEffect(() => {
    if (selectedId === null) return;
    let ignore = false;
    setDetail(null);
    getForecasterBudgetVersion(selectedId)
      .then((res) => {
        if (!ignore) setDetail(res.version);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the budget version');
      });
    return () => {
      ignore = true;
    };
  }, [selectedId, reloadToken]);

  if (planId === undefined) return null;

  async function handleCreateVersion(event: React.FormEvent) {
    event.preventDefault();
    if (planId === undefined) return;
    setCreating(true);
    try {
      const res = await createForecasterBudgetVersion(planId, { label: newLabel });
      setShowNewVersion(false);
      setNewLabel('');
      setSelectedId(res.version.id);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the budget version');
    } finally {
      setCreating(false);
    }
  }

  async function handleCompile() {
    if (selectedId === null) return;
    setCompiling(true);
    try {
      await compileForecasterBudgetVersion(selectedId);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not compile the budget');
    } finally {
      setCompiling(false);
    }
  }

  async function confirmApprove() {
    if (selectedId === null) return;
    setApproving(true);
    try {
      await approveForecasterBudgetVersion(selectedId);
      setPendingApprove(false);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not approve the budget');
    } finally {
      setApproving(false);
    }
  }

  async function confirmDelete() {
    if (selectedId === null) return;
    setDeleting(true);
    try {
      await deleteForecasterBudgetVersion(selectedId);
      setPendingDelete(false);
      setSelectedId(null);
      setDetail(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the budget version');
      setDeleting(false);
      setPendingDelete(false);
    }
  }

  async function handleAddLine(event: React.FormEvent) {
    event.preventDefault();
    if (selectedId === null) return;
    setLineBusy(true);
    try {
      const amountCents = parseCentsInput(lineAmount);
      if (amountCents === null) throw new Error('Enter an amount, e.g. 1000.00');
      await addForecasterBudgetLine(selectedId, {
        accountId: lineAccountId,
        month: `${lineMonth}-01`,
        amountCents,
        justification: lineJustification,
      });
      setShowLineForm(false);
      setLineJustification('');
      setLineAmount('');
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add the line');
    } finally {
      setLineBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/${planId}`} label="Back to plan" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <h2 className="text-lg font-semibold m-0">Budget versions</h2>
        {!showNewVersion ? (
          <button type="button" onClick={() => setShowNewVersion(true)} className="btn btn--ghost">
            New version
          </button>
        ) : (
          <form onSubmit={(e) => void handleCreateVersion(e)} className="flex items-center gap-2">
            <input
              type="text"
              required
              placeholder="Label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className={inputClass}
            />
            <button
              type="submit"
              disabled={creating || newLabel.trim() === ''}
              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              {creating ? '…' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowNewVersion(false)} className="btn btn--ghost">
              Cancel
            </button>
          </form>
        )}
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {versions === null && <p className="muted">Loading…</p>}
      {versions !== null && versions.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No budget versions yet — create one and compile it from the forecast.</p>
      )}

      {versions !== null && versions.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setSelectedId(v.id)}
              className={[
                'px-3 py-1.5 rounded-md text-sm border cursor-pointer flex items-center gap-1.5',
                v.id === selectedId
                  ? 'bg-[var(--text)] text-[var(--bg)] border-transparent'
                  : 'bg-transparent text-[var(--text)] border-[var(--border)]',
              ].join(' ')}
            >
              {v.status === 'APPROVED' && <CheckCircle2 size={13} aria-hidden="true" />}
              {v.label} · {v.status}
            </button>
          ))}
        </div>
      )}

      {detail !== null && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-[var(--muted)]">
              {detail.lineCount} lines · total {formatCents(detail.totalCents)}
              {detail.approvedByName !== null && ` · approved by ${detail.approvedByName}`}
            </span>
            {detail.status === 'DRAFT' && (
              <>
                <button
                  type="button"
                  disabled={compiling}
                  onClick={() => void handleCompile()}
                  className="btn btn--ghost"
                >
                  {compiling ? 'Compiling…' : 'Compile from forecast'}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingApprove(true)}
                  className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(true)}
                  className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-rose-500/10 text-rose-400"
                >
                  Delete
                </button>
              </>
            )}
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Account</th>
                  <th className="p-3 font-medium">Month</th>
                  <th className="p-3 font-medium">Source</th>
                  <th className="p-3 font-medium text-right">Amount</th>
                  <th className="p-3 font-medium">Justification</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.id} className="border-t border-[var(--border)]">
                    <td className="p-3">
                      {line.accountCode} {line.accountName}
                    </td>
                    <td className="p-3">{line.month.slice(0, 7)}</td>
                    <td className="p-3">
                      <span
                        className={['px-2 py-0.5 rounded text-xs font-medium', SOURCE_BADGE[line.source] ?? ''].join(
                          ' ',
                        )}
                      >
                        {line.source}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono">{formatCents(line.amountCents)}</td>
                    <td className="p-3 text-[var(--muted)]">{line.justification}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {detail.status === 'DRAFT' && (
            <div>
              {!showLineForm ? (
                <button type="button" onClick={() => setShowLineForm(true)} className="btn btn--ghost">
                  Add manual line
                </button>
              ) : (
                <form
                  onSubmit={(e) => void handleAddLine(e)}
                  className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
                >
                  <label className="flex flex-col gap-1 text-sm min-w-48">
                    <span className="text-[var(--muted)]">Account</span>
                    <select
                      required
                      value={lineAccountId}
                      onChange={(e) => setLineAccountId(e.target.value)}
                      className={inputClass}
                    >
                      <option value="" disabled>
                        Select an account
                      </option>
                      {(accounts ?? []).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm min-w-32">
                    <span className="text-[var(--muted)]">Month</span>
                    <input
                      type="month"
                      required
                      value={lineMonth}
                      onChange={(e) => setLineMonth(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm min-w-32">
                    <span className="text-[var(--muted)]">Amount</span>
                    <input
                      type="text"
                      required
                      inputMode="decimal"
                      placeholder="1000.00"
                      value={lineAmount}
                      onChange={(e) => setLineAmount(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm min-w-64 flex-1">
                    <span className="text-[var(--muted)]">Justification</span>
                    <input
                      type="text"
                      required
                      value={lineJustification}
                      onChange={(e) => setLineJustification(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={lineBusy || lineAccountId === '' || lineMonth === '' || lineJustification.trim() === ''}
                    className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
                  >
                    {lineBusy ? 'Saving…' : 'Add line'}
                  </button>
                  <button type="button" onClick={() => setShowLineForm(false)} className="btn btn--ghost">
                    Cancel
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      )}

      {pendingApprove && (
        <ConfirmDialog
          title="Approve this budget version?"
          body={
            <p className="m-0">
              Once approved, this version is frozen and becomes the plan&apos;s budget of record. Any currently
              approved version on this plan is superseded. This cannot be undone.
            </p>
          }
          confirmLabel="Approve"
          busy={approving}
          onConfirm={() => void confirmApprove()}
          onCancel={() => setPendingApprove(false)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this budget version?"
          body={<p className="m-0">This DRAFT version and every line on it will be removed.</p>}
          confirmLabel="Delete"
          tone="danger"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(false)}
        />
      )}
    </section>
  );
}
