import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import PageHeader from '../../components/ui/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import { formatCents } from '../../utils/money';
import {
  fetchInventoryValuation,
  postInventoryTrueUp,
  postInventoryReclass,
  postLinkAllStockItems,
  type InventoryValuation,
  type InventoryValuationAccount,
  type LinkAllResult,
} from '../../services/fetchServices';

/**
 * Phase 35a — inventory's reconciliation report: every control account's
 * stock subledger next to its general-ledger balance, with the three
 * corrective actions (true-up, reclass misplaced value, link-all) that close
 * a difference. Read-only for anyone; the three posting actions are gated
 * the same way `InventoryMovementsPage` gates posting a movement.
 */
export default function InventoryValuationPage() {
  const auth = useAuth();
  const currency = auth.status === 'authenticated' ? (auth.organization?.baseCurrency ?? '') : '';
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';

  const [valuation, setValuation] = useState<InventoryValuation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [trueUpTarget, setTrueUpTarget] = useState<InventoryValuationAccount | null>(null);
  const [trueUpBusy, setTrueUpBusy] = useState(false);
  const [trueUpError, setTrueUpError] = useState<string | null>(null);

  const [reclassBusy, setReclassBusy] = useState(false);
  const [reclassError, setReclassError] = useState<string | null>(null);

  const [linkAllBusy, setLinkAllBusy] = useState(false);
  const [linkAllError, setLinkAllError] = useState<string | null>(null);
  const [linkAllResult, setLinkAllResult] = useState<LinkAllResult | null>(null);

  useEffect(() => {
    let ignore = false;
    fetchInventoryValuation()
      .then((res) => {
        if (!ignore) setValuation(res.valuation);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the inventory valuation');
      });
    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  function reload() {
    setReloadToken((t) => t + 1);
  }

  function accountLabel(accountId: string): string {
    const account = valuation?.accounts.find((a) => a.accountId === accountId);
    return account !== undefined ? `${account.code} ${account.name}` : accountId;
  }

  async function confirmTrueUp() {
    if (trueUpTarget === null) return;
    setTrueUpBusy(true);
    setTrueUpError(null);
    try {
      await postInventoryTrueUp({ accountId: trueUpTarget.accountId, expectedDifferenceCents: trueUpTarget.differenceCents });
      setTrueUpTarget(null);
      reload();
    } catch (err: unknown) {
      setTrueUpError(err instanceof Error ? err.message : 'Could not post the true-up');
    } finally {
      setTrueUpBusy(false);
    }
  }

  async function handleReclass() {
    setReclassBusy(true);
    setReclassError(null);
    try {
      await postInventoryReclass();
      reload();
    } catch (err: unknown) {
      setReclassError(err instanceof Error ? err.message : 'Could not move the misplaced value');
    } finally {
      setReclassBusy(false);
    }
  }

  async function handleLinkAll() {
    setLinkAllBusy(true);
    setLinkAllError(null);
    try {
      const res = await postLinkAllStockItems();
      setLinkAllResult(res.result);
      reload();
    } catch (err: unknown) {
      setLinkAllError(err instanceof Error ? err.message : 'Could not link the items');
    } finally {
      setLinkAllBusy(false);
    }
  }

  const differingCount = valuation !== null ? valuation.accounts.filter((a) => a.differenceCents !== 0).length : 0;

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        icon={Scale}
        title="Inventory valuation"
        subtitle="Stock value compared with the general ledger, account by account."
      />

      {error !== null && (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      )}

      {valuation === null && error === null && <p className="muted">Loading…</p>}

      {valuation !== null && (
        <>
          <div
            className={`rounded-lg px-4 py-3 text-sm font-medium ${
              valuation.tiesOut ? 'bg-[var(--good-soft)] text-[var(--good)]' : 'bg-[var(--warn-soft)] text-[var(--warn)]'
            }`}
          >
            {valuation.tiesOut
              ? 'Stock ties to the general ledger.'
              : `${differingCount} account(s) differ from stock, or value sits on an old account.`}
          </div>

          {valuation.accounts.length === 0 ? (
            <p className="muted">No inventory accounts yet — add an inventory product or record stock to see them here.</p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[48rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Account</th>
                    <th className="p-3 font-medium text-right">Stock value</th>
                    <th className="p-3 font-medium text-right">General ledger</th>
                    <th className="p-3 font-medium text-right">Difference</th>
                    <th className="p-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {valuation.accounts.map((account) => (
                    <Fragment key={account.accountId}>
                      <tr className="border-t border-[var(--border)]">
                        <td className="p-3">
                          <Link to={`/accounts/${account.accountId}`}>
                            {account.code} {account.name}
                          </Link>
                        </td>
                        <td className="p-3 text-right font-mono">
                          {formatCents(account.subledgerCents)} <span className="text-xs text-[var(--muted)]">{currency}</span>
                        </td>
                        <td className="p-3 text-right font-mono">
                          {formatCents(account.glCents)} <span className="text-xs text-[var(--muted)]">{currency}</span>
                        </td>
                        <td
                          className={`p-3 text-right font-mono ${account.differenceCents !== 0 ? 'text-[var(--bad)]' : ''}`}
                        >
                          {formatCents(account.differenceCents)} <span className="text-xs text-[var(--muted)]">{currency}</span>
                        </td>
                        <td className="p-3 text-right">
                          {account.differenceCents !== 0 && canWrite ? (
                            <button
                              type="button"
                              onClick={() => {
                                setTrueUpError(null);
                                setTrueUpTarget(account);
                              }}
                              className="btn btn--ghost"
                            >
                              True up
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {account.differenceCents !== 0 && account.unexplainedLines.length > 0 ? (
                        <tr className="border-t border-[var(--border)]">
                          <td colSpan={5} className="p-3 bg-[var(--panel-2)]">
                            <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0 mb-1.5">
                              Entries not from stock
                            </p>
                            <ul className="m-0 pl-0 list-none space-y-1">
                              {account.unexplainedLines.map((line) => (
                                <li key={line.journalEntryId} className="text-sm flex flex-wrap items-center gap-2">
                                  <Link to={`/journals/${line.journalEntryId}`}>{line.entryDate}</Link>
                                  <span className="text-[var(--text)]">{line.description ?? '(no description)'}</span>
                                  <span className="text-[var(--muted)]">{line.sourceType}</span>
                                  <span className="font-mono">
                                    {formatCents(line.netDebitCents)} {currency}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {valuation.misplaced.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold m-0">Value on an old account</h3>
              {reclassError !== null && (
                <p role="alert" className="text-sm text-[var(--bad)]">
                  {reclassError}
                </p>
              )}
              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
                <table className="w-full border-collapse text-sm min-w-[36rem]">
                  <thead>
                    <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                      <th className="p-3 font-medium">Item</th>
                      <th className="p-3 font-medium">Sitting on</th>
                      <th className="p-3 font-medium">Current account</th>
                      <th className="p-3 font-medium text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valuation.misplaced.map((item) => (
                      <tr key={`${item.stockItemId}-${item.accountId}`} className="border-t border-[var(--border)]">
                        <td className="p-3">
                          {item.itemCode} — {item.itemName}
                        </td>
                        <td className="p-3">{accountLabel(item.accountId)}</td>
                        <td className="p-3">{accountLabel(item.currentAccountId)}</td>
                        <td className="p-3 text-right font-mono">
                          {formatCents(item.valueCents)} <span className="text-xs text-[var(--muted)]">{currency}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canWrite && (
                <div>
                  <button
                    type="button"
                    onClick={() => void handleReclass()}
                    disabled={reclassBusy}
                    className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
                  >
                    {reclassBusy ? 'Moving…' : 'Move to current accounts'}
                  </button>
                </div>
              )}
            </section>
          )}

          {valuation.unlinkedItemCount > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold m-0">Items not linked to Products &amp; Services</h3>
              <p className="muted m-0">
                {valuation.unlinkedItemCount} items holding {formatCents(valuation.unlinkedValueCents)} {currency} post
                nothing to the ledger.
              </p>
              {linkAllError !== null && (
                <p role="alert" className="text-sm text-[var(--bad)]">
                  {linkAllError}
                </p>
              )}
              {linkAllResult !== null && (
                <div className="text-sm">
                  <p className="text-[var(--good)] m-0">Linked {linkAllResult.linkedCount} item(s).</p>
                  {linkAllResult.failures.length > 0 && (
                    <ul className="m-0 pl-0 list-none space-y-0.5 mt-1">
                      {linkAllResult.failures.map((failure) => (
                        <li key={failure.stockItemId} className="text-[var(--bad)]">
                          {failure.code} — {failure.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {canWrite && (
                <div>
                  <button
                    type="button"
                    onClick={() => void handleLinkAll()}
                    disabled={linkAllBusy}
                    className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
                  >
                    {linkAllBusy ? 'Linking…' : 'Link all'}
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {trueUpTarget !== null && (
        <ConfirmDialog
          title={`True up ${trueUpTarget.code}?`}
          body={
            <div className="flex flex-col gap-2">
              <p className="m-0">
                Posts a journal dated today that moves the general ledger to the stock value:{' '}
                <strong>{formatCents(trueUpTarget.differenceCents)}</strong> against your inventory-adjustments account.
                The entries that caused the difference stay in the ledger.
              </p>
              {trueUpError !== null && (
                <p role="alert" className="m-0 text-[var(--bad)]">
                  {trueUpError}
                </p>
              )}
            </div>
          }
          confirmLabel="True up"
          busy={trueUpBusy}
          onConfirm={() => void confirmTrueUp()}
          onCancel={() => {
            setTrueUpTarget(null);
            setTrueUpError(null);
          }}
        />
      )}
    </section>
  );
}
