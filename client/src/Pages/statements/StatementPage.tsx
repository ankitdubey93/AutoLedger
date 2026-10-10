import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Mail, Printer } from 'lucide-react';
import {
  ApiRequestError,
  getPartyStatement,
  listStatementSends,
  revokeStatementSend,
  statementQuery,
  type PartyKind,
  type PartyStatement,
  type StatementSend,
} from '../../services/fetchServices';
import { useCan } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';
import SendStatementDialog from '../../components/statements/SendStatementDialog';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import { primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';
import StatementDocument from './StatementDocument';
import { PATH_FOR_KIND, StatementControls, useStatementParams } from './statementParams';
import { useStatementBranding } from './useStatementBranding';

/**
 * One party's statement (Phase 39a): the type/date toolbar, the printable
 * document, Print. The toolbar carries `no-print`, so printing prints only
 * the document.
 */
export default function StatementPage({ kind }: { kind: PartyKind }) {
  const { partyId } = useParams<{ partyId: string }>();
  const path = PATH_FOR_KIND[kind];
  const branding = useStatementBranding();
  const state = useStatementParams(branding.settings?.defaultType ?? 'OUTSTANDING');
  const query = statementQuery(state.request);

  const [statement, setStatement] = useState<PartyStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [sends, setSends] = useState<StatementSend[] | null>(null);
  const [sendsToken, setSendsToken] = useState(0);
  const can = useCan();

  useEffect(() => {
    if (partyId === undefined) return;
    let ignore = false;
    listStatementSends(path, partyId)
      .then((list) => {
        if (!ignore) setSends(list);
      })
      .catch(() => {
        if (!ignore) setSends([]);
      });
    return () => {
      ignore = true;
    };
  }, [path, partyId, sendsToken]);

  async function revoke(id: string) {
    await revokeStatementSend(id);
    setSendsToken((t) => t + 1);
  }

  useEffect(() => {
    if (partyId === undefined || !branding.ready) return;
    const controller = new AbortController();
    setStatement(null);
    setError(null);
    getPartyStatement(path, partyId, state.request, controller.signal)
      .then(setStatement)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setError(kind === 'CUSTOMER' ? 'Customer not found.' : 'Vendor not found.');
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the statement');
        }
      });
    return () => controller.abort();
    // `query` is the request's stable serialisation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, partyId, query, branding.ready, kind]);

  return (
    <section className="flex flex-col gap-4">
      <div className="no-print flex flex-col gap-3">
        <BackLink to={`/statements/${path}?${query}`} label="Back to statements" />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <StatementControls state={state} />
          <div className="flex flex-wrap gap-2">
            {partyId !== undefined && (
              <Link to={`/${path}/${partyId}`} className={secondaryButtonClass}>
                Account
              </Link>
            )}
            <button type="button" className={secondaryButtonClass} disabled={statement === null} onClick={() => window.print()}>
              <span className="inline-flex items-center gap-1.5">
                <Printer size={15} aria-hidden="true" /> Print
              </span>
            </button>
            {can('statements.send') && (
              <button type="button" className={primaryButtonClass} disabled={statement === null} onClick={() => setEmailing(true)}>
                <span className="inline-flex items-center gap-1.5">
                  <Mail size={15} aria-hidden="true" /> Email
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {statement === null && error === null && <LoadingState />}
      {statement !== null && (
        <StatementDocument
          statement={statement}
          settings={branding.settings}
          organizationName={branding.organizationName}
          orgAddressLines={branding.orgAddressLines}
          baseCurrency={branding.baseCurrency}
          logoSrc={branding.logoSrc}
          bankDetails={branding.bankDetails}
        />
      )}

      {sends !== null && sends.length > 0 && (
        <div className="no-print flex flex-col gap-2">
          <h3 className="text-base font-semibold m-0">Emailed</h3>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[40rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Sent</th>
                  <th className="p-3 font-medium">To</th>
                  <th className="p-3 font-medium">Statement</th>
                  <th className="p-3 font-medium">Opened</th>
                  <th className="p-3 font-medium text-right">Link</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((send) => {
                  const expired = Date.parse(send.expiresAt) <= Date.now();
                  return (
                    <tr key={send.id} className="border-t border-[var(--border)]">
                      <td className="p-3 whitespace-nowrap">
                        {formatDate(send.createdAt.slice(0, 10))}
                        {send.sentByName !== null && <span className="text-[var(--muted)]"> · {send.sentByName}</span>}
                      </td>
                      <td className="p-3">{send.toEmail}</td>
                      <td className="p-3">
                        {send.statementType === 'OUTSTANDING'
                          ? `Outstanding as at ${formatDate(send.asOf)}`
                          : `Activity ${formatDate(send.from)} – ${formatDate(send.to)}`}
                      </td>
                      <td className="p-3">{send.lastViewedAt === null ? '—' : formatDate(send.lastViewedAt.slice(0, 10))}</td>
                      <td className="p-3 text-right">
                        {send.revokedAt !== null ? (
                          <span className="text-[var(--muted)]">Revoked</span>
                        ) : expired ? (
                          <span className="text-[var(--muted)]">Expired</span>
                        ) : can('statements.send') ? (
                          <button type="button" className="btn btn--ghost" onClick={() => void revoke(send.id)}>
                            Revoke
                          </button>
                        ) : (
                          <span className="text-[var(--muted)]">Active</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {emailing && statement !== null && (
        <SendStatementDialog
          kind={kind}
          path={path}
          recipients={[{ partyId: statement.party.id, name: statement.party.name, email: statement.party.email }]}
          request={state.request}
          onClose={() => setEmailing(false)}
          onSent={() => setSendsToken((t) => t + 1)}
        />
      )}
    </section>
  );
}
