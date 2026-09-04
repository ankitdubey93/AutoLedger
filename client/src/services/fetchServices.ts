import {
  fetchWithAutoRefresh,
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
}

/** Mirrors server/src/types/ledger-core.ts's Payment. */
export interface Payment {
  id: string;
  direction: PaymentDirection;
  status: PaymentStatus;
  paymentDate: string;
  currencyCode: string;
  amountCents: number;
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
