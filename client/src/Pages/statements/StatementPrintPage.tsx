import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { getPartyStatement, statementQuery, type PartyKind, type PartyStatement } from '../../services/fetchServices';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import { primaryButtonClass } from '../../components/ui/formClasses';
import StatementDocument from './StatementDocument';
import { PATH_FOR_KIND, useStatementParams } from './statementParams';
import { useStatementBranding } from './useStatementBranding';

/**
 * Bulk print (Phase 39a): the selected parties' statements one after another,
 * each on its own printed page (`.statement-page { break-after: page }`).
 * Statements load in parallel; the print dialog is the user's to open.
 */

const MAX_BATCH = 200;

export default function StatementPrintPage({ kind }: { kind: PartyKind }) {
  const path = PATH_FOR_KIND[kind];
  const [params] = useSearchParams();
  const state = useStatementParams();
  const branding = useStatementBranding();
  const query = statementQuery(state.request);
  const ids = (params.get('ids') ?? '').split(',').filter((id) => id !== '').slice(0, MAX_BATCH);
  const idsKey = ids.join(',');

  const [statements, setStatements] = useState<PartyStatement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatements(null);
    Promise.all(idsKey.split(',').filter((id) => id !== '').map((id) => getPartyStatement(path, id, state.request, controller.signal)))
      .then(setStatements)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the statements');
      });
    return () => controller.abort();
    // `query` is the request's stable serialisation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, idsKey, query]);

  return (
    <section className="flex flex-col gap-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <BackLink to={`/statements/${path}?${query}`} label="Back to statements" />
        <button type="button" className={primaryButtonClass} disabled={statements === null} onClick={() => window.print()}>
          <span className="inline-flex items-center gap-1.5">
            <Printer size={15} aria-hidden="true" /> Print {ids.length} statement{ids.length === 1 ? '' : 's'}
          </span>
        </button>
      </div>
      {error !== null && <p className="status status--bad">{error}</p>}
      {statements === null && error === null && <LoadingState />}
      {statements?.map((statement) => (
        <div key={statement.party.id} className="statement-page">
          <StatementDocument
            statement={statement}
            settings={branding.settings}
            organizationName={branding.organizationName}
            orgAddressLines={branding.orgAddressLines}
            baseCurrency={branding.baseCurrency}
            logoSrc={branding.logoSrc}
            bankDetails={branding.bankDetails}
          />
        </div>
      ))}
    </section>
  );
}
