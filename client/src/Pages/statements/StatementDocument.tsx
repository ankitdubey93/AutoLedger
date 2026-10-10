import { Fragment, type CSSProperties, type ReactElement } from 'react';
import type {
  AgingBucket,
  PartyKind,
  PartyLedgerEntryKind,
  PartyLedgerRow,
  PartyStatement,
  StatementSettings,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { fillPlaceholders } from '../../utils/placeholders';

/**
 * The printable customer/vendor statement (Phase 39a) — ONE component, rendered
 * by the statement page, bulk print, the template editor's live preview and
 * the public "Review and pay" page.
 *
 * Presentational only, like InvoiceDocument: no state, no effects, no fetch,
 * no router or context hook — everything arrives as a prop, which is what lets
 * the preview feed it unsaved settings and the public page feed it data from
 * a token instead of a session.
 *
 * Templates are the same closed set as invoices, selected by id; every string
 * is a React text child and the accent colour is applied by inline style only.
 *
 * Phase 40 — the template's title, footer and the remittance bank details
 * are organization settings shared by every statement, so their placeholders
 * (`[Contact Name]`, `[Balance Due]`, `[Statement Date]`) are filled here, per
 * statement, as it renders — the same values a statement email uses.
 */

export interface StatementDocumentProps {
  statement: PartyStatement;
  /** `null` = not loaded: render classic with no branding. */
  settings: StatementSettings | null;
  organizationName: string;
  /** Pre-formatted address lines — `addressLines(profile)` in the app, server-built on the public page. */
  orgAddressLines: string[];
  baseCurrency: string;
  logoSrc: string | null;
  /** Invoice settings' bank details, printed as remittance advice when enabled. */
  bankDetails: string | null;
  preview?: boolean;
}

const KIND_LABELS: Record<PartyLedgerEntryKind, string> = {
  INVOICE: 'Invoice',
  INVOICE_VOID: 'Invoice voided',
  BILL: 'Bill',
  BILL_VOID: 'Bill voided',
  PAYMENT: 'Payment',
  PAYMENT_VOID: 'Payment voided',
  CREDIT_NOTE: 'Credit note',
  CREDIT_NOTE_VOID: 'Credit note voided',
  DEBIT_NOTE: 'Debit note',
  DEBIT_NOTE_VOID: 'Debit note voided',
};

const AGING_LABELS: Record<AgingBucket, string> = {
  CURRENT: 'Current',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D90_PLUS: '90+ days',
};

const AGING_ORDER: AgingBucket[] = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'];

/**
 * Column headings, oriented so the first amount column always *raises* what
 * is owed: an invoice for a customer (a debit to AR), a bill for a vendor (a
 * credit to AP).
 */
const COPY: Record<PartyKind, { to: string; raises: string; lowers: string; balance: string }> = {
  CUSTOMER: { to: 'To', raises: 'Charges', lowers: 'Payments & credits', balance: 'Balance due' },
  VENDOR: { to: 'Supplier', raises: 'Billed', lowers: 'Payments & debits', balance: 'Balance owed' },
};

function raises(kind: PartyKind, row: PartyLedgerRow): number {
  return kind === 'CUSTOMER' ? row.debitCents : row.creditCents;
}

function lowers(kind: PartyKind, row: PartyLedgerRow): number {
  return kind === 'CUSTOMER' ? row.creditCents : row.debitCents;
}

function rowDescription(row: PartyLedgerRow): string {
  const label = KIND_LABELS[row.kind];
  const number = row.documentNumber !== null ? ` ${row.documentNumber}` : '';
  if ((row.kind === 'PAYMENT' || row.kind === 'PAYMENT_VOID') && row.allocations.length > 0) {
    const applied = row.allocations.map((a) => a.documentNumber ?? '—').join(', ');
    return `${label}${number} — ${applied}`;
  }
  return `${label}${number}`;
}

function cellPad(compact: boolean): string {
  return compact ? 'px-2 py-1' : 'p-2';
}

function Logo(props: StatementDocumentProps & { className: string }): ReactElement | null {
  if (props.settings?.showLogo !== true || props.logoSrc === null) return null;
  return <img src={props.logoSrc} alt={`${props.organizationName} logo`} className={props.className} />;
}

function OrgBlock(props: StatementDocumentProps): ReactElement {
  const lines = props.settings?.showOrgAddress === true ? props.orgAddressLines : [];
  return (
    <div>
      <p className="font-semibold m-0">{props.organizationName}</p>
      {lines.map((line, index) => (
        <p key={`${String(index)}-${line}`} className="text-xs text-[var(--muted)] m-0">
          {line}
        </p>
      ))}
    </div>
  );
}

function PartyBlock({ statement }: Pick<StatementDocumentProps, 'statement'>): ReactElement {
  const { party } = statement;
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">{COPY[party.kind].to}</p>
      <p className="font-medium m-0 mt-1">{party.name}</p>
      {party.billingAddress !== null && (
        <p className="text-sm text-[var(--muted)] m-0 whitespace-pre-line">{party.billingAddress}</p>
      )}
      {party.taxNumber !== null && <p className="text-xs text-[var(--muted)] m-0">Tax no. {party.taxNumber}</p>}
    </div>
  );
}

function DateBlock(props: StatementDocumentProps & { titleStyle?: CSSProperties }): ReactElement {
  const { statement, settings } = props;
  return (
    <div className="text-right">
      <p className="text-xs uppercase tracking-wide m-0" style={props.titleStyle}>
        {settings?.documentTitle ?? 'STATEMENT'}
      </p>
      <p className="text-sm font-medium m-0">
        {statement.type === 'ACTIVITY' ? 'Activity' : 'Outstanding'}
      </p>
      {statement.type === 'ACTIVITY' ? (
        <p className="text-sm text-[var(--muted)] m-0">
          {formatDate(statement.from)} – {formatDate(statement.statementDate)}
        </p>
      ) : (
        <p className="text-sm text-[var(--muted)] m-0">As at {formatDate(statement.statementDate)}</p>
      )}
    </div>
  );
}

function ActivityTable(props: StatementDocumentProps & { compact: boolean; zebra: boolean }): ReactElement {
  const { statement } = props;
  const kind = statement.party.kind;
  const pad = cellPad(props.compact);
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
          <th className={`${pad} font-medium`}>Date</th>
          <th className={`${pad} font-medium`}>Activity</th>
          <th className={`${pad} font-medium text-right`}>{COPY[kind].raises}</th>
          <th className={`${pad} font-medium text-right`}>{COPY[kind].lowers}</th>
          <th className={`${pad} font-medium text-right`}>Balance</th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-t border-[var(--border)] italic text-[var(--muted)]">
          <td className={pad}>{formatDate(statement.from)}</td>
          <td className={pad} colSpan={3}>
            Opening balance
          </td>
          <td className={`${pad} text-right tabular-nums`}>{formatCents(statement.openingBalanceCents ?? 0)}</td>
        </tr>
        {statement.rows.map((row, index) => (
          <tr
            key={`${row.journalEntryId}-${row.documentId}`}
            className={`border-t border-[var(--border)] ${props.zebra && index % 2 === 1 ? 'bg-black/5' : ''}`}
          >
            <td className={`${pad} tabular-nums whitespace-nowrap`}>{formatDate(row.entryDate)}</td>
            <td className={pad}>{rowDescription(row)}</td>
            <td className={`${pad} text-right tabular-nums`}>
              {raises(kind, row) > 0 ? formatCents(raises(kind, row)) : ''}
            </td>
            <td className={`${pad} text-right tabular-nums`}>
              {lowers(kind, row) > 0 ? formatCents(lowers(kind, row)) : ''}
            </td>
            <td className={`${pad} text-right tabular-nums`}>{formatCents(row.runningBalanceCents)}</td>
          </tr>
        ))}
        {statement.rows.length === 0 && (
          <tr className="border-t border-[var(--border)]">
            <td colSpan={5} className={`${pad} text-center text-[var(--muted)]`}>
              No activity in this period.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function OutstandingTable(props: StatementDocumentProps & { compact: boolean; zebra: boolean }): ReactElement {
  const { statement } = props;
  const pad = cellPad(props.compact);
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
          <th className={`${pad} font-medium`}>Number</th>
          <th className={`${pad} font-medium`}>Date</th>
          <th className={`${pad} font-medium`}>Due</th>
          <th className={`${pad} font-medium text-right`}>Amount</th>
          <th className={`${pad} font-medium text-right`}>Outstanding</th>
        </tr>
      </thead>
      <tbody>
        {statement.openItems.map((item, index) => (
          <tr
            key={item.documentId}
            className={`border-t border-[var(--border)] ${props.zebra && index % 2 === 1 ? 'bg-black/5' : ''}`}
          >
            <td className={pad}>
              {item.documentNumber ?? '—'}
              {(item.documentKind === 'CREDIT_NOTE' || item.documentKind === 'DEBIT_NOTE') && (
                <span className="text-[var(--muted)]"> (unapplied credit)</span>
              )}
            </td>
            <td className={`${pad} tabular-nums whitespace-nowrap`}>{formatDate(item.documentDate)}</td>
            <td className={`${pad} tabular-nums whitespace-nowrap`}>
              {formatDate(item.dueDate)}
              {item.daysOverdue > 0 && (
                <span className="ml-1 text-xs text-[var(--bad)]">({item.daysOverdue}d overdue)</span>
              )}
            </td>
            <td className={`${pad} text-right tabular-nums`}>{formatCents(item.baseTotalCents)}</td>
            <td className={`${pad} text-right tabular-nums`}>{formatCents(item.baseOutstandingCents)}</td>
          </tr>
        ))}
        {statement.openItems.length === 0 && (
          <tr className="border-t border-[var(--border)]">
            <td colSpan={5} className={`${pad} text-center text-[var(--muted)]`}>
              Nothing outstanding.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Totals(props: StatementDocumentProps & { cardStyle?: CSSProperties }): ReactElement {
  const { statement, baseCurrency } = props;
  return (
    <div className="flex flex-col items-end gap-1.5 w-full max-w-sm self-end text-sm" style={props.cardStyle}>
      {statement.overdueCents !== 0 && (
        <div className="flex justify-between gap-6 w-full">
          <span className="text-[var(--muted)]">Overdue</span>
          <span className="tabular-nums whitespace-nowrap">{formatCents(statement.overdueCents)}</span>
        </div>
      )}
      <div className="flex justify-between gap-6 w-full font-semibold border-t border-[var(--border)] pt-2">
        <span>{COPY[statement.party.kind].balance}</span>
        <span className="tabular-nums whitespace-nowrap">
          {formatCents(statement.closingBalanceCents)} {baseCurrency}
        </span>
      </div>
    </div>
  );
}

function AgingStrip(props: StatementDocumentProps): ReactElement | null {
  if (props.settings?.showAgingSummary !== true) return null;
  return (
    <div className="grid grid-cols-5 border border-[var(--border)] rounded-md text-xs overflow-hidden">
      {AGING_ORDER.map((bucket, index) => (
        <div
          key={bucket}
          className={`p-2 flex flex-col gap-0.5 ${index > 0 ? 'border-l border-[var(--border)]' : ''}`}
        >
          <span className="text-[var(--muted)]">{AGING_LABELS[bucket]}</span>
          <span className="tabular-nums font-medium">{formatCents(props.statement.aging[bucket])}</span>
        </div>
      ))}
    </div>
  );
}

function Foot(props: StatementDocumentProps): ReactElement {
  const { settings, bankDetails } = props;
  return (
    <>
      {settings?.showRemittance === true && bankDetails !== null && props.statement.party.kind === 'CUSTOMER' && (
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">How to pay</p>
          <p className="text-sm text-[var(--muted)] m-0 whitespace-pre-line">{bankDetails}</p>
        </div>
      )}
      {settings?.footerNotes != null && (
        <p className="text-xs text-[var(--muted)] m-0 border-t border-[var(--border)] pt-3">{settings.footerNotes}</p>
      )}
    </>
  );
}

function Body(props: StatementDocumentProps & { compact: boolean; zebra: boolean; totalsStyle?: CSSProperties }) {
  return (
    <>
      <div className="overflow-x-auto">
        {props.statement.type === 'ACTIVITY' ? <ActivityTable {...props} /> : <OutstandingTable {...props} />}
      </div>
      <Totals {...props} {...(props.totalsStyle !== undefined ? { cardStyle: props.totalsStyle } : {})} />
      <AgingStrip {...props} />
      <Foot {...props} />
    </>
  );
}

function ClassicLayout(props: StatementDocumentProps): ReactElement {
  const accent = props.settings?.accentColor;
  return (
    <div
      className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 flex flex-col gap-6"
      style={accent !== undefined ? { borderTopColor: accent, borderTopWidth: '4px' } : undefined}
    >
      <div className="flex justify-between gap-6 flex-wrap">
        <div className="flex gap-4 items-start">
          <Logo {...props} className="max-h-16 max-w-[8rem] object-contain" />
          <OrgBlock {...props} />
        </div>
        <DateBlock {...props} titleStyle={accent !== undefined ? { color: accent } : {}} />
      </div>
      <PartyBlock statement={props.statement} />
      <Body {...props} compact={false} zebra={false} />
    </div>
  );
}

function ModernLayout(props: StatementDocumentProps & { settings: StatementSettings }): ReactElement {
  const accent = props.settings.accentColor;
  return (
    <div
      className="rounded-lg border bg-[var(--panel)] overflow-hidden flex flex-col gap-6"
      style={{ borderColor: accent }}
    >
      <div className="flex items-center justify-between gap-4 px-6 py-4 text-white" style={{ backgroundColor: accent }}>
        <p className="text-xl font-semibold tracking-wide uppercase m-0">{props.settings.documentTitle}</p>
        <Logo {...props} className="max-h-12 max-w-[8rem] object-contain" />
      </div>
      <div className="px-6 pb-6 flex flex-col gap-6">
        <div className="flex justify-between gap-6 flex-wrap">
          <OrgBlock {...props} />
          <PartyBlock statement={props.statement} />
          <DateBlock {...props} titleStyle={{ display: 'none' }} />
        </div>
        <Body
          {...props}
          compact={false}
          zebra
          totalsStyle={{
            backgroundColor: `${accent}1a`,
            border: `1px solid ${accent}`,
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        />
      </div>
    </div>
  );
}

function CompactLayout(props: StatementDocumentProps): ReactElement {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3 text-xs">
      <div className="flex items-start justify-between gap-4">
        <Logo {...props} className="max-h-10 max-w-[6rem] object-contain" />
        <div className="ml-auto">
          <DateBlock {...props} />
        </div>
      </div>
      <OrgBlock {...props} />
      <PartyBlock statement={props.statement} />
      <Body {...props} compact zebra={false} />
    </div>
  );
}

function renderLayout(props: StatementDocumentProps): ReactElement {
  const { settings } = props;
  if (settings === null) return <ClassicLayout {...props} />;
  const templateId = settings.templateId;
  switch (templateId) {
    case 'classic':
      return <ClassicLayout {...props} />;
    case 'modern':
      return <ModernLayout {...props} settings={settings} />;
    case 'compact':
      return <CompactLayout {...props} />;
    default: {
      const unreachable: never = templateId;
      void unreachable;
      return <ClassicLayout {...props} />;
    }
  }
}

function withPlaceholdersFilled(props: StatementDocumentProps): StatementDocumentProps {
  const { statement, settings } = props;
  const fill = (text: string) =>
    fillPlaceholders(text, 'STATEMENT', {
      date: statement.statementDate,
      contactName: statement.party.name,
      organisationName: props.organizationName,
      balanceDue: `${props.baseCurrency} ${formatCents(statement.closingBalanceCents)}`,
      overdueAmount: `${props.baseCurrency} ${formatCents(statement.overdueCents)}`,
      statementDate: statement.statementDate,
      periodFrom: statement.from,
      periodTo: statement.statementDate,
      openInvoiceCount: statement.openItems.filter((i) => i.documentKind === 'INVOICE' || i.documentKind === 'BILL').length,
    });
  return {
    ...props,
    bankDetails: props.bankDetails === null ? null : fill(props.bankDetails),
    settings:
      settings === null
        ? null
        : {
            ...settings,
            documentTitle: fill(settings.documentTitle),
            footerNotes: settings.footerNotes === null ? null : fill(settings.footerNotes),
          },
  };
}

export default function StatementDocument(props: StatementDocumentProps): ReactElement {
  const document = renderLayout(withPlaceholdersFilled(props));
  if (props.preview !== true) return <Fragment>{document}</Fragment>;
  return (
    <div className="mx-auto w-full max-w-[210mm] border border-[var(--border)] shadow-lg bg-[var(--panel)]">
      {document}
    </div>
  );
}
