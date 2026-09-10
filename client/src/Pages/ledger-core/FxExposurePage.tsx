import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getFxExposure, runFxRevaluation, type FxExposureReport } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { formatCents } from './money';
import ConfirmDialog from './ConfirmDialog';

/**
 * Period-end FX exposure preview — Phase 8. Read-only: this page never posts
 * anything by itself. "Post revaluation" is the one action here, and it is
 * irreversible in the sense that matters to a user (it posts a real GL
 * entry), so it is the only control gated by a confirmation dialog.
 */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

export default function FxExposurePage() {
  const base = useAppBasePath();
  const [asOf, setAsOf] = useState(today);
  const [report, setReport] = useState<FxExposureReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postedId, setPostedId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let ignore = false;
    setReport(null);
    setPostedId(null);
    getFxExposure(asOf)
      .then((res) => {
        if (!ignore) setReport(res.exposure);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load FX exposure');
      });
    return () => {
      ignore = true;
    };
  }, [asOf, reloadToken]);

  async function confirmPost() {
    setPosting(true);
    setError(null);
    try {
      const res = await runFxRevaluation(asOf);
      setPostedId(res.revaluation.id);
      setConfirming(false);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not post the revaluation');
    } finally {
      setPosting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">FX exposure</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Open foreign-currency invoices and bills, restated at the as-of exchange rate. Nothing here is
          posted until you choose to.
        </p>
      </header>

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">As of</span>
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={inputClass} />
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}

      {report === null && error === null && <p className="muted">Loading…</p>}

      {report !== null && (
        <>
          {postedId !== null ? (
            <p className="status status--good">
              Revaluation posted.{' '}
              <Link to={`${base}/fx-revaluations/${postedId}`}>View it</Link>.
            </p>
          ) : report.alreadyRevalued ? (
            <p className="text-sm text-[var(--muted)]">
              This date has already been revalued. See <Link to={`${base}/fx-revaluations`}>Revaluations</Link>.
            </p>
          ) : report.documents.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
              >
                Post revaluation
              </button>
            </div>
          ) : null}

          {report.byCurrency.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[36rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Currency</th>
                    <th className="p-3 font-medium text-right">Outstanding</th>
                    <th className="p-3 font-medium text-right">Carrying value</th>
                    <th className="p-3 font-medium text-right">Revalued value</th>
                    <th className="p-3 font-medium text-right">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byCurrency.map((row) => (
                    <tr key={row.currencyCode} className="border-t border-[var(--border)]">
                      <td className="p-3">{row.currencyCode}</td>
                      <td className="p-3 text-right font-mono">{formatCents(row.outstandingCents)}</td>
                      <td className="p-3 text-right font-mono">{formatCents(row.carryingBaseCents)}</td>
                      <td className="p-3 text-right font-mono">{formatCents(row.revaluedBaseCents)}</td>
                      <td className={`p-3 text-right font-mono ${row.deltaCents < 0 ? 'text-red-500' : ''}`}>
                        {formatCents(row.deltaCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[var(--border)] font-medium">
                    <td className="p-3">Total</td>
                    <td className="p-3" />
                    <td className="p-3" />
                    <td className="p-3" />
                    <td className="p-3 text-right font-mono">{formatCents(report.totalDeltaCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {report.documents.length === 0 && (
            <p className="text-sm text-[var(--muted)]">No open foreign-currency balance as of {asOf}.</p>
          )}

          {report.documents.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[48rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Document</th>
                    <th className="p-3 font-medium">Counterparty</th>
                    <th className="p-3 font-medium">Currency</th>
                    <th className="p-3 font-medium text-right">Outstanding</th>
                    <th className="p-3 font-medium text-right">Document rate</th>
                    <th className="p-3 font-medium text-right">Revaluation rate</th>
                    <th className="p-3 font-medium text-right">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {report.documents.map((doc) => (
                    <tr key={`${doc.documentType}-${doc.documentId}`} className="border-t border-[var(--border)]">
                      <td className="p-3">
                        {doc.documentType === 'INVOICE' ? 'Invoice' : 'Bill'} {doc.documentNumber ?? ''}
                      </td>
                      <td className="p-3">{doc.counterpartyName}</td>
                      <td className="p-3">{doc.currencyCode}</td>
                      <td className="p-3 text-right font-mono">{formatCents(doc.outstandingCents)}</td>
                      <td className="p-3 text-right font-mono">{doc.documentRate}</td>
                      <td className="p-3 text-right font-mono">{doc.revaluationRate}</td>
                      <td className={`p-3 text-right font-mono ${doc.deltaCents < 0 ? 'text-red-500' : ''}`}>
                        {formatCents(doc.deltaCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {confirming && report !== null && (
        <ConfirmDialog
          title="Post this revaluation?"
          body={
            <p className="m-0">
              An entry dated {asOf} will restate open foreign-currency balances by{' '}
              <strong>{formatCents(report.totalDeltaCents)}</strong> through Unrealized FX Gain/Loss, and an
              automatic reversal will post the following day. There is no undo — a wrong revaluation is
              corrected by posting the next one, not by editing this one.
            </p>
          }
          confirmLabel="Post revaluation"
          busy={posting}
          onConfirm={() => void confirmPost()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
