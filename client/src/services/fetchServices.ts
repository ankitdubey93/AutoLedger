import {
  AUTH_EXPIRED_EVENT,
  fetchWithAutoRefresh,
  refreshSession,
  type AutoRefreshOptions,
} from '../utils/fetchWithAutoRefresh';

/**
 * The single place the client talks to the API. Every page goes through here so
 * the base URL, the `/api/v1` prefix, credential mode and error decoding are
 * defined once — the client-side mirror of the server's service layer.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const API_PREFIX = '/api/v1';

/** Thrown when the API answered, but with a non-2xx status. */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  options: AutoRefreshOptions = {},
): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not set — copy client/.env.example to client/.env');
  }

  // Every call goes through the wrapper, so an expired access token is
  // refreshed and the request replayed without the page knowing.
  const response = await fetchWithAutoRefresh(
    `${API_BASE_URL}${API_PREFIX}${path}`,
    {
      // Required from Phase 1: the access and refresh tokens are httpOnly cookies,
      // and a cross-origin fetch omits cookies unless told otherwise.
      credentials: 'include',
      ...init,
      // Spread after `init` so a caller cannot accidentally drop Content-Type.
      headers: { 'Content-Type': 'application/json', ...init.headers },
    },
    options,
  );

  // A 502 from a proxy has no JSON body; don't let the parse failure mask the
  // real status code.
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed with status ${response.status}`;
    throw new ApiRequestError(response.status, message);
  }

  return body as T;
}

export interface HealthResponse {
  success: boolean;
  status: 'ok' | 'degraded';
  service: string;
  apiVersion: string;
  environment: string;
  uptimeSeconds: number;
  db: {
    connected: boolean;
    latencyMs: number | null;
    error?: string;
  };
}

/**
 * GET /api/v1/health.
 *
 * The signal is optional. Aborting is genuinely useful for a long request, but
 * for these small GETs it caused a real bug: React StrictMode double-invokes
 * effects in development, and aborting request #1 while its CORS preflight was
 * still in flight made request #2 — which was queued behind that same
 * preflight — fail with a TypeError. Components use an `ignore` flag instead;
 * see the note in Pages/AccountPage.tsx.
 */
export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health', { signal: signal ?? null });
}

/* ------------------------------------------------------------------ identity */

/** Mirrors server/src/types/auth.ts. Nullable columns are `| null`, never optional. */
export type Role = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER';

export interface PublicUser {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  baseCurrency: string;
  taxNumber: string | null;
  businessNumber: string | null;
  createdAt: string;
}

export interface Membership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: Role;
  joinedAt: string;
}

export interface OrganizationMember {
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  joinedAt: string;
}

/** The body of /auth/check, /auth/login, /auth/refresh and /auth/switch-org. */
export interface SessionResponse {
  success: boolean;
  user: PublicUser;
  organization: OrganizationSummary | null;
  role: Role | null;
  memberships: Membership[];
  accessTokenExpiresAt: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  organizationName: string;
}

/**
 * The auth endpoints opt out of auto-refresh. A 401 from login is a wrong
 * password, not an expired session, and trying to refresh in response would
 * both fail and replace a clear error message with a confusing one.
 */
const NO_AUTO_REFRESH = { skipAuthRefresh: true } as const;

/** POST /auth/register — creates the user and their organization. Does not log in. */
export function register(input: RegisterInput): Promise<{ success: boolean; user: PublicUser }> {
  return apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(input) }, NO_AUTO_REFRESH);
}

/** POST /auth/login — the server sets both httpOnly cookies. */
export function login(email: string, password: string): Promise<SessionResponse> {
  return apiFetch(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    NO_AUTO_REFRESH,
  );
}

/**
 * GET /auth/check — the session-restore call on page load.
 *
 * Auto-refresh stays ON here, and that is what makes a reload after the access
 * token expired still land you logged in: the 401 triggers a silent refresh
 * and the check is replayed.
 */
export function checkSession(signal?: AbortSignal): Promise<SessionResponse> {
  return apiFetch('/auth/check', { signal: signal ?? null });
}

/** POST /auth/logout — always succeeds, so the client can always reach a clean state. */
export function logout(): Promise<{ success: boolean }> {
  return apiFetch('/auth/logout', { method: 'POST' }, NO_AUTO_REFRESH);
}

/** POST /auth/switch-org — re-issues the session against another organization. */
export function switchOrg(orgId: string): Promise<SessionResponse> {
  return apiFetch('/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId }) });
}

/** POST /auth/refresh — normally silent; the dashboard exposes it as a button. */
export function refreshSessionRequest(): Promise<SessionResponse> {
  return apiFetch('/auth/refresh', { method: 'POST' }, NO_AUTO_REFRESH);
}

/* -------------------------------------------------------------- organizations */

export function getOrganization(signal?: AbortSignal): Promise<{
  success: boolean;
  organization: OrganizationSummary;
}> {
  return apiFetch('/organizations', { signal: signal ?? null });
}

/** GET /organizations/members — OWNER and ADMIN only; 403 for everyone else. */
export function listMembers(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  members: OrganizationMember[];
}> {
  return apiFetch('/organizations/members', { signal: signal ?? null });
}

/* --------------------------------------------------------------------- apps */

/** Mirrors server/src/types/apps.ts. */
export type AppStatus = 'building' | 'planned';

export interface AppSummary {
  slug: string;
  name: string;
  domain: string;
  tagline: string;
  skills: string[];
  status: AppStatus;
}

/** GET /apps — the suite's app registry, shown on the chooser. */
export function listApps(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  apps: AppSummary[];
}> {
  return apiFetch('/apps', { signal: signal ?? null });
}

/* -------------------------------------------------------------- ledger-core */

/**
 * Mirrors server/src/types/ledger-core.ts, hand-written rather than imported.
 * The two packages build independently, so the server's types are not reachable
 * from here — the same reason `AppSummary` above is mirrored.
 *
 * Money is `*Cents: number` throughout: integer minor units, never a float
 * (guardrails rule 3). `fxRate` stays a string for the same reason the server
 * keeps it one — it is a NUMERIC, and a float would lose precision.
 */
export type AccountType = 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountNode extends Account {
  children: AccountNode[];
}

export interface LedgerLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  currencyCode: string;
  fxRate: string;
  baseDebitCents: number;
  baseCreditCents: number;
}

export interface JournalEntry {
  id: string;
  entryDate: string;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  createdBy: string;
  createdByName: string | null;
  createdByEmail: string | null;
  createdAt: string;
  totalDebitCents: number;
  totalCreditCents: number;
  lines: LedgerLine[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
  netBalanceCents: number;
}

/** GET /ledger-core/accounts — the flat chart, ordered by code. */
export function listAccounts(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  accounts: Account[];
}> {
  return apiFetch('/ledger-core/accounts', { signal: signal ?? null });
}

/** GET /ledger-core/accounts?tree=true — the same chart, nested by parentId. */
export function listAccountTree(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  accounts: AccountNode[];
}> {
  return apiFetch('/ledger-core/accounts?tree=true', { signal: signal ?? null });
}

/** Mirrors server/src/schemas/ledger-core/accountSchema.ts's createAccountSchema. */
export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  description: string | null;
}

/**
 * POST /ledger-core/accounts — OWNER, ADMIN or ACCOUNTANT.
 *
 * Documented failure paths (docs/api.md): 409 Account code already exists ·
 * 422 Parent account not found · 422 Parent account must have the same type.
 */
export function createAccount(
  input: CreateAccountInput,
): Promise<{ success: boolean; account: Account }> {
  return apiFetch('/ledger-core/accounts', { method: 'POST', body: JSON.stringify(input) });
}

/** Mirrors server/src/types/ledger-core.ts's AccountLedgerRow. */
export interface AccountLedgerRow {
  lineId: string;
  entryId: string;
  entryDate: string;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  createdAt: string;
  debitCents: number;
  creditCents: number;
  runningBalanceCents: number;
  counterparts: string[];
}

/** Mirrors server/src/types/ledger-core.ts's AccountLedger. */
export interface AccountLedger {
  account: { id: string; code: string; name: string; type: AccountType };
  from: string | null;
  to: string | null;
  openingBalanceCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  closingBalanceCents: number;
  rows: AccountLedgerRow[];
  totalCount: number;
}

/** GET /ledger-core/accounts/:id/ledger — running balances computed server-side. */
export function getAccountLedger(
  accountId: string,
  params: { from?: string; to?: string; page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<
  { success: boolean; count: number; currentPage: number; totalPages: number } & AccountLedger
> {
  const query = new URLSearchParams();
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ledger-core/accounts/${accountId}/ledger${suffix}`, { signal: signal ?? null });
}

/** Mirrors server/src/types/ledger-core.ts's AccountBalance. */
export interface AccountBalance {
  accountId: string;
  ownBalanceCents: number;
  rollupBalanceCents: number;
}

/** GET /ledger-core/accounts/balances — own and subtree-rollup balance per account. */
export function getAccountBalances(
  asOf?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; asOf: string | null; count: number; balances: AccountBalance[] }> {
  const suffix = asOf === undefined || asOf === '' ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  return apiFetch(`/ledger-core/accounts/balances${suffix}`, { signal: signal ?? null });
}

export interface JournalFilters {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  accountId?: string;
  sourceType?: string;
  q?: string;
}

/** GET /ledger-core/journals — paginated, filterable, lines nested. */
export function listJournals(
  params: JournalFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  entries: JournalEntry[];
}> {
  const query = new URLSearchParams();
  // An empty filter box must send no parameter at all, not `?q=`.
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.accountId !== undefined && params.accountId !== '') query.set('accountId', params.accountId);
  if (params.sourceType !== undefined && params.sourceType !== '') query.set('sourceType', params.sourceType);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ledger-core/journals${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/journals/:id — one entry with its lines and full detail. */
export function getJournal(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; entry: JournalEntry }> {
  return apiFetch(`/ledger-core/journals/${id}`, { signal: signal ?? null });
}

export interface JournalLineInput {
  accountId: string;
  debitCents: number;
  creditCents: number;
}

/** POST /ledger-core/journals — debits must equal credits, in integer cents. */
export function createJournal(body: {
  entryDate: string;
  description: string | null;
  lines: JournalLineInput[];
}): Promise<{ success: boolean; entry: JournalEntry }> {
  return apiFetch('/ledger-core/journals', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * POST /ledger-core/journals/:id/reverse — the only correction path.
 * There is no update and no delete, by design (guardrails rule 6).
 */
export function reverseJournal(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; entry: JournalEntry }> {
  return apiFetch(`/ledger-core/journals/${id}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/** GET /ledger-core/reports/trial-balance — aggregated from raw lines each call. */
export function getTrialBalance(
  asOf: string | null = null,
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  asOf: string | null;
  isBalanced: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
  count: number;
  rows: TrialBalanceRow[];
}> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  return apiFetch(`/ledger-core/reports/trial-balance${suffix}`, { signal: signal ?? null });
}

/* ------------------------------------------------- ledger-core: settings & dashboard */

/** Mirrors server/src/types/ledger-core.ts's FiscalYearWindow. */
export interface FiscalYearWindow {
  startDate: string;
  endDate: string;
  label: string;
}

/** Mirrors server/src/types/ledger-core.ts's LedgerSettings. */
export interface LedgerSettings {
  organizationName: string;
  legalName: string | null;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  booksStartDate: string;
  industry: string | null;
  timezone: string;
  cashAccountId: string | null;
  /** `null` when the wizard has never been completed for this organization. */
  onboardedAt: string | null;
  currentFiscalYear: FiscalYearWindow;
  /** `true` once any ledger line exists — base currency can no longer change. */
  baseCurrencyLocked: boolean;
  /** Phase 8. `null` falls back to chart codes 4910/6810/6820 in the service. */
  realizedFxGainAccountId: string | null;
  realizedFxLossAccountId: string | null;
  unrealizedFxAccountId: string | null;
}

/** Mirrors server/src/services/ledger-core/settingsService.ts's OnboardingInput. */
export interface OnboardingInput {
  organizationName: string;
  legalName: string | null;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  booksStartDate: string;
  industry: string | null;
  timezone: string;
  cashAccountId: string | null;
}

/** GET /ledger-core/settings — a missing settings row means "not yet onboarded", not a 404. */
export async function getLedgerSettings(signal?: AbortSignal): Promise<LedgerSettings> {
  const body = await apiFetch<{ success: boolean; settings: LedgerSettings }>('/ledger-core/settings', {
    signal: signal ?? null,
  });
  return body.settings;
}

/** POST /ledger-core/settings/onboarding — idempotent; re-submitting overwrites, never 409s. */
export async function completeLedgerOnboarding(input: OnboardingInput): Promise<LedgerSettings> {
  const body = await apiFetch<{ success: boolean; settings: LedgerSettings }>(
    '/ledger-core/settings/onboarding',
    { method: 'POST', body: JSON.stringify(input) },
  );
  return body.settings;
}

/** PATCH /ledger-core/settings — refused with 409 until onboarding has completed once. */
export async function updateLedgerSettings(input: Partial<OnboardingInput>): Promise<LedgerSettings> {
  const body = await apiFetch<{ success: boolean; settings: LedgerSettings }>('/ledger-core/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.settings;
}

/** Mirrors server/src/types/ledger-core.ts's TrendPoint. */
export interface TrendPoint {
  month: string;
  revenueCents: number;
  expenseCents: number;
}

/** Mirrors server/src/types/ledger-core.ts's AgingBucket/AGING_BUCKET_LABELS. */
export type AgingBucket = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';

export interface AgingBucketAmount {
  bucket: AgingBucket;
  label: string;
  amountCents: number;
  documentCount: number;
}

/** Mirrors server/src/types/ledger-core.ts's DashboardSummary. */
export interface DashboardSummary {
  asOf: string;
  fiscalYear: FiscalYearWindow;
  position: {
    assetsCents: number;
    liabilitiesCents: number;
    equityCents: number;
    currentEarningsCents: number;
    cashCents: number | null;
    equationHolds: boolean;
  };
  performance: {
    yearToDate: { revenueCents: number; expenseCents: number; netIncomeCents: number };
    currentMonth: { revenueCents: number; expenseCents: number; netIncomeCents: number };
  };
  activity: { entryCountYtd: number; recentEntries: JournalEntry[] };
  integrity: { totalDebitCents: number; totalCreditCents: number; isBalanced: boolean };
  trend: TrendPoint[];
  receivables: {
    outstandingCents: number;
    overdueCents: number;
    draftCount: number;
    draftCents: number;
    buckets: AgingBucketAmount[];
  };
  payables: {
    outstandingCents: number;
    overdueCents: number;
    draftCount: number;
    draftCents: number;
    awaitingReviewCount: number;
    awaitingReviewCents: number;
    buckets: AgingBucketAmount[];
  };
}

/** GET /ledger-core/reports/dashboard — aggregated from raw lines each call, never cached. */
export async function getLedgerDashboard(
  asOf: string | null = null,
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & DashboardSummary>(
    `/ledger-core/reports/dashboard${suffix}`,
    { signal: signal ?? null },
  );
  const { success, ...summary } = body;
  return summary;
}

/* ---------------------------------------------------- organizations: update */

/** PATCH /organizations — the organization's name, base currency, and tax identifiers. OWNER/ADMIN only. */
export async function updateOrganization(input: {
  name?: string;
  baseCurrency?: string;
  taxNumber?: string | null;
  businessNumber?: string | null;
}): Promise<OrganizationSummary> {
  const body = await apiFetch<{ success: boolean; organization: OrganizationSummary }>('/organizations', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.organization;
}

/* ------------------------------------------------------ ledger-core: invoicing */

/** Mirrors server/src/types/ledger-core.ts's Customer. */
export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /ledger-core/customers */
export function listCustomers(
  params: { q?: string; includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; customers: Customer[] }> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.includeInactive === true) query.set('includeInactive', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/ledger-core/customers${suffix}`, { signal: signal ?? null });
}

/** POST /ledger-core/customers */
export function createCustomer(body: {
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  notes: string | null;
}): Promise<{ success: boolean; customer: Customer }> {
  return apiFetch('/ledger-core/customers', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /ledger-core/customers/:id */
export function updateCustomer(
  id: string,
  body: Partial<{
    name: string;
    email: string | null;
    phone: string | null;
    billingAddress: string | null;
    taxNumber: string | null;
    notes: string | null;
    isActive: boolean;
  }>,
): Promise<{ success: boolean; customer: Customer }> {
  return apiFetch(`/ledger-core/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Mirrors server/src/types/ledger-core.ts's InvoiceLine. */
export interface InvoiceLine {
  id: string;
  lineNumber: number;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  revenueAccountId: string;
  revenueAccountCode: string;
  revenueAccountName: string;
  taxRateBp: number;
  netCents: number;
  taxCents: number;
}

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'VOID';

/** Mirrors server/src/types/ledger-core.ts's SettlementStatus. Derived, never stored. */
export type SettlementStatus = 'NOT_APPLICABLE' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE';

/** Mirrors server/src/types/ledger-core.ts's Invoice. */
export interface Invoice {
  id: string;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  customerId: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  customerNameSnapshot: string;
  customerAddressSnapshot: string | null;
  customerTaxNumberSnapshot: string | null;
  notes: string | null;
  paymentTerms: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Phase 8. NUMERIC(18,8) as a string. '1.00000000' for a base-currency invoice. */
  fxRate: string;
  baseSubtotalCents: number;
  baseTaxCents: number;
  baseTotalCents: number;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  lines: InvoiceLine[];
  allocatedCents: number;
  amountDueCents: number;
  settlementStatus: SettlementStatus;
}

export type SettlementFilter = 'OUTSTANDING' | 'OVERDUE' | 'PAID';

export interface InvoiceFilters {
  page?: number;
  limit?: number;
  status?: InvoiceStatus | '';
  customerId?: string;
  from?: string;
  to?: string;
  q?: string;
  settlement?: SettlementFilter | '';
}

/** GET /ledger-core/invoices — paginated, filterable, lines nested. */
export function listInvoices(
  params: InvoiceFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  invoices: Invoice[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.customerId !== undefined && params.customerId !== '') query.set('customerId', params.customerId);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.settlement !== undefined && params.settlement !== '') query.set('settlement', params.settlement);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ledger-core/invoices${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/invoices/:id */
export function getInvoice(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/ledger-core/invoices/${id}`, { signal: signal ?? null });
}

export interface InvoiceLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  revenueAccountId: string;
  taxRateBp: number;
}

export interface InvoiceInput {
  customerId: string;
  issueDate: string;
  dueDate: string;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string;
  notes: string | null;
  paymentTerms: string | null;
  lines: InvoiceLineInput[];
}

/** POST /ledger-core/invoices — always drafted, never posted directly. */
export function createInvoice(body: InvoiceInput): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch('/ledger-core/invoices', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /ledger-core/invoices/:id — a draft only. */
export function updateInvoice(
  id: string,
  body: InvoiceInput,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/ledger-core/invoices/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /ledger-core/invoices/:id — a draft only. */
export async function deleteInvoice(id: string): Promise<void> {
  await apiFetch(`/ledger-core/invoices/${id}`, { method: 'DELETE' });
}

/** POST /ledger-core/invoices/:id/issue — allocates a number and posts a balanced journal entry. */
export function issueInvoice(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/ledger-core/invoices/${id}/issue`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/**
 * POST /ledger-core/invoices/:id/void — the only correction path once issued.
 * Posts a reversing journal entry; a draft is voided with no GL posting.
 */
export function voidInvoice(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/ledger-core/invoices/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/** Mirrors server/src/types/ledger-core.ts's InvoiceSettings. */
export interface InvoiceSettings {
  numberPrefix: string;
  numberPadding: number;
  nextNumber: number;
  defaultDueDays: number;
  defaultTaxRateBp: number;
  taxLabel: string;
  receivableAccountId: string | null;
  defaultRevenueAccountId: string | null;
  taxPayableAccountId: string | null;
  showTaxNumber: boolean;
  showBusinessNumber: boolean;
  showLegalName: boolean;
  billingAddress: string | null;
  paymentTerms: string | null;
  footerNotes: string | null;
  accentColor: string;
  configured: boolean;
}

/** GET /ledger-core/settings/invoicing — defaults returned even before the org has ever saved one. */
export async function getInvoiceSettings(signal?: AbortSignal): Promise<InvoiceSettings> {
  const body = await apiFetch<{ success: boolean; invoiceSettings: InvoiceSettings }>(
    '/ledger-core/settings/invoicing',
    { signal: signal ?? null },
  );
  return body.invoiceSettings;
}

/** PATCH /ledger-core/settings/invoicing — OWNER/ADMIN only. */
export async function updateInvoiceSettings(
  input: Partial<InvoiceSettings>,
): Promise<InvoiceSettings> {
  const body = await apiFetch<{ success: boolean; invoiceSettings: InvoiceSettings }>(
    '/ledger-core/settings/invoicing',
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return body.invoiceSettings;
}

/* ------------------------------------------------------ ledger-core: accounts payable */

/** Mirrors server/src/types/ledger-core.ts's Vendor. */
export interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  paymentTerms: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /ledger-core/vendors */
export function listVendors(
  params: { q?: string; includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; vendors: Vendor[] }> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.includeInactive === true) query.set('includeInactive', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/ledger-core/vendors${suffix}`, { signal: signal ?? null });
}

/** POST /ledger-core/vendors */
export function createVendor(body: {
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  paymentTerms: string | null;
  notes: string | null;
}): Promise<{ success: boolean; vendor: Vendor }> {
  return apiFetch('/ledger-core/vendors', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /ledger-core/vendors/:id */
export function updateVendor(
  id: string,
  body: Partial<{
    name: string;
    email: string | null;
    phone: string | null;
    billingAddress: string | null;
    taxNumber: string | null;
    paymentTerms: string | null;
    notes: string | null;
    isActive: boolean;
  }>,
): Promise<{ success: boolean; vendor: Vendor }> {
  return apiFetch(`/ledger-core/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Mirrors server/src/types/ledger-core.ts's BillLine. */
export interface BillLine {
  id: string;
  lineNumber: number;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  expenseAccountId: string;
  expenseAccountCode: string;
  expenseAccountName: string;
  taxRateBp: number;
  netCents: number;
  taxCents: number;
}

export type BillStatus = 'DRAFT' | 'AWAITING_APPROVAL' | 'POSTED' | 'VOID';

/** Mirrors server/src/types/ledger-core.ts's Bill. */
export interface Bill {
  id: string;
  vendorReference: string;
  status: BillStatus;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  currencyCode: string;
  vendorNameSnapshot: string;
  vendorAddressSnapshot: string | null;
  vendorTaxNumberSnapshot: string | null;
  notes: string | null;
  paymentTerms: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Phase 8. NUMERIC(18,8) as a string. '1.00000000' for a base-currency bill. */
  fxRate: string;
  baseSubtotalCents: number;
  baseTaxCents: number;
  baseTotalCents: number;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  submittedAt: string | null;
  postedAt: string | null;
  voidedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  lines: BillLine[];
  allocatedCents: number;
  amountDueCents: number;
  settlementStatus: SettlementStatus;
}

export interface BillFilters {
  page?: number;
  limit?: number;
  status?: BillStatus | '';
  vendorId?: string;
  from?: string;
  to?: string;
  q?: string;
  settlement?: SettlementFilter | '';
}

/** GET /ledger-core/bills — paginated, filterable, lines nested. */
export function listBills(
  params: BillFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  bills: Bill[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.vendorId !== undefined && params.vendorId !== '') query.set('vendorId', params.vendorId);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.settlement !== undefined && params.settlement !== '') query.set('settlement', params.settlement);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ledger-core/bills${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/bills/:id */
export function getBill(id: string, signal?: AbortSignal): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/ledger-core/bills/${id}`, { signal: signal ?? null });
}

export interface BillLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  expenseAccountId: string;
  taxRateBp: number;
}

export interface BillInput {
  vendorId: string;
  vendorReference: string;
  billDate: string;
  dueDate: string;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string;
  notes: string | null;
  paymentTerms: string | null;
  lines: BillLineInput[];
}

/** POST /ledger-core/bills — always drafted, never posted directly. */
export function createBill(body: BillInput): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch('/ledger-core/bills', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /ledger-core/bills/:id — draft or in-review only. */
export function updateBill(id: string, body: BillInput): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/ledger-core/bills/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /ledger-core/bills/:id — draft or in-review only. */
export async function deleteBill(id: string): Promise<void> {
  await apiFetch(`/ledger-core/bills/${id}`, { method: 'DELETE' });
}

/** POST /ledger-core/bills/:id/submit — sends a draft for approval. */
export function submitBill(id: string): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/ledger-core/bills/${id}/submit`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /ledger-core/bills/:id/approve — OWNER/ADMIN only; posts a balanced journal entry. */
export function approveBill(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/ledger-core/bills/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/**
 * POST /ledger-core/bills/:id/void — the only correction path once posted.
 * Posts a reversing journal entry; a draft/in-review bill is voided with no GL posting.
 */
export function voidBill(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/ledger-core/bills/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/* ---------------------------------------------------------- ledger-core: payments */

export type PaymentDirection = 'RECEIVE' | 'PAY';
export type PaymentStatus = 'POSTED' | 'VOID';

/** Mirrors server/src/types/ledger-core.ts's PaymentAllocation. */
export interface PaymentAllocation {
  id: string;
  invoiceId: string | null;
  billId: string | null;
  documentReference: string;
  documentTotalCents: number;
  amountCents: number;
  /** Phase 8. amountCents converted to base currency at the document's own frozen rate. */
  baseAmountCents: number;
}

/** Mirrors server/src/types/ledger-core.ts's Payment. */
export interface Payment {
  id: string;
  direction: PaymentDirection;
  status: PaymentStatus;
  paymentDate: string;
  currencyCode: string;
  amountCents: number;
  /** Phase 8. NUMERIC(18,8) as a string. '1.00000000' for a base-currency payment. */
  fxRate: string;
  baseAmountCents: number;
  cashAccountId: string;
  cashAccountCode: string;
  cashAccountName: string;
  customerId: string | null;
  vendorId: string | null;
  counterpartyName: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  voidedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  allocations: PaymentAllocation[];
}

export interface PaymentFilters {
  page?: number;
  limit?: number;
  direction?: PaymentDirection | '';
  status?: PaymentStatus | '';
  customerId?: string;
  vendorId?: string;
  from?: string;
  to?: string;
}

/** GET /ledger-core/payments */
export function listPayments(
  params: PaymentFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  payments: Payment[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.direction !== undefined && params.direction !== '') query.set('direction', params.direction);
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.customerId !== undefined && params.customerId !== '') query.set('customerId', params.customerId);
  if (params.vendorId !== undefined && params.vendorId !== '') query.set('vendorId', params.vendorId);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ledger-core/payments${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/payments/:id */
export function getPayment(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; payment: Payment }> {
  return apiFetch(`/ledger-core/payments/${id}`, { signal: signal ?? null });
}

export interface PaymentAllocationInput {
  invoiceId: string | null;
  billId: string | null;
  amountCents: number;
}

export interface PaymentInput {
  direction: PaymentDirection;
  paymentDate: string;
  amountCents: number;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string;
  cashAccountId: string;
  customerId: string | null;
  vendorId: string | null;
  method: string | null;
  reference: string | null;
  notes: string | null;
  allocations: PaymentAllocationInput[];
  entryDate: string | null;
}

/** POST /ledger-core/payments — born posted; posts a balanced journal entry in the same transaction. */
export function createPayment(body: PaymentInput): Promise<{ success: boolean; payment: Payment }> {
  return apiFetch('/ledger-core/payments', { method: 'POST', body: JSON.stringify(body) });
}

/** POST /ledger-core/payments/:id/void — the only correction path; posts a reversing journal entry. */
export function voidPayment(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; payment: Payment }> {
  return apiFetch(`/ledger-core/payments/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/* ------------------------------------------------------- ledger-core: AR/AP aging */

export interface AgingCounterpartyRow {
  counterpartyId: string;
  counterpartyName: string;
  currentCents: number;
  d1to30Cents: number;
  d31to60Cents: number;
  d61to90Cents: number;
  d90PlusCents: number;
  totalCents: number;
}

/** Mirrors server/src/types/ledger-core.ts's AgingReport. */
export interface AgingReport {
  asOf: string;
  kind: 'AR' | 'AP';
  buckets: AgingBucketAmount[];
  totalOutstandingCents: number;
  totalOverdueCents: number;
  controlAccount: { id: string; code: string; name: string; balanceCents: number } | null;
  reconciles: boolean | null;
  rows: AgingCounterpartyRow[];
}

/** GET /ledger-core/reports/ar-aging?asOf=YYYY-MM-DD */
export async function getArAging(asOf: string | null = null, signal?: AbortSignal): Promise<AgingReport> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & AgingReport>(
    `/ledger-core/reports/ar-aging${suffix}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

/** GET /ledger-core/reports/ap-aging?asOf=YYYY-MM-DD */
export async function getApAging(asOf: string | null = null, signal?: AbortSignal): Promise<AgingReport> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & AgingReport>(
    `/ledger-core/reports/ap-aging${suffix}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

/* ---------------------------------------------------- ledger-core: Phase 4 statements */

export interface StatementRow {
  accountId: string;
  code: string;
  name: string;
  type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
  amountCents: number;
}

export interface StatementSection {
  rows: StatementRow[];
  totalCents: number;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfitCents: number;
  operatingExpenses: StatementSection;
  netIncomeCents: number;
}

/** GET /ledger-core/reports/profit-and-loss?from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function getProfitAndLoss(
  from: string | null = null,
  to: string | null = null,
  signal?: AbortSignal,
): Promise<ProfitAndLoss> {
  const params = new URLSearchParams();
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  const suffix = params.size === 0 ? '' : `?${params.toString()}`;
  const body = await apiFetch<{ success: boolean } & ProfitAndLoss>(
    `/ledger-core/reports/profit-and-loss${suffix}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

export interface BalanceSheetEquity extends StatementSection {
  retainedEarningsCents: number;
  currentEarningsCents: number;
}

export interface BalanceSheet {
  asOf: string;
  fiscalYearStartDate: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: BalanceSheetEquity;
  totalLiabilitiesAndEquityCents: number;
  balances: boolean;
}

/** GET /ledger-core/reports/balance-sheet?asOf=YYYY-MM-DD */
export async function getBalanceSheet(
  asOf: string | null = null,
  signal?: AbortSignal,
): Promise<BalanceSheet> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & BalanceSheet>(
    `/ledger-core/reports/balance-sheet${suffix}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

export const FISCAL_PERIOD_STATUSES = ['OPEN', 'CLOSED', 'LOCKED'] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

export interface FiscalPeriod {
  id: string;
  fiscalYearLabel: string;
  periodNumber: number;
  startsOn: string;
  endsOn: string;
  status: FiscalPeriodStatus;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  lockedAt: string | null;
  entryCount: number;
  createdAt: string;
}

/** GET /ledger-core/fiscal-periods?fiscalYear=&status= */
export function getFiscalPeriods(
  status?: FiscalPeriodStatus,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; periods: FiscalPeriod[] }> {
  const suffix = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
  return apiFetch(`/ledger-core/fiscal-periods${suffix}`, { signal: signal ?? null });
}

/** POST /ledger-core/fiscal-periods/generate */
export function generateFiscalPeriods(containingDate: string): Promise<{
  success: boolean;
  fiscalYearLabel: string;
  created: boolean;
  count: number;
  periods: FiscalPeriod[];
}> {
  return apiFetch('/ledger-core/fiscal-periods/generate', {
    method: 'POST',
    body: JSON.stringify({ containingDate }),
  });
}

/** POST /ledger-core/fiscal-periods/:id/close */
export function closeFiscalPeriod(id: string): Promise<{ success: boolean; period: FiscalPeriod }> {
  return apiFetch(`/ledger-core/fiscal-periods/${id}/close`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /ledger-core/fiscal-periods/:id/reopen */
export function reopenFiscalPeriod(id: string): Promise<{ success: boolean; period: FiscalPeriod }> {
  return apiFetch(`/ledger-core/fiscal-periods/${id}/reopen`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /ledger-core/fiscal-periods/:id/lock — OWNER only; irreversible. */
export function lockFiscalPeriod(id: string): Promise<{ success: boolean; period: FiscalPeriod }> {
  return apiFetch(`/ledger-core/fiscal-periods/${id}/lock`, { method: 'POST', body: JSON.stringify({}) });
}

/* --------------------------------------------------------- audit trail (Phase 5) */

export type AuditOperation = 'INSERT' | 'UPDATE' | 'DELETE';

/** One row of the trail, without its before/after images — the list view's shape. */
export interface AuditLogEntry {
  id: string;
  txid: string;
  appSlug: string;
  tableName: string;
  rowId: string | null;
  operation: AuditOperation;
  changedKeys: string[] | null;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  clientIp: string | null;
  createdAt: string;
}

/** One entry, plus the full before/after row images — the detail view's shape. */
export interface AuditLogDetail extends AuditLogEntry {
  oldRow: Record<string, unknown> | null;
  newRow: Record<string, unknown> | null;
}

export interface AuditLogFilters {
  page?: number;
  limit?: number;
  appSlug?: string;
  tableName?: string;
  operation?: AuditOperation;
}

/**
 * GET /audit-logs — platform-level, not under /ledger-core: the trail spans
 * every app (guardrails rule 16). OWNER/ADMIN only; a 403 is expected from
 * every other role and is handled by the page, not hidden by this function.
 */
export function getAuditLogs(
  params: AuditLogFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  logs: AuditLogEntry[];
}> {
  const query = new URLSearchParams();
  // An empty filter box must send no parameter at all, not `?appSlug=`.
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.appSlug !== undefined && params.appSlug !== '') query.set('appSlug', params.appSlug);
  if (params.tableName !== undefined && params.tableName !== '') query.set('tableName', params.tableName);
  if (params.operation !== undefined) query.set('operation', params.operation);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/audit-logs${suffix}`, { signal: signal ?? null });
}

/** GET /audit-logs/:id — the full before/after row images for one entry. */
export function getAuditLogDetail(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; log: AuditLogDetail }> {
  return apiFetch(`/audit-logs/${id}`, { signal: signal ?? null });
}

// ------------------------------------------------- Phase 6 — bank reconciliation

export type BankTransactionStatus = 'UNMATCHED' | 'MATCHED' | 'IGNORED';
export type DateFormat = 'ISO' | 'DMY' | 'MDY';

/** Mirrors server/src/types/ledger-core.ts's BankStatementImport. */
export interface BankStatementImport {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  fileName: string;
  dateFormat: string;
  delimiter: string;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  closingBalanceCents: number | null;
  closingBalanceOn: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

export interface ScoreComponent {
  points: number;
  maxPoints: number;
  reason: string;
}

export interface ScoreBreakdown {
  amount: ScoreComponent;
  date: ScoreComponent;
  counterparty: ScoreComponent;
  total: number;
}

/** Mirrors server/src/types/ledger-core.ts's BankMatchSuggestion. */
export interface BankMatchSuggestion {
  id: string;
  targetType: 'invoice' | 'bill';
  invoiceId: string | null;
  billId: string | null;
  documentReference: string;
  documentDate: string;
  counterpartyName: string;
  documentTotalCents: number;
  documentAmountDueCents: number;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  autoMatchable: boolean;
}

/** Mirrors server/src/types/ledger-core.ts's BankTransaction. */
export interface BankTransaction {
  id: string;
  importId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  txnDate: string;
  description: string;
  externalReference: string | null;
  currencyCode: string;
  /** Signed: > 0 money in, < 0 money out. */
  amountCents: number;
  status: BankTransactionStatus;
  matchedPaymentId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  matchedByName: string | null;
  createdAt: string;
  updatedAt: string;
  suggestions: BankMatchSuggestion[];
}

export interface BankReconciliationReport {
  accountId: string;
  accountCode: string;
  accountName: string;
  asOf: string;
  glBalanceCents: number;
  statementBalanceCents: number;
  differenceCents: number;
  reconciles: boolean;
  matchedCount: number;
  matchedCents: number;
  unmatchedCount: number;
  unmatchedCents: number;
  ignoredCount: number;
  statedClosingBalanceCents: number | null;
  statedClosingBalanceOn: string | null;
  statedClosingDifferenceCents: number | null;
}

export interface ImportStatementColumnMap {
  date: string;
  description: string;
  amount: string | null;
  debit: string | null;
  credit: string | null;
  reference: string | null;
}

export interface ImportStatementInput {
  accountId: string;
  fileName: string;
  content: string;
  dateFormat: DateFormat;
  columnMap: ImportStatementColumnMap | null;
  closingBalanceCents: number | null;
  closingBalanceOn: string | null;
}

/** POST /ledger-core/bank-imports — the CSV text goes in the JSON body, never a multipart upload. */
export function importBankStatement(body: ImportStatementInput): Promise<{
  success: boolean;
  import: BankStatementImport;
  importedCount: number;
  duplicateCount: number;
  suggestedCount: number;
  autoMatchableCount: number;
}> {
  return apiFetch('/ledger-core/bank-imports', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /ledger-core/bank-imports */
export function listBankImports(
  params: { page?: number; limit?: number; accountId?: string } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  imports: BankStatementImport[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.accountId !== undefined && params.accountId !== '') query.set('accountId', params.accountId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ledger-core/bank-imports${suffix}`, { signal: signal ?? null });
}

export interface BankTransactionFilters {
  page?: number;
  limit?: number;
  accountId?: string;
  importId?: string;
  status?: BankTransactionStatus | '';
  from?: string;
  to?: string;
  q?: string;
  minScore?: number;
}

/** GET /ledger-core/bank-transactions */
export function listBankTransactions(
  params: BankTransactionFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  transactions: BankTransaction[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.accountId !== undefined && params.accountId !== '') query.set('accountId', params.accountId);
  if (params.importId !== undefined && params.importId !== '') query.set('importId', params.importId);
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.minScore !== undefined) query.set('minScore', String(params.minScore));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ledger-core/bank-transactions${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/bank-transactions/:id */
export function getBankTransaction(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/ledger-core/bank-transactions/${id}`, { signal: signal ?? null });
}

/** POST /ledger-core/bank-transactions/:id/rescore */
export function rescoreBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/ledger-core/bank-transactions/${id}/rescore`, { method: 'POST', body: JSON.stringify({}) });
}

export interface MatchBankTransactionInput {
  suggestionId: string | null;
  invoiceId: string | null;
  billId: string | null;
}

/** POST /ledger-core/bank-transactions/:id/match */
export function matchBankTransaction(
  id: string,
  body: MatchBankTransactionInput,
): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/ledger-core/bank-transactions/${id}/match`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /ledger-core/bank-transactions/:id/unmatch — voids the payment the match created. */
export function unmatchBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/ledger-core/bank-transactions/${id}/unmatch`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /ledger-core/bank-transactions/:id/ignore */
export function ignoreBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/ledger-core/bank-transactions/${id}/ignore`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /ledger-core/bank-transactions/:id/unignore */
export function unignoreBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/ledger-core/bank-transactions/${id}/unignore`, { method: 'POST', body: JSON.stringify({}) });
}

/**
 * GET /ledger-core/reports/bank-reconciliation — `reconciles` is a
 * completeness claim (every GL cash movement also arrived as an imported
 * bank line, and vice versa), not a correctness one.
 */
export function getBankReconciliation(
  accountId: string,
  asOf: string | null,
  signal?: AbortSignal,
): Promise<{ success: boolean } & BankReconciliationReport> {
  const query = new URLSearchParams({ accountId });
  if (asOf !== null) query.set('asOf', asOf);
  return apiFetch(`/ledger-core/reports/bank-reconciliation?${query.toString()}`, { signal: signal ?? null });
}

/* ------------------------------------------ webhooks & background jobs (Phase 7) */

/** Mirrors server/src/types/webhooks.ts's OUTBOX_EVENT_TYPES exactly. */
export const OUTBOX_EVENT_TYPES = [
  'invoice.issued',
  'bill.approved',
  'payment.recorded',
  'fiscal_period.closed',
  'bank.large_unmatched',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export type WebhookDeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

export interface WebhookEndpoint {
  id: string;
  url: string;
  label: string;
  eventTypes: OutboxEventType[];
  isActive: boolean;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Present only on the response from create and rotate-secret. */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

/** GET /webhooks — platform-level: not under /ledger-core (guardrails rule 16). */
export function getWebhookEndpoints(
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; endpoints: WebhookEndpoint[] }> {
  return apiFetch('/webhooks', { signal: signal ?? null });
}

/** GET /webhooks/:id */
export function getWebhookEndpoint(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; endpoint: WebhookEndpoint }> {
  return apiFetch(`/webhooks/${id}`, { signal: signal ?? null });
}

export interface CreateWebhookEndpointInput {
  url: string;
  label: string;
  eventTypes: OutboxEventType[];
}

/** POST /webhooks — the only response, besides rotate-secret, that ever carries a secret. */
export function createWebhookEndpoint(
  input: CreateWebhookEndpointInput,
): Promise<{ success: boolean; endpoint: WebhookEndpointWithSecret; secretNotice: string }> {
  return apiFetch('/webhooks', { method: 'POST', body: JSON.stringify(input) });
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  label?: string;
  eventTypes?: OutboxEventType[];
  isActive?: boolean;
}

/** PATCH /webhooks/:id */
export function updateWebhookEndpoint(
  id: string,
  input: UpdateWebhookEndpointInput,
): Promise<{ success: boolean; endpoint: WebhookEndpoint }> {
  return apiFetch(`/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** DELETE /webhooks/:id — OWNER only. Also deletes the endpoint's delivery history (cascade). */
export function deleteWebhookEndpoint(id: string): Promise<null> {
  return apiFetch(`/webhooks/${id}`, { method: 'DELETE' });
}

/** POST /webhooks/:id/rotate-secret — OWNER only. */
export function rotateWebhookSecret(
  id: string,
): Promise<{ success: boolean; endpoint: WebhookEndpointWithSecret; secretNotice: string }> {
  return apiFetch(`/webhooks/${id}/rotate-secret`, { method: 'POST', body: JSON.stringify({}) });
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  endpointLabel: string;
  endpointUrl: string;
  eventId: string;
  eventType: OutboxEventType;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: Record<string, unknown>;
}

export interface WebhookDeliveryFilters {
  page?: number;
  limit?: number;
  endpointId?: string;
  status?: WebhookDeliveryStatus;
  eventType?: string;
  from?: string;
  to?: string;
}

/** GET /webhook-deliveries */
export function getWebhookDeliveries(
  params: WebhookDeliveryFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  deliveries: WebhookDelivery[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.endpointId !== undefined && params.endpointId !== '') query.set('endpointId', params.endpointId);
  if (params.status !== undefined) query.set('status', params.status);
  if (params.eventType !== undefined && params.eventType !== '') query.set('eventType', params.eventType);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/webhook-deliveries${suffix}`, { signal: signal ?? null });
}

/** GET /webhook-deliveries/:id */
export function getWebhookDelivery(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; delivery: WebhookDeliveryDetail }> {
  return apiFetch(`/webhook-deliveries/${id}`, { signal: signal ?? null });
}

/** POST /webhook-deliveries/:id/retry — 202 Accepted; only legal from FAILED. */
export function retryWebhookDelivery(
  id: string,
): Promise<{ success: boolean; delivery: { id: string; status: WebhookDeliveryStatus } }> {
  return apiFetch(`/webhook-deliveries/${id}/retry`, { method: 'POST', body: JSON.stringify({}) });
}

/* ------------------------------------------------------------- ledger-core: FX */

/** Mirrors server/src/types/ledger-core.ts's FxRate. */
export interface FxRate {
  id: string;
  fromCode: string;
  toCode: string;
  rateDate: string;
  /** NUMERIC(18,8) as a string, never a number — never round-trip through JSON. */
  rate: string;
  source: 'MANUAL' | 'IMPORT';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors server/src/types/ledger-core.ts's ResolvedRate. */
export interface ResolvedRate {
  fromCode: string;
  toCode: string;
  rate: string;
  rateDate: string;
  identity: boolean;
}

export interface FxRateFilters {
  page?: number;
  limit?: number;
  fromCode?: string;
  from?: string;
  to?: string;
}

/** GET /ledger-core/fx-rates */
export function listFxRates(
  params: FxRateFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  rates: FxRate[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.fromCode !== undefined && params.fromCode !== '') query.set('fromCode', params.fromCode);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/ledger-core/fx-rates${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/fx-rates/latest?from=<currency>&on=YYYY-MM-DD */
export function getLatestFxRate(
  fromCode: string,
  on?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; rate: ResolvedRate }> {
  const query = new URLSearchParams({ from: fromCode });
  if (on !== undefined) query.set('on', on);
  return apiFetch(`/ledger-core/fx-rates/latest?${query.toString()}`, { signal: signal ?? null });
}

/** POST /ledger-core/fx-rates — re-posting the same (fromCode, toCode, rateDate) overwrites. */
export function upsertFxRate(body: {
  fromCode: string;
  toCode: string;
  rateDate: string;
  rate: string;
}): Promise<{ success: boolean; rate: FxRate }> {
  return apiFetch('/ledger-core/fx-rates', { method: 'POST', body: JSON.stringify(body) });
}

/** DELETE /ledger-core/fx-rates/:id */
export function deleteFxRate(id: string): Promise<void> {
  return apiFetch(`/ledger-core/fx-rates/${id}`, { method: 'DELETE' });
}

/** Mirrors server/src/types/ledger-core.ts's FxExposureDocument. */
export interface FxExposureDocument {
  documentType: 'INVOICE' | 'BILL';
  documentId: string;
  documentNumber: string | null;
  counterpartyName: string;
  currencyCode: string;
  outstandingCents: number;
  documentRate: string;
  revaluationRate: string;
  carryingBaseCents: number;
  revaluedBaseCents: number;
  deltaCents: number;
}

/** Mirrors server/src/types/ledger-core.ts's FxExposureReport. */
export interface FxExposureReport {
  asOfDate: string;
  baseCurrency: string;
  documents: FxExposureDocument[];
  byCurrency: {
    currencyCode: string;
    outstandingCents: number;
    carryingBaseCents: number;
    revaluedBaseCents: number;
    deltaCents: number;
  }[];
  totalDeltaCents: number;
  alreadyRevalued: boolean;
}

/** GET /ledger-core/reports/fx-exposure?asOf=YYYY-MM-DD — read-only preview, posts nothing. */
export function getFxExposure(
  asOf?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; exposure: FxExposureReport }> {
  const query = asOf !== undefined ? `?asOf=${asOf}` : '';
  return apiFetch(`/ledger-core/reports/fx-exposure${query}`, { signal: signal ?? null });
}

/** Mirrors server/src/types/ledger-core.ts's FxRevaluationLine. */
export interface FxRevaluationLine {
  id: string;
  documentType: 'INVOICE' | 'BILL';
  invoiceId: string | null;
  billId: string | null;
  documentNumber: string | null;
  counterpartyName: string;
  currencyCode: string;
  outstandingCents: number;
  documentRate: string;
  revaluationRate: string;
  carryingBaseCents: number;
  revaluedBaseCents: number;
  deltaCents: number;
}

/** Mirrors server/src/types/ledger-core.ts's FxRevaluation. */
export interface FxRevaluation {
  id: string;
  asOfDate: string;
  journalEntryId: string;
  reversalJournalEntryId: string;
  totalDeltaCents: number;
  lineCount: number;
  createdBy: string;
  createdAt: string;
  lines: FxRevaluationLine[];
}

/** GET /ledger-core/fx-revaluations */
export function listFxRevaluations(
  params: { page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  revaluations: FxRevaluation[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/ledger-core/fx-revaluations${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/fx-revaluations/:id */
export function getFxRevaluation(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; revaluation: FxRevaluation }> {
  return apiFetch(`/ledger-core/fx-revaluations/${id}`, { signal: signal ?? null });
}

/** POST /ledger-core/fx-revaluations — OWNER/ADMIN only; posts a GL entry plus an automatic next-day reversal. */
export function runFxRevaluation(asOfDate: string): Promise<{ success: boolean; revaluation: FxRevaluation }> {
  return apiFetch('/ledger-core/fx-revaluations', { method: 'POST', body: JSON.stringify({ asOfDate }) });
}

/* -------------------------------------------------------- platform: onboarding (Phase 9a) */

/** Mirrors server/src/types/onboarding.ts's OnboardingStatus. */
export type OnboardingStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SKIPPED' | 'COMPLETED';

/** Mirrors server/src/types/onboarding.ts's OnboardingState. */
export interface OnboardingState {
  appSlug: string;
  status: OnboardingStatus;
  currentStep: string | null;
  draft: Record<string, unknown>;
  completedAt: string | null;
  skippedAt: string | null;
  updatedAt: string | null;
}

/** Mirrors server/src/types/onboarding.ts's OnboardingChecklistItem. */
export interface OnboardingChecklistItem extends OnboardingState {
  appName: string;
  appStatus: AppStatus;
}

/** GET /onboarding — platform-level; every app plus 'platform', a missing row reads as NOT_STARTED. */
export function getOnboardingChecklist(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  items: OnboardingChecklistItem[];
}> {
  return apiFetch('/onboarding', { signal: signal ?? null });
}

/** GET /onboarding/:appSlug */
export async function getOnboardingState(appSlug: string, signal?: AbortSignal): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${appSlug}`,
    { signal: signal ?? null },
  );
  return body.onboarding;
}

/** PUT /onboarding/:appSlug/draft — OWNER/ADMIN only. */
export async function saveOnboardingDraft(
  appSlug: string,
  input: { currentStep: string | null; draft: Record<string, unknown> },
): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${appSlug}/draft`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
  return body.onboarding;
}

/** POST /onboarding/:appSlug/skip — OWNER/ADMIN only; the draft is preserved. */
export async function skipOnboarding(appSlug: string): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${appSlug}/skip`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return body.onboarding;
}

/** POST /onboarding/:appSlug/resume — OWNER/ADMIN only; legal from SKIPPED or COMPLETED. */
export async function resumeOnboarding(appSlug: string): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${appSlug}/resume`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return body.onboarding;
}

/* ---------------------------------------------- ledger-core: migration imports (9b) */

export type MigrationImportKind = 'CHART_OF_ACCOUNTS' | 'OPENING_BALANCES';
export type MigrationImportStatus = 'DRAFT' | 'VALIDATED' | 'COMMITTED';
export type MigrationRowStatus = 'VALID' | 'INVALID' | 'EXCLUDED';

/** Mirrors server/src/types/ledger-core.ts's MigrationImport. */
export interface MigrationImport {
  id: string;
  kind: MigrationImportKind;
  status: MigrationImportStatus;
  fileName: string;
  delimiter: string;
  rowCount: number;
  errorCount: number;
  validCount: number;
  excludedCount: number;
  journalEntryId: string | null;
  committedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

/** Mirrors server/src/types/ledger-core.ts's MigrationImportRow. */
export interface MigrationImportRow {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  accountCode: string | null;
  accountName: string | null;
  accountType: AccountType | null;
  parentCode: string | null;
  description: string | null;
  debitCents: number | null;
  creditCents: number | null;
  errors: string[];
  status: MigrationRowStatus;
}

/** Mirrors server/src/types/ledger-core.ts's MigrationCommitPreview. */
export interface MigrationCommitPreview {
  kind: MigrationImportKind;
  canCommit: boolean;
  blockingErrorCount: number;
  accountsToCreate: number;
  accountsToMerge: number;
  totalDebitCents: number;
  totalCreditCents: number;
  /** Signed. Positive = a credit plug to 3400; negative = a debit plug. Zero = no plug. */
  plugCents: number;
  plugAccountCode: string;
  entryDate: string | null;
}

export type MigrationCommitResult =
  | { kind: 'CHART_OF_ACCOUNTS'; createdCount: number; mergedCount: number }
  | { kind: 'OPENING_BALANCES'; journalEntryId: string; plugCents: number };

/** POST /ledger-core/migration-imports — OWNER, ADMIN or ACCOUNTANT. */
export function createMigrationImport(body: {
  kind: MigrationImportKind;
  fileName: string;
  content: string;
}): Promise<{ success: boolean; import: MigrationImport; rows: MigrationImportRow[] }> {
  return apiFetch('/ledger-core/migration-imports', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /ledger-core/migration-imports */
export function listMigrationImports(
  params: { page?: number; limit?: number; kind?: MigrationImportKind } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  imports: MigrationImport[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.kind !== undefined) query.set('kind', params.kind);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/ledger-core/migration-imports${suffix}`, { signal: signal ?? null });
}

/** GET /ledger-core/migration-imports/:id */
export function getMigrationImport(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; import: MigrationImport }> {
  return apiFetch(`/ledger-core/migration-imports/${id}`, { signal: signal ?? null });
}

/** GET /ledger-core/migration-imports/:id/rows */
export function getMigrationImportRows(
  id: string,
  params: { page?: number; limit?: number; status?: MigrationRowStatus } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  rows: MigrationImportRow[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.status !== undefined) query.set('status', params.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/ledger-core/migration-imports/${id}/rows${suffix}`, { signal: signal ?? null });
}

/** PATCH /ledger-core/migration-imports/:id/rows/:rowId — OWNER, ADMIN or ACCOUNTANT. */
export function patchMigrationImportRow(
  id: string,
  rowId: string,
  body: Partial<{
    accountCode: string;
    accountName: string;
    accountType: AccountType;
    parentCode: string | null;
    description: string | null;
    debitCents: number;
    creditCents: number;
    status: 'VALID' | 'EXCLUDED';
  }>,
): Promise<{ success: boolean; import: MigrationImport; row: MigrationImportRow }> {
  return apiFetch(`/ledger-core/migration-imports/${id}/rows/${rowId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** POST /ledger-core/migration-imports/:id/validate — OWNER, ADMIN or ACCOUNTANT. */
export function validateMigrationImport(id: string): Promise<{ success: boolean; import: MigrationImport }> {
  return apiFetch(`/ledger-core/migration-imports/${id}/validate`, { method: 'POST', body: JSON.stringify({}) });
}

/** GET /ledger-core/migration-imports/:id/preview — OWNER, ADMIN or ACCOUNTANT. */
export function previewMigrationImport(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; preview: MigrationCommitPreview }> {
  return apiFetch(`/ledger-core/migration-imports/${id}/preview`, { signal: signal ?? null });
}

/** POST /ledger-core/migration-imports/:id/commit — OWNER/ADMIN only; irreversible. */
export function commitMigrationImport(
  id: string,
): Promise<{ success: boolean; import: MigrationImport; result: MigrationCommitResult }> {
  return apiFetch(`/ledger-core/migration-imports/${id}/commit`, { method: 'POST', body: JSON.stringify({}) });
}

/** DELETE /ledger-core/migration-imports/:id — refused once COMMITTED. */
export async function deleteMigrationImport(id: string): Promise<void> {
  await apiFetch(`/ledger-core/migration-imports/${id}`, { method: 'DELETE' });
}

/* --------------------------------------------------- document vault (9.5) */

/** Mirrors server/src/types/documents.ts's DocumentRecord. */
export interface VaultDocument {
  id: string;
  sha256: string;
  byteSize: number;
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/csv';
  originalFilename: string;
  uploadedBy: string;
  uploadedByName: string | null;
  createdAt: string;
  linkCount: number;
}

/** Mirrors server/src/types/documents.ts's DocumentLink. */
export interface VaultDocumentLink {
  id: string;
  documentId: string;
  appSlug: string;
  entityType: string;
  entityId: string;
  createdBy: string;
  createdAt: string;
}

export interface VaultDocumentWithLinks extends VaultDocument {
  links: VaultDocumentLink[];
}

export interface DocumentFilters {
  page?: number;
  limit?: number;
  appSlug?: string;
  entityType?: string;
  entityId?: string;
}

/** GET /documents — platform-level, not under /ledger-core (guardrails rule 16). */
export function listDocuments(
  params: DocumentFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  documents: VaultDocument[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.appSlug !== undefined && params.appSlug !== '') query.set('appSlug', params.appSlug);
  if (params.entityType !== undefined && params.entityType !== '') query.set('entityType', params.entityType);
  if (params.entityId !== undefined && params.entityId !== '') query.set('entityId', params.entityId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/documents${suffix}`, { signal: signal ?? null });
}

/** GET /documents/:id — includes its links. */
export function getDocument(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; document: VaultDocumentWithLinks }> {
  return apiFetch(`/documents/${id}`, { signal: signal ?? null });
}

/**
 * POST /documents — multipart. `201` for a new blob, `200` for an
 * already-vaulted one (upload is idempotent by content hash within an org).
 */
export function uploadDocument(
  file: File,
): Promise<{ success: boolean; document: VaultDocument; created: boolean }> {
  return apiUpload('/documents', () => {
    const body = new FormData();
    body.append('file', file);
    return body;
  });
}

/** GET /documents/:id/file — the stored original, streamed as a Blob. */
export function downloadDocument(id: string): Promise<{ blob: Blob; filename: string }> {
  return apiDownloadBlob(`/documents/${id}/file`);
}

/** DELETE /documents/:id — refused with 409 while any link exists. */
export async function deleteDocument(id: string): Promise<void> {
  await apiFetch(`/documents/${id}`, { method: 'DELETE' });
}

/** POST /documents/:id/links */
export function attachDocument(
  documentId: string,
  body: { appSlug: string; entityType: string; entityId: string },
): Promise<{ success: boolean; link: VaultDocumentLink }> {
  return apiFetch(`/documents/${documentId}/links`, { method: 'POST', body: JSON.stringify(body) });
}

/** DELETE /documents/:id/links/:linkId */
export async function detachDocument(documentId: string, linkId: string): Promise<void> {
  await apiFetch(`/documents/${documentId}/links/${linkId}`, { method: 'DELETE' });
}

function decodeErrorBody(body: unknown, status: number): string {
  return body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error
    : `Request failed with status ${status}`;
}

/**
 * Multipart upload. Deliberately NOT apiFetch: apiFetch forces
 * `Content-Type: application/json`, and a multipart body must let the
 * browser set the header itself so it can include the boundary token.
 *
 * `buildBody` is a factory, not a `FormData` value, because a 401 retry
 * needs its own fresh body — `FormData` built around a `File` is not safely
 * replayable the way a JSON string is, so `fetchWithAutoRefresh`'s
 * replay-the-same-init retry cannot be reused here. This function does its
 * own single retry instead, rebuilding the body on each attempt.
 */
export async function apiUpload<T>(path: string, buildBody: () => FormData): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not set — copy client/.env.example to client/.env');
  }

  const url = `${API_BASE_URL}${API_PREFIX}${path}`;
  const send = (): Promise<Response> =>
    fetch(url, { method: 'POST', credentials: 'include', body: buildBody() });

  let response = await send();

  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    } else {
      response = await send();
      if (response.status === 401) {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
    }
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiRequestError(response.status, decodeErrorBody(body, response.status));
  }

  return body as T;
}

/** Streams a file response into a Blob. Same credentials and refresh path as apiUpload. */
export async function apiDownloadBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not set — copy client/.env.example to client/.env');
  }

  const url = `${API_BASE_URL}${API_PREFIX}${path}`;
  const send = (): Promise<Response> => fetch(url, { credentials: 'include' });

  let response = await send();

  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    } else {
      response = await send();
      if (response.status === 401) {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
    }
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new ApiRequestError(response.status, decodeErrorBody(body, response.status));
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]*)"/.exec(disposition);
  const filename = match?.[1] ?? 'download';

  return { blob: await response.blob(), filename };
}

// ---------------------------------------------------------- ap-flow (10)

/** Mirrors server/src/types/ap-flow.ts's ApFlowDocumentStatus. */
export type ApFlowDocumentStatus = 'PENDING' | 'PROCESSING' | 'EXTRACTED' | 'FAILED' | 'POSTED';

export interface ApFlowLineItem {
  description: string;
  amountCents: number;
}

export interface ApFlowExtraction {
  id: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  lineItems: ApFlowLineItem[];
  fieldConfidence: Record<string, number>;
  arithmeticOk: boolean;
  validationErrors: string[];
  model: string;
  createdAt: string;
}

export interface ApFlowPage {
  id: string;
  pageNumber: number;
  widthPx: number;
  heightPx: number;
  redactedSha256: string;
  redactedRegions: { kind: string; box: { x0: number; y0: number; x1: number; y1: number } }[];
}

export interface ApFlowDocument {
  id: string;
  documentId: string;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  status: ApFlowDocumentStatus;
  pageCount: number | null;
  failureReason: string | null;
  processedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  /** Phase 11. Null until POSTED. */
  journalEntryId: string | null;
  postedSha256: string | null;
  postedAt: string | null;
}

/** Mirrors server/src/types/ap-flow.ts's ApFlowMappingSource. */
export type ApFlowMappingSource = 'HISTORY' | 'CHART' | 'MODEL' | 'MANUAL' | 'NONE';

export interface ApFlowLineItemRecord {
  id: string;
  lineIndex: number;
  description: string;
  amountCents: number;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  suggestedAccountId: string | null;
  mappingSource: ApFlowMappingSource;
  mappingConfidence: number | null;
}

export interface ApFlowReviewQueueEntry {
  id: string;
  documentId: string;
  originalFilename: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  totalCents: number | null;
  arithmeticOk: boolean;
  lineItemCount: number;
  unmappedLineCount: number;
  lowestConfidence: number | null;
  createdAt: string;
}

export interface ApFlowDocumentDetail extends ApFlowDocument {
  pages: ApFlowPage[];
  extraction: ApFlowExtraction | null;
  lineItems: ApFlowLineItemRecord[];
}

export interface ApFlowDocumentFilters {
  status?: ApFlowDocumentStatus;
  page?: number;
  limit?: number;
}

/** POST /ap-flow/documents — registers an already-vaulted document. */
export function createApFlowDocument(documentId: string): Promise<{ success: boolean; document: ApFlowDocument }> {
  return apiFetch('/ap-flow/documents', { method: 'POST', body: JSON.stringify({ documentId }) });
}

/** GET /ap-flow/documents */
export function listApFlowDocuments(
  params: ApFlowDocumentFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  documents: ApFlowDocument[];
}> {
  const query = new URLSearchParams();
  if (params.status !== undefined) query.set('status', params.status);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ap-flow/documents${suffix}`, { signal: signal ?? null });
}

/** GET /ap-flow/documents/:id */
export function getApFlowDocument(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; document: ApFlowDocumentDetail }> {
  return apiFetch(`/ap-flow/documents/${id}`, { signal: signal ?? null });
}

/** GET /ap-flow/documents/:id/pages/:pageNumber/image — the redacted preview, as a Blob. */
export function getApFlowPageImage(id: string, pageNumber: number): Promise<{ blob: Blob; filename: string }> {
  return apiDownloadBlob(`/ap-flow/documents/${id}/pages/${String(pageNumber)}/image`);
}

/** POST /ap-flow/documents/:id/reextract */
export function reextractApFlowDocument(id: string): Promise<{ success: boolean; document: ApFlowDocument }> {
  return apiFetch(`/ap-flow/documents/${id}/reextract`, { method: 'POST' });
}

// ---------------------------------------------------------- ap-flow (11)

/** GET /ap-flow/review-queue — documents awaiting human review, lowest confidence first. */
export function listApFlowReviewQueue(
  params: { page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  entries: ApFlowReviewQueueEntry[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ap-flow/review-queue${suffix}`, { signal: signal ?? null });
}

/** PATCH /ap-flow/documents/:id/line-items/:lineId — a reviewer's account override. */
export function updateApFlowLineItem(
  documentId: string,
  lineItemId: string,
  accountId: string,
): Promise<{ success: boolean; document: ApFlowDocumentDetail }> {
  return apiFetch(`/ap-flow/documents/${documentId}/line-items/${lineItemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ accountId }),
  });
}

/** POST /ap-flow/documents/:id/post — one-click approve & post into LedgerCore. No request body. */
export function postApFlowDocument(id: string): Promise<{ success: boolean; document: ApFlowDocumentDetail }> {
  return apiFetch(`/ap-flow/documents/${id}/post`, { method: 'POST' });
}

// ---------------------------------------------------------- fpa-engine (12)

export type FpaModelStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type FpaScenarioKind = 'BASE' | 'UPSIDE' | 'DOWNSIDE' | 'CUSTOM';
export type FpaAssumptionKind = 'GROWTH_BPS' | 'FIXED_CENTS' | 'PERCENT_OF_REVENUE_BPS';

export interface FpaScenario {
  id: string;
  modelId: string;
  name: string;
  kind: FpaScenarioKind;
  isDefault: boolean;
  dsoDays: number;
  dpoDays: number;
  taxRateBps: number;
  createdAt: string;
  updatedAt: string;
}

export interface FpaModel {
  id: string;
  name: string;
  description: string | null;
  startsOn: string;
  horizonMonths: number;
  actualsThrough: string;
  status: FpaModelStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  scenarioCount: number;
}

export interface FpaModelDetail extends FpaModel {
  scenarios: FpaScenario[];
}

export interface FpaAssumption {
  id: string;
  scenarioId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  kind: FpaAssumptionKind;
  growthBps: number | null;
  fixedCents: number | null;
  percentOfRevenueBps: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface FpaProjectedLine {
  accountId: string;
  code: string;
  name: string;
  type: string;
  amountCents: number;
}

export interface FpaProjectedMonth {
  month: string;
  incomeStatement: {
    lines: FpaProjectedLine[];
    revenueCents: number;
    costOfSalesCents: number;
    grossProfitCents: number;
    operatingExpensesCents: number;
    operatingIncomeCents: number;
    taxCents: number;
    netIncomeCents: number;
  };
  cashFlow: {
    netIncomeCents: number;
    changeInReceivablesCents: number;
    changeInPayablesCents: number;
    netCashFlowCents: number;
    openingCashCents: number;
    closingCashCents: number;
  };
  balanceSheet: {
    cashCents: number;
    receivablesCents: number;
    otherAssetsCents: number;
    totalAssetsCents: number;
    payablesCents: number;
    otherLiabilitiesCents: number;
    equityCents: number;
    retainedEarningsCents: number;
    totalLiabilitiesAndEquityCents: number;
    balances: boolean;
  };
}

export interface FpaProjection {
  months: FpaProjectedMonth[];
  runwayMonths: number | null;
  cashOutMonth: string | null;
  averageMonthlyBurnCents: number;
  balances: boolean;
}

export interface FpaProjectionResponse {
  modelId: string;
  modelName: string;
  scenarioId: string;
  scenarioName: string;
  baseCurrency: string;
  actualsThrough: string;
  actuals: { month: string; revenueCents: number; netIncomeCents: number }[];
  projection: FpaProjection;
}

export interface FpaScenarioSummary {
  scenarioId: string;
  scenarioName: string;
  kind: FpaScenarioKind;
  isDefault: boolean;
  runwayMonths: number | null;
  cashOutMonth: string | null;
  closingCashCents: number;
  totalRevenueCents: number;
  totalNetIncomeCents: number;
  balances: boolean;
}

export interface FpaComparisonResponse {
  modelId: string;
  modelName: string;
  baseCurrency: string;
  scenarios: FpaScenarioSummary[];
}

/** GET /fpa-engine/models */
export function listFpaModels(
  params: { status?: FpaModelStatus; page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  models: FpaModel[];
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
}> {
  const query = new URLSearchParams();
  if (params.status !== undefined) query.set('status', params.status);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/fpa-engine/models${suffix}`, { signal: signal ?? null });
}

/** GET /fpa-engine/models/:id */
export function getFpaModel(id: string, signal?: AbortSignal): Promise<{ success: boolean; model: FpaModelDetail }> {
  return apiFetch(`/fpa-engine/models/${id}`, { signal: signal ?? null });
}

/** POST /fpa-engine/models */
export function createFpaModel(body: {
  name: string;
  description?: string | null;
  startsOn: string;
  horizonMonths: number;
  actualsThrough: string;
}): Promise<{ success: boolean; model: FpaModelDetail }> {
  return apiFetch('/fpa-engine/models', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /fpa-engine/models/:id */
export function updateFpaModel(
  id: string,
  body: Partial<{
    name: string;
    description: string | null;
    startsOn: string;
    horizonMonths: number;
    actualsThrough: string;
    status: FpaModelStatus;
  }>,
): Promise<{ success: boolean; model: FpaModelDetail }> {
  return apiFetch(`/fpa-engine/models/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /fpa-engine/models/:id */
export async function deleteFpaModel(id: string): Promise<void> {
  await apiFetch(`/fpa-engine/models/${id}`, { method: 'DELETE' });
}

/** GET /fpa-engine/models/:id/scenarios */
export function listFpaScenarios(
  modelId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; scenarios: FpaScenario[]; count: number }> {
  return apiFetch(`/fpa-engine/models/${modelId}/scenarios`, { signal: signal ?? null });
}

/** POST /fpa-engine/models/:id/scenarios */
export function createFpaScenario(
  modelId: string,
  body: { name: string; kind: FpaScenarioKind; dsoDays: number; dpoDays: number; taxRateBps: number },
): Promise<{ success: boolean; scenario: FpaScenario }> {
  return apiFetch(`/fpa-engine/models/${modelId}/scenarios`, { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /fpa-engine/scenarios/:id */
export function updateFpaScenario(
  id: string,
  body: Partial<{
    name: string;
    kind: FpaScenarioKind;
    isDefault: true;
    dsoDays: number;
    dpoDays: number;
    taxRateBps: number;
  }>,
): Promise<{ success: boolean; scenario: FpaScenario }> {
  return apiFetch(`/fpa-engine/scenarios/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /fpa-engine/scenarios/:id */
export async function deleteFpaScenario(id: string): Promise<void> {
  await apiFetch(`/fpa-engine/scenarios/${id}`, { method: 'DELETE' });
}

/** GET /fpa-engine/scenarios/:id/assumptions */
export function listFpaAssumptions(
  scenarioId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; assumptions: FpaAssumption[]; count: number }> {
  return apiFetch(`/fpa-engine/scenarios/${scenarioId}/assumptions`, { signal: signal ?? null });
}

/** PUT /fpa-engine/scenarios/:id/assumptions/:accountId */
export function upsertFpaAssumption(
  scenarioId: string,
  accountId: string,
  body:
    | { kind: 'GROWTH_BPS'; growthBps: number }
    | { kind: 'FIXED_CENTS'; fixedCents: number }
    | { kind: 'PERCENT_OF_REVENUE_BPS'; percentOfRevenueBps: number },
): Promise<{ success: boolean; assumption: FpaAssumption }> {
  return apiFetch(`/fpa-engine/scenarios/${scenarioId}/assumptions/${accountId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** DELETE /fpa-engine/scenarios/:id/assumptions/:accountId */
export async function deleteFpaAssumption(scenarioId: string, accountId: string): Promise<void> {
  await apiFetch(`/fpa-engine/scenarios/${scenarioId}/assumptions/${accountId}`, { method: 'DELETE' });
}

/** GET /fpa-engine/scenarios/:id/projection */
export function getFpaProjection(
  scenarioId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean } & FpaProjectionResponse> {
  return apiFetch(`/fpa-engine/scenarios/${scenarioId}/projection`, { signal: signal ?? null });
}

/** GET /fpa-engine/models/:id/comparison */
export function getFpaComparison(
  modelId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean } & FpaComparisonResponse> {
  return apiFetch(`/fpa-engine/models/${modelId}/comparison`, { signal: signal ?? null });
}

// ---------------------------------------------------------- forecaster (13)

export type ForecasterPlanStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ForecasterDriverKind = 'COUNT' | 'CENTS' | 'BPS';
export type ForecasterLineKind = 'DRIVER_PRODUCT' | 'DRIVER_PERCENT' | 'FIXED_CENTS';
export type ForecasterBudgetStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
export type ForecasterBudgetLineSource = 'DRIVER' | 'HEADCOUNT' | 'MANUAL';

export interface ForecasterPlan {
  id: string;
  name: string;
  description: string | null;
  startsOn: string;
  horizonMonths: number;
  actualsThrough: string;
  status: ForecasterPlanStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterDriver {
  id: string;
  planId: string;
  name: string;
  unitLabel: string;
  kind: ForecasterDriverKind;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterDriverValue {
  driverId: string;
  month: string;
  value: number;
}

export interface ForecasterHeadcountRole {
  id: string;
  planId: string;
  title: string;
  department: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  startsOn: string;
  endsOn: string | null;
  fteCount: number;
  annualSalaryCents: number;
  loadingBps: number;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterForecastLine {
  id: string;
  planId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  label: string;
  kind: ForecasterLineKind;
  quantityDriverId: string | null;
  rateDriverId: string | null;
  sourceDriverId: string | null;
  percentBps: number | null;
  fixedCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterBuiltLine {
  lineId: string;
  label: string;
  accountId: string;
  amountCents: number;
  missingDriverValue: boolean;
}

export interface ForecasterBuiltRole {
  roleId: string;
  title: string;
  accountId: string;
  fteCount: number;
  amountCents: number;
}

export interface ForecasterBuiltMonth {
  month: string;
  lines: ForecasterBuiltLine[];
  roles: ForecasterBuiltRole[];
  accountTotals: { accountId: string; amountCents: number }[];
  totalCents: number;
}

export interface ForecasterForecastBuild {
  months: ForecasterBuiltMonth[];
  accountIds: string[];
  horizonTotals: { accountId: string; amountCents: number }[];
  hasMissingDriverValues: boolean;
}

export interface ForecasterForecastResponse {
  planId: string;
  planName: string;
  baseCurrency: string;
  startsOn: string;
  horizonMonths: number;
  actualsThrough: string;
  accounts: { accountId: string; code: string; name: string; type: AccountType }[];
  build: ForecasterForecastBuild;
}

export interface ForecasterBudgetVersion {
  id: string;
  planId: string;
  label: string;
  status: ForecasterBudgetStatus;
  createdBy: string;
  createdByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  lineCount: number;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterBudgetLine {
  id: string;
  versionId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  month: string;
  amountCents: number;
  source: ForecasterBudgetLineSource;
  justification: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForecasterBudgetVersionDetail extends ForecasterBudgetVersion {
  lines: ForecasterBudgetLine[];
}

export interface ForecasterVarianceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  month: string;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favourable: boolean;
}

export interface ForecasterVarianceResponse {
  planId: string;
  planName: string;
  versionId: string;
  versionLabel: string;
  baseCurrency: string;
  from: string;
  to: string;
  rows: ForecasterVarianceRow[];
}

/** GET /forecaster/plans */
export function listForecasterPlans(
  params: { status?: ForecasterPlanStatus; page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  plans: ForecasterPlan[];
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
}> {
  const query = new URLSearchParams();
  if (params.status !== undefined) query.set('status', params.status);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
  return apiFetch(`/forecaster/plans${suffix}`, { signal: signal ?? null });
}

/** GET /forecaster/plans/:id */
export function getForecasterPlan(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; plan: ForecasterPlan }> {
  return apiFetch(`/forecaster/plans/${id}`, { signal: signal ?? null });
}

/** POST /forecaster/plans */
export function createForecasterPlan(body: {
  name: string;
  description: string | null;
  startsOn: string;
  horizonMonths: number;
  actualsThrough: string;
}): Promise<{ success: boolean; plan: ForecasterPlan }> {
  return apiFetch('/forecaster/plans', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /forecaster/plans/:id */
export function updateForecasterPlan(
  id: string,
  body: Partial<{
    name: string;
    description: string | null;
    startsOn: string;
    horizonMonths: number;
    actualsThrough: string;
    status: ForecasterPlanStatus;
  }>,
): Promise<{ success: boolean; plan: ForecasterPlan }> {
  return apiFetch(`/forecaster/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /forecaster/plans/:id */
export async function deleteForecasterPlan(id: string): Promise<void> {
  await apiFetch(`/forecaster/plans/${id}`, { method: 'DELETE' });
}

/** POST /forecaster/plans/:id/roll */
export function rollForecasterPlan(id: string): Promise<{ success: boolean; plan: ForecasterPlan }> {
  return apiFetch(`/forecaster/plans/${id}/roll`, { method: 'POST' });
}

/** GET /forecaster/plans/:id/drivers */
export function listForecasterDrivers(
  planId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; drivers: ForecasterDriver[]; count: number }> {
  return apiFetch(`/forecaster/plans/${planId}/drivers`, { signal: signal ?? null });
}

/** POST /forecaster/plans/:id/drivers */
export function createForecasterDriver(
  planId: string,
  body: { name: string; unitLabel: string; kind: ForecasterDriverKind },
): Promise<{ success: boolean; driver: ForecasterDriver }> {
  return apiFetch(`/forecaster/plans/${planId}/drivers`, { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /forecaster/drivers/:id */
export function updateForecasterDriver(
  id: string,
  body: Partial<{ name: string; unitLabel: string }>,
): Promise<{ success: boolean; driver: ForecasterDriver }> {
  return apiFetch(`/forecaster/drivers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /forecaster/drivers/:id */
export async function deleteForecasterDriver(id: string): Promise<void> {
  await apiFetch(`/forecaster/drivers/${id}`, { method: 'DELETE' });
}

/** GET /forecaster/drivers/:id/values */
export function listForecasterDriverValues(
  driverId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; values: ForecasterDriverValue[]; count: number }> {
  return apiFetch(`/forecaster/drivers/${driverId}/values`, { signal: signal ?? null });
}

/** PUT /forecaster/drivers/:id/values */
export function setForecasterDriverValues(
  driverId: string,
  values: { month: string; value: number }[],
): Promise<{ success: boolean; values: ForecasterDriverValue[]; count: number }> {
  return apiFetch(`/forecaster/drivers/${driverId}/values`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

/** GET /forecaster/plans/:id/headcount */
export function listForecasterHeadcountRoles(
  planId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; roles: ForecasterHeadcountRole[]; count: number }> {
  return apiFetch(`/forecaster/plans/${planId}/headcount`, { signal: signal ?? null });
}

/** POST /forecaster/plans/:id/headcount */
export function createForecasterHeadcountRole(
  planId: string,
  body: {
    title: string;
    department: string | null;
    accountId: string;
    startsOn: string;
    endsOn: string | null;
    fteCount: number;
    annualSalaryCents: number;
    loadingBps: number;
  },
): Promise<{ success: boolean; role: ForecasterHeadcountRole }> {
  return apiFetch(`/forecaster/plans/${planId}/headcount`, { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /forecaster/headcount/:id */
export function updateForecasterHeadcountRole(
  id: string,
  body: Partial<{
    title: string;
    department: string | null;
    accountId: string;
    startsOn: string;
    endsOn: string | null;
    fteCount: number;
    annualSalaryCents: number;
    loadingBps: number;
  }>,
): Promise<{ success: boolean; role: ForecasterHeadcountRole }> {
  return apiFetch(`/forecaster/headcount/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /forecaster/headcount/:id */
export async function deleteForecasterHeadcountRole(id: string): Promise<void> {
  await apiFetch(`/forecaster/headcount/${id}`, { method: 'DELETE' });
}

/** GET /forecaster/plans/:id/forecast-lines */
export function listForecasterForecastLines(
  planId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; lines: ForecasterForecastLine[]; count: number }> {
  return apiFetch(`/forecaster/plans/${planId}/forecast-lines`, { signal: signal ?? null });
}

export type ForecasterCreateLineBody =
  | { kind: 'DRIVER_PRODUCT'; accountId: string; label: string; quantityDriverId: string; rateDriverId: string }
  | { kind: 'DRIVER_PERCENT'; accountId: string; label: string; sourceDriverId: string; percentBps: number }
  | { kind: 'FIXED_CENTS'; accountId: string; label: string; fixedCents: number };

/** POST /forecaster/plans/:id/forecast-lines */
export function createForecasterForecastLine(
  planId: string,
  body: ForecasterCreateLineBody,
): Promise<{ success: boolean; line: ForecasterForecastLine }> {
  return apiFetch(`/forecaster/plans/${planId}/forecast-lines`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** PATCH /forecaster/forecast-lines/:id */
export function updateForecasterForecastLine(
  id: string,
  body: ForecasterCreateLineBody,
): Promise<{ success: boolean; line: ForecasterForecastLine }> {
  return apiFetch(`/forecaster/forecast-lines/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /forecaster/forecast-lines/:id */
export async function deleteForecasterForecastLine(id: string): Promise<void> {
  await apiFetch(`/forecaster/forecast-lines/${id}`, { method: 'DELETE' });
}

/** GET /forecaster/plans/:id/forecast */
export function getForecasterForecast(
  planId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; forecast: ForecasterForecastResponse }> {
  return apiFetch(`/forecaster/plans/${planId}/forecast`, { signal: signal ?? null });
}

/** GET /forecaster/plans/:id/budget-versions */
export function listForecasterBudgetVersions(
  planId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; versions: ForecasterBudgetVersion[]; count: number }> {
  return apiFetch(`/forecaster/plans/${planId}/budget-versions`, { signal: signal ?? null });
}

/** POST /forecaster/plans/:id/budget-versions */
export function createForecasterBudgetVersion(
  planId: string,
  body: { label: string },
): Promise<{ success: boolean; version: ForecasterBudgetVersionDetail }> {
  return apiFetch(`/forecaster/plans/${planId}/budget-versions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** GET /forecaster/budget-versions/:id */
export function getForecasterBudgetVersion(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; version: ForecasterBudgetVersionDetail }> {
  return apiFetch(`/forecaster/budget-versions/${id}`, { signal: signal ?? null });
}

/** DELETE /forecaster/budget-versions/:id */
export async function deleteForecasterBudgetVersion(id: string): Promise<void> {
  await apiFetch(`/forecaster/budget-versions/${id}`, { method: 'DELETE' });
}

/** POST /forecaster/budget-versions/:id/compile */
export function compileForecasterBudgetVersion(
  id: string,
): Promise<{ success: boolean; version: ForecasterBudgetVersionDetail }> {
  return apiFetch(`/forecaster/budget-versions/${id}/compile`, { method: 'POST' });
}

/** POST /forecaster/budget-versions/:id/approve */
export function approveForecasterBudgetVersion(
  id: string,
): Promise<{ success: boolean; version: ForecasterBudgetVersionDetail }> {
  return apiFetch(`/forecaster/budget-versions/${id}/approve`, { method: 'POST' });
}

/** POST /forecaster/budget-versions/:id/lines */
export function addForecasterBudgetLine(
  versionId: string,
  body: { accountId: string; month: string; amountCents: number; justification: string },
): Promise<{ success: boolean; line: ForecasterBudgetLine }> {
  return apiFetch(`/forecaster/budget-versions/${versionId}/lines`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** PATCH /forecaster/budget-lines/:id */
export function updateForecasterBudgetLine(
  id: string,
  body: Partial<{ amountCents: number; justification: string }>,
): Promise<{ success: boolean; line: ForecasterBudgetLine }> {
  return apiFetch(`/forecaster/budget-lines/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /forecaster/budget-lines/:id */
export async function deleteForecasterBudgetLine(id: string): Promise<void> {
  await apiFetch(`/forecaster/budget-lines/${id}`, { method: 'DELETE' });
}

/** GET /forecaster/plans/:id/variance */
export function getForecasterVariance(
  planId: string,
  params: { from?: string; to?: string } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; variance: ForecasterVarianceResponse }> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set('from', params.from);
  if (params.to !== undefined) query.set('to', params.to);
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
  return apiFetch(`/forecaster/plans/${planId}/variance${suffix}`, { signal: signal ?? null });
}

// --- UnitEcon (Phase 14) ---

export interface UniteconCohortCell {
  offset: number;
  month: string;
  activeCustomers: number;
  netRevenueCents: number;
  retentionBps: number;
}

export interface UniteconCohortRow {
  cohortMonth: string;
  cohortSize: number;
  customerIds: string[];
  cells: UniteconCohortCell[];
}

export interface UniteconCohortMatrix {
  months: string[];
  rows: UniteconCohortRow[];
  totalNewCustomers: number;
  excludedPriorCustomers: number;
}

export interface UniteconCohortResponse {
  baseCurrency: string;
  from: string;
  to: string;
  matrix: UniteconCohortMatrix;
}

export interface UniteconSettings {
  grossMarginBps: number;
  acquisitionAccountIds: string[];
  updatedAt: string | null;
}

export interface UniteconUnitEconomicsRow {
  cohortMonth: string;
  newCustomers: number;
  acquisitionSpendCents: number;
  cacCents: number | null;
  cumulativeRevenueCents: number;
  cumulativeGrossMarginCents: number;
  ltvCents: number | null;
  ltvToCacBps: number | null;
  paybackMonths: number | null;
  observedMonths: number;
}

export interface UnitEconomicsReport {
  baseCurrency: string;
  from: string;
  to: string;
  grossMarginBps: number;
  acquisitionAccountIds: string[];
  rows: UniteconUnitEconomicsRow[];
  totalNewCustomers: number;
  totalAcquisitionSpendCents: number;
  blendedCacCents: number | null;
}

export interface UniteconProductLine {
  id: string;
  revenueAccountId: string;
  revenueAccountCode: string;
  revenueAccountName: string;
  name: string;
  unitLabel: string;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UniteconPvmRow {
  productLineId: string;
  productLineName: string;
  unitLabel: string;
  baseQuantityMilli: number;
  compareQuantityMilli: number;
  baseNetCents: number;
  compareNetCents: number;
  baseUnitPriceCents: number;
  compareUnitPriceCents: number;
  priceVarianceCents: number;
  volumeVarianceCents: number;
  mixVarianceCents: number;
  totalVarianceCents: number;
}

export interface UniteconPvmTotals {
  baseNetCents: number;
  compareNetCents: number;
  priceVarianceCents: number;
  volumeVarianceCents: number;
  mixVarianceCents: number;
  totalVarianceCents: number;
}

export interface PvmResponse {
  baseCurrency: string;
  basePeriod: { from: string; to: string };
  comparePeriod: { from: string; to: string };
  report: { rows: UniteconPvmRow[]; totals: UniteconPvmTotals };
  excludedForeignCurrencyInvoices: number;
}

/** GET /unitecon/cohorts */
export function fetchUniteconCohorts(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; cohorts: UniteconCohortResponse }> {
  const query = new URLSearchParams({ from, to });
  return apiFetch(`/unitecon/cohorts?${query.toString()}`, { signal: signal ?? null });
}

/** GET /unitecon/unit-economics */
export function fetchUniteconUnitEconomics(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; unitEconomics: UnitEconomicsReport }> {
  const query = new URLSearchParams({ from, to });
  return apiFetch(`/unitecon/unit-economics?${query.toString()}`, { signal: signal ?? null });
}

/** GET /unitecon/settings */
export function fetchUniteconSettings(
  signal?: AbortSignal,
): Promise<{ success: boolean; settings: UniteconSettings }> {
  return apiFetch('/unitecon/settings', { signal: signal ?? null });
}

/** PATCH /unitecon/settings */
export function updateUniteconSettings(
  input: { grossMarginBps?: number; acquisitionAccountIds?: string[] },
): Promise<{ success: boolean; settings: UniteconSettings }> {
  return apiFetch('/unitecon/settings', { method: 'PATCH', body: JSON.stringify(input) });
}

/** GET /unitecon/product-lines */
export function fetchUniteconProductLines(
  includeInactive?: boolean,
  signal?: AbortSignal,
): Promise<{ success: boolean; productLines: UniteconProductLine[]; count: number }> {
  const suffix = includeInactive === true ? '?includeInactive=true' : '';
  return apiFetch(`/unitecon/product-lines${suffix}`, { signal: signal ?? null });
}

/** POST /unitecon/product-lines */
export function createUniteconProductLine(input: {
  revenueAccountId: string;
  name: string;
  unitLabel: string;
}): Promise<{ success: boolean; productLine: UniteconProductLine }> {
  return apiFetch('/unitecon/product-lines', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /unitecon/product-lines/:id */
export function updateUniteconProductLine(
  id: string,
  input: Partial<{ name: string; unitLabel: string; isActive: boolean }>,
): Promise<{ success: boolean; productLine: UniteconProductLine }> {
  return apiFetch(`/unitecon/product-lines/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** DELETE /unitecon/product-lines/:id */
export async function deleteUniteconProductLine(id: string): Promise<void> {
  await apiFetch(`/unitecon/product-lines/${id}`, { method: 'DELETE' });
}

/** GET /unitecon/pvm */
export function fetchUniteconPvm(
  baseFrom: string,
  baseTo: string,
  compareFrom: string,
  compareTo: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; pvm: PvmResponse }> {
  const query = new URLSearchParams({ baseFrom, baseTo, compareFrom, compareTo });
  return apiFetch(`/unitecon/pvm?${query.toString()}`, { signal: signal ?? null });
}

/* ------------------------------------------------------------- BoardDeck */

export type BoardDeckCloseRunStatus = 'IN_PROGRESS' | 'READY' | 'BLOCKED' | 'CLOSED';
export type BoardDeckCheckKind =
  | 'TRIAL_BALANCE_BALANCED'
  | 'NO_DRAFT_INVOICES'
  | 'NO_UNPOSTED_BILLS'
  | 'NO_UNMATCHED_BANK_LINES'
  | 'PERIOD_OPEN';
export type BoardDeckCheckResult = 'PASS' | 'FAIL';

export interface BoardDeckCloseCheck {
  kind: BoardDeckCheckKind;
  result: BoardDeckCheckResult;
  detail: string;
  observedCount: number;
}

export interface BoardDeckCloseRun {
  id: string;
  fiscalPeriodId: string;
  status: BoardDeckCloseRunStatus;
  periodStartsOn: string;
  periodEndsOn: string;
  ranAt: string;
  ranByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  createdAt: string;
}

export interface BoardDeckCloseRunDetail extends BoardDeckCloseRun {
  checks: BoardDeckCloseCheck[];
}

/** GET /boarddeck/close-runs */
export function listBoardDeckCloseRuns(
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; closeRuns: BoardDeckCloseRun[] }> {
  return apiFetch('/boarddeck/close-runs', { signal: signal ?? null });
}

/** GET /boarddeck/close-runs/:id */
export function getBoardDeckCloseRun(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; closeRun: BoardDeckCloseRunDetail }> {
  return apiFetch(`/boarddeck/close-runs/${id}`, { signal: signal ?? null });
}

/** POST /boarddeck/close-runs */
export function createBoardDeckCloseRun(
  fiscalPeriodId: string,
): Promise<{ success: boolean; closeRun: BoardDeckCloseRunDetail }> {
  return apiFetch('/boarddeck/close-runs', { method: 'POST', body: JSON.stringify({ fiscalPeriodId }) });
}

/** POST /boarddeck/close-runs/:id/rerun */
export function rerunBoardDeckCloseRun(id: string): Promise<{ success: boolean; closeRun: BoardDeckCloseRunDetail }> {
  return apiFetch(`/boarddeck/close-runs/${id}/rerun`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /boarddeck/close-runs/:id/close-period */
export function closeBoardDeckPeriod(
  id: string,
): Promise<{ success: boolean; closeRun: BoardDeckCloseRunDetail }> {
  return apiFetch(`/boarddeck/close-runs/${id}/close-period`, { method: 'POST', body: JSON.stringify({}) });
}

export type BoardDeckSection = 'Revenue' | 'Cost of Sales' | 'Operating Expenses' | 'Other';

export interface BoardDeckSectionVariance {
  section: BoardDeckSection;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favourable: boolean;
}

export interface BoardDeckVarianceDriver {
  accountId: string;
  accountCode: string;
  accountName: string;
  section: BoardDeckSection;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favourable: boolean;
}

export interface BoardDeckSummarizedVariance {
  sections: BoardDeckSectionVariance[];
  drivers: BoardDeckVarianceDriver[];
  totalBudgetCents: number;
  totalActualCents: number;
  totalVarianceCents: number;
}

export interface BoardDeckBva {
  planId: string;
  planName: string;
  versionId: string;
  versionLabel: string;
  baseCurrency: string;
  from: string;
  to: string;
  summary: BoardDeckSummarizedVariance;
}

/** GET /boarddeck/bva?planId=&from=&to=&topN= */
export function fetchBoardDeckBva(
  planId: string,
  from?: string,
  to?: string,
  topN?: number,
  signal?: AbortSignal,
): Promise<{ success: boolean; bva: BoardDeckBva }> {
  const query = new URLSearchParams({ planId });
  if (from !== undefined) query.set('from', from);
  if (to !== undefined) query.set('to', to);
  if (topN !== undefined) query.set('topN', String(topN));
  return apiFetch(`/boarddeck/bva?${query.toString()}`, { signal: signal ?? null });
}

export type BoardDeckDeckStatus = 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';

export interface BoardDeckDeck {
  id: string;
  title: string;
  fiscalPeriodId: string;
  planId: string | null;
  periodStartsOn: string;
  periodEndsOn: string;
  status: BoardDeckDeckStatus;
  sha256: string | null;
  byteSizeBytes: number | null;
  slideCount: number | null;
  errorMessage: string | null;
  generatedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** GET /boarddeck/decks */
export function listBoardDeckDecks(
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; decks: BoardDeckDeck[] }> {
  return apiFetch('/boarddeck/decks', { signal: signal ?? null });
}

/** GET /boarddeck/decks/:id */
export function getBoardDeckDeck(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; deck: BoardDeckDeck }> {
  return apiFetch(`/boarddeck/decks/${id}`, { signal: signal ?? null });
}

/** POST /boarddeck/decks */
export function createBoardDeckDeck(input: {
  title: string;
  fiscalPeriodId: string;
  planId: string | null;
}): Promise<{ success: boolean; deck: BoardDeckDeck }> {
  return apiFetch('/boarddeck/decks', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /boarddeck/decks/:id/retry */
export function retryBoardDeckDeck(id: string): Promise<{ success: boolean; deck: BoardDeckDeck }> {
  return apiFetch(`/boarddeck/decks/${id}/retry`, { method: 'POST', body: JSON.stringify({}) });
}

/** DELETE /boarddeck/decks/:id */
export async function deleteBoardDeckDeck(id: string): Promise<void> {
  await apiFetch(`/boarddeck/decks/${id}`, { method: 'DELETE' });
}

/** GET /boarddeck/decks/:id/download — the .pptx, streamed as a Blob. */
export function downloadBoardDeckDeck(id: string): Promise<{ blob: Blob; filename: string }> {
  return apiDownloadBlob(`/boarddeck/decks/${id}/download`);
}

/* ------------------------------------------------------------- TaxGuard AI */

export type TaxGuardJurisdiction = 'IN' | 'US' | 'UK' | 'CA' | 'AU' | 'OTHER';

export type TaxGuardCorpusStatus = 'PENDING' | 'PARSING' | 'EMBEDDING' | 'READY' | 'FAILED';

export interface TaxGuardCorpusDocument {
  id: string;
  documentId: string;
  title: string;
  jurisdiction: TaxGuardJurisdiction;
  actYear: number | null;
  status: TaxGuardCorpusStatus;
  chunkCount: number;
  errorMessage: string | null;
  ingestedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface TaxGuardChunk {
  id: string;
  corpusDocumentId: string;
  ordinal: number;
  citation: string;
  heading: string | null;
  content: string;
  tokenEstimate: number;
}

export interface TaxGuardCitation {
  chunkId: string;
  citation: string;
  corpusDocumentTitle: string;
  score: number;
}

export interface TaxGuardQuestion {
  id: string;
  questionText: string;
  jurisdiction: TaxGuardJurisdiction;
  answerText: string;
  citations: TaxGuardCitation[];
  model: string;
  latencyMs: number;
  createdByName: string | null;
  createdAt: string;
}

/** GET /taxguard/corpus */
export function listCorpusDocuments(
  signal?: AbortSignal,
): Promise<{ success: boolean; corpusDocuments: TaxGuardCorpusDocument[] }> {
  return apiFetch('/taxguard/corpus', { signal: signal ?? null });
}

/** GET /taxguard/corpus/:id */
export function getCorpusDocument(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; corpusDocument: TaxGuardCorpusDocument }> {
  return apiFetch(`/taxguard/corpus/${id}`, { signal: signal ?? null });
}

/** GET /taxguard/corpus/:id/chunks */
export function getCorpusChunks(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; chunks: TaxGuardChunk[] }> {
  return apiFetch(`/taxguard/corpus/${id}/chunks`, { signal: signal ?? null });
}

/** POST /taxguard/corpus */
export function createCorpusDocument(input: {
  documentId: string;
  title: string;
  jurisdiction: TaxGuardJurisdiction;
  actYear: number | null;
}): Promise<{ success: boolean; corpusDocument: TaxGuardCorpusDocument }> {
  return apiFetch('/taxguard/corpus', { method: 'POST', body: JSON.stringify(input) });
}

/** DELETE /taxguard/corpus/:id */
export async function deleteCorpusDocument(id: string): Promise<void> {
  await apiFetch(`/taxguard/corpus/${id}`, { method: 'DELETE' });
}

/** GET /taxguard/questions */
export function listQuestions(
  signal?: AbortSignal,
): Promise<{ success: boolean; questions: TaxGuardQuestion[] }> {
  return apiFetch('/taxguard/questions', { signal: signal ?? null });
}

/** GET /taxguard/questions/:id */
export function getQuestion(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; question: TaxGuardQuestion }> {
  return apiFetch(`/taxguard/questions/${id}`, { signal: signal ?? null });
}

/** POST /taxguard/questions */
export function askQuestion(input: {
  questionText: string;
  jurisdiction: TaxGuardJurisdiction;
}): Promise<{ success: boolean; question: TaxGuardQuestion }> {
  return apiFetch('/taxguard/questions', { method: 'POST', body: JSON.stringify(input) });
}

/** DELETE /taxguard/questions/:id */
export async function deleteQuestion(id: string): Promise<void> {
  await apiFetch(`/taxguard/questions/${id}`, { method: 'DELETE' });
}

/* ------------------------------------------------- platform: sandbox (Phase 18) */

/** Mirrors server/src/types/sandbox.ts's SandboxCounts. */
export interface SandboxCounts {
  customers: number;
  vendors: number;
  invoices: number;
  bills: number;
  payments: number;
  bankLines: number;
  apFlowDocuments: number;
  forecastPlans: number;
  fpaModels: number;
  productLines: number;
  closeRuns: number;
  corpusDocuments: number;
}

/** Mirrors server/src/types/sandbox.ts's SandboxDataset. */
export interface SandboxDataset {
  orgId: string;
  datasetVersion: string;
  /** 'YYYY-MM-01' — the month every fixture's relative offset was resolved against. */
  anchorMonth: string;
  counts: SandboxCounts;
  loadedAt: string;
}

/** Mirrors server/src/types/sandbox.ts's SandboxStatus. */
export interface SandboxStatus {
  loaded: boolean;
  dataset: SandboxDataset | null;
}

/** GET /sandbox — platform-level; open to every member. */
export function getSandboxStatus(
  signal?: AbortSignal,
): Promise<{ success: boolean; sandbox: SandboxStatus }> {
  return apiFetch('/sandbox', { signal: signal ?? null });
}

/**
 * POST /sandbox/load — OWNER only. Seeds 24 months across all seven apps
 * through the real services, so this takes tens of seconds, not milliseconds.
 * A second call is refused with 409 by the database's own UNIQUE (org_id).
 */
export async function loadSandbox(): Promise<SandboxDataset> {
  const body = await apiFetch<{ success: boolean; dataset: SandboxDataset }>('/sandbox/load', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return body.dataset;
}

/**
 * DELETE /sandbox — OWNER only. Clears the load marker ONLY; the seeded
 * financial records stay, because posted documents are immutable by trigger
 * (guardrails rule 6). Removing them means deleting the organization.
 */
export async function unloadSandbox(): Promise<void> {
  await apiFetch('/sandbox', { method: 'DELETE' });
}
