import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  STATEMENT_TYPES,
  type PartyKind,
  type StatementPartyPath,
  type StatementRequest,
  type StatementType,
} from '../../services/fetchServices';
import { inputClass } from '../../components/ui/formClasses';

/**
 * The statement type and dates live in the URL (Phase 39a), so the list,
 * a single statement and bulk print all agree on what was asked for, and a
 * link opens exactly the statement someone was looking at.
 */

export const PATH_FOR_KIND: Record<PartyKind, StatementPartyPath> = { CUSTOMER: 'customers', VENDOR: 'vendors' };

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export interface StatementParams {
  type: StatementType;
  asOf: string;
  from: string;
  to: string;
  request: StatementRequest;
  /** The date balances are shown "as at": asOf, or the activity range end. */
  balanceDate: string;
  setParam: (key: string, value: string) => void;
}

export function useStatementParams(defaultType: StatementType = 'OUTSTANDING'): StatementParams {
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const rawType = params.get('type');
  const type = STATEMENT_TYPES.find((t) => t === rawType) ?? defaultType;
  const asOf = params.get('asOf') ?? today;
  const from = params.get('from') ?? firstOfMonth(today);
  const to = params.get('to') ?? today;

  const setParam = useCallback(
    (key: string, value: string) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === '') next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const request: StatementRequest = type === 'OUTSTANDING' ? { type, asOf } : { type, from, to };
  return { type, asOf, from, to, request, balanceDate: type === 'OUTSTANDING' ? asOf : to, setParam };
}

/** The type toggle and its date input(s). */
export function StatementControls({ state }: { state: StatementParams }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div role="radiogroup" aria-label="Statement type" className="flex rounded-md border border-[var(--border)] overflow-hidden text-sm">
        {STATEMENT_TYPES.map((t) => (
          <label
            key={t}
            className={`px-3 py-1.5 cursor-pointer ${state.type === t ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'bg-transparent'}`}
          >
            <input
              type="radio"
              name="statementType"
              value={t}
              checked={state.type === t}
              onChange={() => state.setParam('type', t)}
              className="sr-only"
            />
            {t === 'OUTSTANDING' ? 'Outstanding' : 'Activity'}
          </label>
        ))}
      </div>
      {state.type === 'OUTSTANDING' ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">As at</span>
          <input
            type="date"
            value={state.asOf}
            onChange={(e) => state.setParam('asOf', e.target.value)}
            className={inputClass}
          />
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">From</span>
            <input
              type="date"
              value={state.from}
              max={state.to}
              onChange={(e) => state.setParam('from', e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">To</span>
            <input
              type="date"
              value={state.to}
              min={state.from}
              onChange={(e) => state.setParam('to', e.target.value)}
              className={inputClass}
            />
          </label>
        </>
      )}
    </div>
  );
}
