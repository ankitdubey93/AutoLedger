import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { AlarmClock, Printer, Scale } from 'lucide-react';
import {
  ApiRequestError,
  getPublicStatement,
  getPublicStatementLogo,
  type PartyOpenItem,
  type PublicStatementView,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import StatementDocument from '../statements/StatementDocument';
import { secondaryButtonClass } from '../../components/ui/formClasses';

/**
 * The page an emailed statement links to (Phase 39b; payment 39c). Public:
 * no session, no app shell — the token in the URL is the only credential,
 * and the server resolves the organization from it.
 *
 * Left: who is asking (merchant name and logo), what is owed today, and the
 * open invoices — overdue ones flagged and pre-selected. Right: the payment
 * panel, rendered by `renderPayPanel` so the card form (39c) stays out of
 * this file. Below: the full statement as it was sent, printable.
 */

export interface PayPanelProps {
  token: string;
  view: PublicStatementView;
  selected: PartyOpenItem[];
  totalCents: number;
  currency: string | null;
  /** Called after a successful payment so the page reloads what is open. */
  onPaid: () => void;
}

export interface PublicStatementPageProps {
  /** Renders the right-hand pay panel when online payment is enabled. */
  renderPayPanel?: (props: PayPanelProps) => ReactNode;
}

function isInvoice(item: PartyOpenItem): boolean {
  return item.documentKind === 'INVOICE';
}

export default function PublicStatementPage({ renderPayPanel }: PublicStatementPageProps) {
  const { token = '' } = useParams<{ token: string }>();
  const [view, setView] = useState<PublicStatementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoSrc, setLogoSrc] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getPublicStatement(token, controller.signal)
      .then((next) => {
        setView(next);
        // Overdue invoices start selected — what the customer most likely came to pay.
        setSelected(new Set(next.current.items.filter((i) => isInvoice(i) && i.daysOverdue > 0).map((i) => i.documentId)));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiRequestError && err.status === 404
            ? 'This statement link is not valid or has expired. Please contact the sender for a new one.'
            : err instanceof Error
              ? err.message
              : 'Could not load the statement',
        );
      });
    return () => controller.abort();
  }, [token, reload]);

  useEffect(() => {
    if (view?.merchant.hasLogo !== true) return;
    const controller = new AbortController();
    let url: string | null = null;
    getPublicStatementLogo(token, controller.signal)
      .then((blob) => {
        if (blob === null || controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setLogoSrc(url);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [token, view?.merchant.hasLogo]);

  const invoices = view?.current.items.filter(isInvoice) ?? [];
  const chosen = invoices.filter((i) => selected.has(i.documentId));
  const currencies = new Set(chosen.map((i) => i.currencyCode));
  const totalCents = chosen.reduce((sum, i) => sum + i.baseOutstandingCents, 0);

  const onPaid = useCallback(() => {
    setReload((n) => n + 1);
  }, []);

  if (error !== null) {
    return (
      <main className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <p className="status status--bad max-w-md">{error}</p>
      </main>
    );
  }

  if (view === null) {
    return (
      <main className="min-h-screen bg-[var(--bg)] p-6" aria-busy="true">
        <div className="skeleton skeleton--card max-w-5xl mx-auto" />
      </main>
    );
  }

  const isCustomer = view.partyKind === 'CUSTOMER';
  const currency = view.merchant.baseCurrency;
  const canPay = isCustomer && view.payment.enabled && renderPayPanel !== undefined;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="no-print border-b border-[var(--border)] bg-[var(--panel)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          {logoSrc !== null && <img src={logoSrc} alt="" className="max-h-10 max-w-[8rem] object-contain" />}
          <div>
            <p className="m-0 font-semibold">{view.merchant.name}</p>
            <p className="m-0 text-xs text-[var(--muted)]">
              {isCustomer ? 'Statement and payment' : 'Statement of account'}
            </p>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="no-print flex flex-col gap-4 min-w-0">
          <div>
            <h1 className="text-xl font-semibold m-0">Hi {view.partyName}</h1>
            <p className="text-sm text-[var(--muted)] m-0 mt-1">
              {isCustomer
                ? `Here is what is open on your account with ${view.merchant.name} today.`
                : `Here is your account as recorded by ${view.merchant.name} today.`}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
              <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0 flex items-center gap-1.5">
                <Scale size={14} aria-hidden="true" /> {isCustomer ? 'Balance due' : 'Balance owed to you'}
              </p>
              <p className="text-lg font-semibold tabular-nums m-0" data-testid="balance-due">
                {formatCents(view.current.outstandingCents)} {currency}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
              <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0 flex items-center gap-1.5">
                <AlarmClock size={14} aria-hidden="true" /> Overdue
              </p>
              <p
                className={`text-lg font-semibold tabular-nums m-0 ${view.current.overdueCents > 0 ? 'text-[var(--bad)]' : ''}`}
                data-testid="overdue"
              >
                {formatCents(view.current.overdueCents)} {currency}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[32rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  {canPay && <th className="p-3 w-8" />}
                  <th className="p-3 font-medium">{isCustomer ? 'Invoice' : 'Bill'}</th>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Due</th>
                  <th className="p-3 font-medium text-right">Amount due</th>
                </tr>
              </thead>
              <tbody>
                {view.current.items.map((item) => (
                  <tr key={item.documentId} className="border-t border-[var(--border)]">
                    {canPay && (
                      <td className="p-3">
                        {isInvoice(item) && (
                          <input
                            type="checkbox"
                            aria-label={`Pay ${item.documentNumber ?? 'invoice'}`}
                            checked={selected.has(item.documentId)}
                            onChange={() => toggle(item.documentId)}
                          />
                        )}
                      </td>
                    )}
                    <td className="p-3">
                      {item.documentNumber ?? '—'}
                      {!isInvoice(item) && item.documentKind !== 'BILL' && (
                        <span className="text-[var(--muted)]"> (credit)</span>
                      )}
                    </td>
                    <td className="p-3 whitespace-nowrap">{formatDate(item.documentDate)}</td>
                    <td className="p-3 whitespace-nowrap">
                      {formatDate(item.dueDate)}
                      {item.daysOverdue > 0 && (
                        <span className="ml-2 rounded-full bg-[var(--bad-soft)] text-[var(--bad)] px-2 py-0.5 text-xs">
                          Overdue {item.daysOverdue} day{item.daysOverdue === 1 ? '' : 's'}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right tabular-nums">{formatCents(item.baseOutstandingCents)}</td>
                  </tr>
                ))}
                {view.current.items.length === 0 && (
                  <tr className="border-t border-[var(--border)]">
                    <td colSpan={canPay ? 5 : 4} className="p-4 text-center text-[var(--muted)]">
                      Nothing is outstanding. Thank you!
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="no-print lg:sticky lg:top-6 lg:self-start flex flex-col gap-3">
          {canPay ? (
            renderPayPanel({
              token,
              view,
              selected: chosen,
              totalCents,
              currency: currencies.size === 1 ? (chosen[0]?.currencyCode ?? null) : null,
              onPaid,
            })
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-2 text-sm">
              <p className="m-0 font-semibold">{isCustomer ? 'How to pay' : 'Questions?'}</p>
              {isCustomer && <p className="m-0 text-[var(--muted)]">Online payment isn't available for this account.</p>}
              {isCustomer && view.bankDetails !== null && <p className="m-0 whitespace-pre-line">{view.bankDetails}</p>}
              <p className="m-0 text-[var(--muted)]">Contact {view.merchant.name} with any questions about this statement.</p>
            </div>
          )}
          <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>
            <span className="inline-flex items-center gap-1.5">
              <Printer size={15} aria-hidden="true" /> Print statement
            </span>
          </button>
        </aside>

        <section className="lg:col-span-2 flex flex-col gap-2" aria-label="Statement">
          <h2 className="no-print text-base font-semibold m-0">Statement as sent</h2>
          <StatementDocument
            statement={view.statement}
            settings={view.settings}
            organizationName={view.merchant.name}
            orgAddressLines={view.merchant.addressLines}
            baseCurrency={currency}
            logoSrc={logoSrc}
            bankDetails={view.bankDetails}
          />
        </section>
      </div>
    </main>
  );
}
