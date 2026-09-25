import type { CSSProperties, ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { Invoice, InvoiceSettings, OrganizationProfile } from '../../services/fetchServices';
import { formatCents, formatQuantity, formatRate } from '../../utils/money';

/**
 * The printable invoice document — ONE component, rendered by both the real
 * invoice page and the template editor's live preview (Phase 30, ruling 2).
 *
 * Presentational only, by design: no state, no effects, no fetch, no router or
 * context hook. Everything it renders arrives as a prop, which is what lets a
 * preview pane feed it local, unsaved state. (`Link` is a component, not a hook
 * call in this file, so the optional account link stays allowed.)
 *
 * Templates are a closed set of code-defined layouts selected by id. No request
 * value ever reaches the DOM as markup — every string below is a React text
 * child (escaped) and the accent colour is applied through inline `style` only,
 * never a class name or a <style> block.
 *
 * This component renders; it never mutates (guardrails rule 6). No
 * issue/void/edit control belongs here.
 */

export interface InvoiceDocumentProps {
  invoice: Invoice;
  /** `null` = settings not loaded (or failed): render with no branding and no optional
   *  sections, exactly as `InvoiceDetailPage` does today via `settings?.showX === true`. */
  settings: InvoiceSettings | null;
  /** `null` = profile not loaded: no logo, no address block. */
  profile: OrganizationProfile | null;
  organizationName: string;
  taxNumber: string | null;
  businessNumber: string | null;
  legalName: string | null;
  baseCurrency: string;
  /** Absolute or app-relative src for the logo image; null renders no logo. */
  logoSrc: string | null;
  /** Builds the href for a line's revenue-account link. The detail page passes
   *  `(id) => `${base}/accounts/${id}``; the preview passes nothing and the account code
   *  renders as plain text. A prop rather than the app-base-path router hook, because
   *  this component takes no hooks. */
  accountHref?: (accountId: string) => string;
  /** Preview mode scales the page down and disables print rules. */
  preview?: boolean;
}

const SERIF_STACK = 'Georgia, "Times New Roman", Times, serif';

/** `{city} {region} {postalCode}`, skipping nulls; null when all three are empty. */
function localityLine(profile: OrganizationProfile): string | null {
  const parts = [profile.city, profile.region, profile.postalCode].filter(
    (part): part is string => part !== null && part !== '',
  );
  return parts.length === 0 ? null : parts.join(' ');
}

/** The organization's address lines, in the documented order, nulls skipped. */
function addressLines(profile: OrganizationProfile): string[] {
  const candidates: (string | null)[] = [
    profile.streetAddress1,
    profile.streetAddress2,
    localityLine(profile),
    profile.countryCode,
    profile.phone,
    profile.contactEmail,
    profile.website,
  ];
  return candidates.filter((line): line is string => line !== null && line !== '');
}

/** Density is orthogonal to the template: compact halves vertical padding. */
function cellPad(settings: InvoiceSettings | null): string {
  return settings?.density === 'compact' ? 'px-2 py-1' : 'p-2';
}

function sectionGap(settings: InvoiceSettings | null): string {
  return settings?.density === 'compact' ? 'gap-3' : 'gap-6';
}

/** `settings === null` keeps today's behaviour: due date and payment terms show. */
function showsDueDate(settings: InvoiceSettings | null): boolean {
  return settings?.showDueDate !== false;
}

function showsPaymentTerms(settings: InvoiceSettings | null): boolean {
  return settings?.showPaymentTerms !== false;
}

function Logo(props: InvoiceDocumentProps & { className: string }): ReactElement | null {
  if (props.settings?.showLogo !== true || props.logoSrc === null) return null;
  return <img src={props.logoSrc} alt={`${props.organizationName} logo`} className={props.className} />;
}

/** The organization block: identity, disclosed numbers, address, billing address. */
function OrgBlock(props: InvoiceDocumentProps): ReactElement {
  const { settings, profile, organizationName, taxNumber, businessNumber, legalName } = props;
  const lines = settings?.showOrgAddress === true && profile !== null ? addressLines(profile) : [];
  return (
    <div>
      {settings?.showLegalName === true && legalName !== null && (
        <p className="font-semibold m-0">{legalName}</p>
      )}
      <p className="text-sm text-[var(--muted)] m-0">{organizationName}</p>
      {settings?.showTaxNumber === true && taxNumber !== null && (
        <p className="text-xs text-[var(--muted)] m-0">Tax no. {taxNumber}</p>
      )}
      {settings?.showBusinessNumber === true && businessNumber !== null && (
        <p className="text-xs text-[var(--muted)] m-0">Business no. {businessNumber}</p>
      )}
      {lines.map((line, index) => (
        <p key={`${String(index)}-${line}`} className="text-xs text-[var(--muted)] m-0">
          {line}
        </p>
      ))}
      {settings?.billingAddress != null && (
        <p className="text-xs text-[var(--muted)] m-0 whitespace-pre-line">{settings.billingAddress}</p>
      )}
    </div>
  );
}

function BillTo({ invoice }: Pick<InvoiceDocumentProps, 'invoice'>): ReactElement {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Bill to</p>
      <p className="font-medium m-0 mt-1">{invoice.customerNameSnapshot}</p>
      {invoice.customerAddressSnapshot !== null && (
        <p className="text-sm text-[var(--muted)] m-0 whitespace-pre-line">{invoice.customerAddressSnapshot}</p>
      )}
      {invoice.customerTaxNumberSnapshot !== null && (
        <p className="text-xs text-[var(--muted)] m-0">Tax no. {invoice.customerTaxNumberSnapshot}</p>
      )}
    </div>
  );
}

/** The revenue-account code: a link only when the caller supplied `accountHref`. */
function AccountCode(props: {
  accountHref: InvoiceDocumentProps['accountHref'];
  accountId: string;
  code: string;
}): ReactElement {
  if (props.accountHref === undefined) return <>{props.code}</>;
  return (
    <Link to={props.accountHref(props.accountId)} className="text-[var(--text)] no-underline hover:underline">
      {props.code}
    </Link>
  );
}

function Totals(props: InvoiceDocumentProps & { cardStyle?: CSSProperties | undefined }): ReactElement {
  const { invoice, settings, baseCurrency } = props;
  return (
    <div
      className="flex flex-col items-end gap-1.5 w-full max-w-sm self-end text-sm"
      style={props.cardStyle}
    >
      <div className="flex justify-between gap-6 w-full">
        <span className="text-[var(--muted)] min-w-0">Subtotal</span>
        <span className="tabular-nums whitespace-nowrap">{formatCents(invoice.subtotalCents)}</span>
      </div>
      <div className="flex justify-between gap-6 w-full">
        <span className="text-[var(--muted)] min-w-0">{settings?.taxLabel ?? 'Tax'}</span>
        <span className="tabular-nums whitespace-nowrap">{formatCents(invoice.taxCents)}</span>
      </div>
      <div className="flex justify-between gap-6 w-full font-semibold border-t border-[var(--border)] pt-2">
        <span className="min-w-0">Total</span>
        <span className="tabular-nums whitespace-nowrap">
          {formatCents(invoice.totalCents)} {invoice.currencyCode}
        </span>
      </div>
      {invoice.currencyCode !== baseCurrency && (
        <div className="flex justify-between gap-6 w-full text-[var(--muted)]">
          <span className="min-w-0">
            ≈ {baseCurrency} (at {invoice.fxRate})
          </span>
          <span className="tabular-nums whitespace-nowrap">{formatCents(invoice.baseTotalCents)}</span>
        </div>
      )}
      {invoice.status === 'ISSUED' && (
        <>
          <div className="flex justify-between gap-6 w-full">
            <span className="text-[var(--muted)] min-w-0">Paid</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(invoice.allocatedCents)}</span>
          </div>
          {invoice.creditedCents > 0 && (
            <div className="flex justify-between gap-6 w-full">
              <span className="text-[var(--muted)] min-w-0">Credits applied</span>
              <span className="tabular-nums whitespace-nowrap">{formatCents(invoice.creditedCents)}</span>
            </div>
          )}
          <div className="flex justify-between gap-6 w-full font-semibold">
            <span className="min-w-0">Amount due</span>
            <span className="tabular-nums whitespace-nowrap">{formatCents(invoice.amountDueCents)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** Payment terms, notes, bank details and footer notes — the foot of every layout. */
function Foot({ invoice, settings }: Pick<InvoiceDocumentProps, 'invoice' | 'settings'>): ReactElement {
  return (
    <>
      {invoice.paymentTerms !== null && showsPaymentTerms(settings) && (
        <p className="text-sm text-[var(--muted)] m-0">Payment terms: {invoice.paymentTerms}</p>
      )}
      {invoice.notes !== null && <p className="text-sm text-[var(--muted)] m-0">{invoice.notes}</p>}
      {settings?.bankDetails != null && (
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Bank details</p>
          <p className="text-sm text-[var(--muted)] m-0 whitespace-pre-line">{settings.bankDetails}</p>
        </div>
      )}
      {settings?.footerNotes != null && (
        <p className="text-xs text-[var(--muted)] m-0 border-t border-[var(--border)] pt-3">
          {settings.footerNotes}
        </p>
      )}
    </>
  );
}

function rootStyle(settings: InvoiceSettings | null, extra?: CSSProperties): CSSProperties | undefined {
  const style: CSSProperties = { ...extra };
  if (settings?.fontFamily === 'serif') style.fontFamily = SERIF_STACK;
  return Object.keys(style).length === 0 ? undefined : style;
}

/** classic — a faithful port of the layout the detail page has always printed. */
function ClassicLayout(props: InvoiceDocumentProps): ReactElement {
  const { invoice, settings, accountHref } = props;
  const pad = cellPad(settings);
  return (
    <div
      className={`rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 flex flex-col ${sectionGap(settings)}`}
      style={rootStyle(
        settings,
        settings !== null ? { borderTopColor: settings.accentColor, borderTopWidth: '4px' } : undefined,
      )}
    >
      <div className="flex justify-between gap-6 flex-wrap">
        <div className="flex gap-4 items-start">
          <Logo {...props} className="max-h-16 max-w-[8rem] object-contain" />
          <OrgBlock {...props} />
        </div>
        <div className="text-right">
          {settings !== null && (
            <p className="text-xs uppercase tracking-wide m-0" style={{ color: settings.accentColor }}>
              {settings.documentTitle}
            </p>
          )}
          <p className="text-lg font-semibold m-0">{invoice.invoiceNumber ?? 'DRAFT'}</p>
          <p className="text-sm text-[var(--muted)] m-0">Issued {invoice.issueDate}</p>
          {showsDueDate(settings) && <p className="text-sm text-[var(--muted)] m-0">Due {invoice.dueDate}</p>}
        </div>
      </div>

      <BillTo invoice={invoice} />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[36rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className={`${pad} font-medium`}>Description</th>
              <th className={`${pad} font-medium text-right`}>Qty</th>
              <th className={`${pad} font-medium text-right`}>Unit price</th>
              <th className={`${pad} font-medium`}>Account</th>
              <th className={`${pad} font-medium text-right`}>Tax</th>
              <th className={`${pad} font-medium text-right`}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id} className="border-t border-[var(--border)]">
                <td className={pad}>{line.description}</td>
                <td className={`${pad} text-right tabular-nums`}>{formatQuantity(line.quantityMilli)}</td>
                <td className={`${pad} text-right tabular-nums`}>{formatCents(line.unitPriceCents)}</td>
                <td className={pad}>
                  <AccountCode
                    accountHref={accountHref}
                    accountId={line.revenueAccountId}
                    code={line.revenueAccountCode}
                  />
                </td>
                <td className={`${pad} text-right tabular-nums`}>
                  {line.taxRateBp > 0 ? `${formatRate(line.taxRateBp)}%` : '—'}
                </td>
                <td className={`${pad} text-right tabular-nums`}>{formatCents(line.netCents + line.taxCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Totals {...props} />
      <Foot invoice={invoice} settings={settings} />
    </div>
  );
}

/** modern — accent band, org and customer side by side, zebra rows, tinted totals card. */
function ModernLayout(props: InvoiceDocumentProps & { settings: InvoiceSettings }): ReactElement {
  const { invoice, settings, accountHref } = props;
  const pad = cellPad(settings);
  const accent = settings.accentColor;
  return (
    <div
      className={`rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-hidden flex flex-col ${sectionGap(settings)}`}
      style={rootStyle(settings, { borderColor: accent })}
    >
      <div
        className="flex items-center justify-between gap-4 px-6 py-4 text-white"
        style={{ backgroundColor: accent }}
      >
        <p className="text-xl font-semibold tracking-wide uppercase m-0">{settings.documentTitle}</p>
        <Logo {...props} className="max-h-12 max-w-[8rem] object-contain" />
      </div>

      <div className={`px-6 flex flex-col ${sectionGap(settings)}`}>
        <div className="flex justify-between gap-6 flex-wrap">
          <OrgBlock {...props} />
          <BillTo invoice={invoice} />
          <div className="text-right">
            <p className="text-lg font-semibold m-0" style={{ color: accent }}>
              {invoice.invoiceNumber ?? 'DRAFT'}
            </p>
            <p className="text-sm text-[var(--muted)] m-0">Issued {invoice.issueDate}</p>
            {showsDueDate(settings) && <p className="text-sm text-[var(--muted)] m-0">Due {invoice.dueDate}</p>}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide" style={{ color: accent }}>
                <th className={`${pad} font-medium`}>Description</th>
                <th className={`${pad} font-medium text-right`}>Qty</th>
                <th className={`${pad} font-medium text-right`}>Unit price</th>
                <th className={`${pad} font-medium`}>Account</th>
                <th className={`${pad} font-medium text-right`}>Tax</th>
                <th className={`${pad} font-medium text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr key={line.id} className={index % 2 === 1 ? 'bg-black/5' : undefined}>
                  <td className={pad}>{line.description}</td>
                  <td className={`${pad} text-right tabular-nums`}>{formatQuantity(line.quantityMilli)}</td>
                  <td className={`${pad} text-right tabular-nums`}>{formatCents(line.unitPriceCents)}</td>
                  <td className={pad}>
                    <AccountCode
                      accountHref={accountHref}
                      accountId={line.revenueAccountId}
                      code={line.revenueAccountCode}
                    />
                  </td>
                  <td className={`${pad} text-right tabular-nums`}>
                    {line.taxRateBp > 0 ? `${formatRate(line.taxRateBp)}%` : '—'}
                  </td>
                  <td className={`${pad} text-right tabular-nums`}>{formatCents(line.netCents + line.taxCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Totals
          {...props}
          cardStyle={{
            backgroundColor: `${accent}1a`,
            borderColor: accent,
            borderWidth: '1px',
            borderStyle: 'solid',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        />
        <div className={`pb-6 flex flex-col ${sectionGap(settings)}`}>
          <Foot invoice={invoice} settings={settings} />
        </div>
      </div>
    </div>
  );
}

/** compact — single column, smaller type, no accent band; unit price and tax fold into a subtitle. */
function CompactLayout(props: InvoiceDocumentProps & { settings: InvoiceSettings }): ReactElement {
  const { invoice, settings, accountHref } = props;
  const pad = cellPad(settings);
  return (
    <div
      className={`rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col text-xs ${sectionGap(settings)}`}
      style={rootStyle(settings)}
    >
      <div className="flex items-start justify-between gap-4">
        <Logo {...props} className="max-h-10 max-w-[6rem] object-contain" />
        <div className="text-right ml-auto">
          <p className="text-sm font-semibold uppercase tracking-wide m-0">{settings.documentTitle}</p>
          <p className="font-semibold m-0">{invoice.invoiceNumber ?? 'DRAFT'}</p>
          <p className="text-[var(--muted)] m-0">Issued {invoice.issueDate}</p>
          {showsDueDate(settings) && <p className="text-[var(--muted)] m-0">Due {invoice.dueDate}</p>}
        </div>
      </div>

      <OrgBlock {...props} />
      <BillTo invoice={invoice} />

      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[var(--muted)] uppercase tracking-wide">
            <th className={`${pad} font-medium`}>Description</th>
            <th className={`${pad} font-medium text-right`}>Qty</th>
            <th className={`${pad} font-medium text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id} className="border-t border-[var(--border)] align-top">
              <td className={pad}>
                <span className="block">{line.description}</span>
                <span className="block text-[var(--muted)]">
                  {formatCents(line.unitPriceCents)} each ·{' '}
                  {line.taxRateBp > 0 ? `Tax ${formatRate(line.taxRateBp)}%` : 'No tax'} ·{' '}
                  <AccountCode
                    accountHref={accountHref}
                    accountId={line.revenueAccountId}
                    code={line.revenueAccountCode}
                  />
                </span>
              </td>
              <td className={`${pad} text-right tabular-nums`}>{formatQuantity(line.quantityMilli)}</td>
              <td className={`${pad} text-right tabular-nums`}>{formatCents(line.netCents + line.taxCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Totals {...props} />
      <Foot invoice={invoice} settings={settings} />
    </div>
  );
}

function renderLayout(props: InvoiceDocumentProps): ReactElement {
  const { settings } = props;
  // No settings means no template choice: fall back to classic, which with a
  // null `settings` renders exactly what the detail page always has.
  if (settings === null) return <ClassicLayout {...props} />;
  const templateId = settings.templateId;
  switch (templateId) {
    case 'classic':
      return <ClassicLayout {...props} />;
    case 'modern':
      return <ModernLayout {...props} settings={settings} />;
    case 'compact':
      return <CompactLayout {...props} settings={settings} />;
    default: {
      // A fourth template id is a compile error here. At runtime (a server
      // that ran ahead of this build) fall back to classic rather than crash
      // a page someone is trying to print.
      const unreachable: never = templateId;
      void unreachable;
      return <ClassicLayout {...props} />;
    }
  }
}

export default function InvoiceDocument(props: InvoiceDocumentProps): ReactElement {
  const document = renderLayout(props);
  if (props.preview !== true) return document;
  return (
    <div className="mx-auto w-full max-w-[210mm] border border-[var(--border)] shadow-lg bg-[var(--panel)]">
      {document}
    </div>
  );
}
