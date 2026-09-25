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

/* -------------------------------------------------------------- accounting */

/**
 * Mirrors server/src/types/accounting.ts, hand-written rather than imported.
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

/** GET /accounts — the flat chart, ordered by code. */
export function listAccounts(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  accounts: Account[];
}> {
  return apiFetch('/accounts', { signal: signal ?? null });
}

/** GET /accounts?tree=true — the same chart, nested by parentId. */
export function listAccountTree(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  accounts: AccountNode[];
}> {
  return apiFetch('/accounts?tree=true', { signal: signal ?? null });
}

/** Mirrors server/src/schemas/accounting/accountSchema.ts's createAccountSchema. */
export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  description: string | null;
}

/**
 * POST /accounts — OWNER, ADMIN or ACCOUNTANT.
 *
 * Documented failure paths (docs/api.md): 409 Account code already exists ·
 * 422 Parent account not found · 422 Parent account must have the same type.
 */
export function createAccount(
  input: CreateAccountInput,
): Promise<{ success: boolean; account: Account }> {
  return apiFetch('/accounts', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Mirrors server/src/schemas/accounting/accountSchema.ts's updateAccountSchema.
 * `code` and `type` are deliberately absent — the server's zod schema forbids
 * both, since re-typing a posted account would restate history. Retire an
 * account with `isActive: false` and create a replacement instead.
 */
export interface UpdateAccountInput {
  name?: string;
  description?: string | null;
  isActive?: boolean;
  parentId?: string | null;
}

/** PATCH /accounts/:id — OWNER, ADMIN or ACCOUNTANT. */
export function updateAccount(
  id: string,
  input: UpdateAccountInput,
): Promise<{ success: boolean; account: Account }> {
  return apiFetch(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** Mirrors server/src/types/accounting.ts's AccountLedgerRow. */
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

/** Mirrors server/src/types/accounting.ts's AccountLedger. */
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

/** GET /accounts/:id/ledger — running balances computed server-side. */
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

  return apiFetch(`/accounts/${accountId}/ledger${suffix}`, { signal: signal ?? null });
}

/** Mirrors server/src/types/accounting.ts's AccountBalance. */
export interface AccountBalance {
  accountId: string;
  ownBalanceCents: number;
  rollupBalanceCents: number;
}

/** GET /accounts/balances — own and subtree-rollup balance per account. */
export function getAccountBalances(
  asOf?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; asOf: string | null; count: number; balances: AccountBalance[] }> {
  const suffix = asOf === undefined || asOf === '' ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  return apiFetch(`/accounts/balances${suffix}`, { signal: signal ?? null });
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

/** GET /journals — paginated, filterable, lines nested. */
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

  return apiFetch(`/journals${suffix}`, { signal: signal ?? null });
}

/** GET /journals/:id — one entry with its lines and full detail. */
export function getJournal(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; entry: JournalEntry }> {
  return apiFetch(`/journals/${id}`, { signal: signal ?? null });
}

export interface JournalLineInput {
  accountId: string;
  debitCents: number;
  creditCents: number;
}

/** POST /journals — debits must equal credits, in integer cents. */
export function createJournal(body: {
  entryDate: string;
  description: string | null;
  lines: JournalLineInput[];
}): Promise<{ success: boolean; entry: JournalEntry }> {
  return apiFetch('/journals', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * POST /journals/:id/reverse — the only correction path.
 * There is no update and no delete, by design (guardrails rule 6).
 */
export function reverseJournal(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; entry: JournalEntry }> {
  return apiFetch(`/journals/${id}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/** GET /reports/trial-balance — aggregated from raw lines each call. */
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
  return apiFetch(`/reports/trial-balance${suffix}`, { signal: signal ?? null });
}

/* ------------------------------------------------- accounting: settings & dashboard */

/** Mirrors server/src/types/accounting.ts's FiscalYearWindow. */
export interface FiscalYearWindow {
  startDate: string;
  endDate: string;
  label: string;
}

/** Mirrors server/src/types/accounting.ts's LedgerSettings. */
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

/** Mirrors server/src/services/accounting/settingsService.ts's OnboardingInput. */
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

/**
 * The body PATCH /settings accepts: every onboarding field, plus the
 * three Phase 8 FX posting accounts the wizard never collects
 * (server/src/schemas/accounting/settingsSchema.ts).
 */
export type LedgerSettingsPatch = Partial<OnboardingInput> & {
  realizedFxGainAccountId?: string | null;
  realizedFxLossAccountId?: string | null;
  unrealizedFxAccountId?: string | null;
};

/** GET /settings — a missing settings row means "not yet onboarded", not a 404. */
export async function getLedgerSettings(signal?: AbortSignal): Promise<LedgerSettings> {
  const body = await apiFetch<{ success: boolean; settings: LedgerSettings }>('/settings', {
    signal: signal ?? null,
  });
  return body.settings;
}

/** POST /settings/onboarding — idempotent; re-submitting overwrites, never 409s. */
export async function completeLedgerOnboarding(input: OnboardingInput): Promise<LedgerSettings> {
  const body = await apiFetch<{ success: boolean; settings: LedgerSettings }>(
    '/settings/onboarding',
    { method: 'POST', body: JSON.stringify(input) },
  );
  return body.settings;
}

/** PATCH /settings — refused with 409 until onboarding has completed once. */
export async function updateLedgerSettings(input: LedgerSettingsPatch): Promise<LedgerSettings> {
  const body = await apiFetch<{ success: boolean; settings: LedgerSettings }>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.settings;
}

/** Mirrors server/src/types/accounting.ts's TrendPoint. */
export interface TrendPoint {
  month: string;
  revenueCents: number;
  expenseCents: number;
}

/** Mirrors server/src/types/accounting.ts's AgingBucket/AGING_BUCKET_LABELS. */
export type AgingBucket = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';

export interface AgingBucketAmount {
  bucket: AgingBucket;
  label: string;
  amountCents: number;
  documentCount: number;
}

/** Mirrors server/src/types/accounting.ts's DashboardSummary. */
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

/** GET /reports/dashboard — aggregated from raw lines each call, never cached. */
export async function getLedgerDashboard(
  asOf: string | null = null,
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & DashboardSummary>(
    `/reports/dashboard${suffix}`,
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

/* --------------------------------------------- organizations: postal identity */

/** Mirrors server/src/types/organization.ts's OrganizationProfile. */
export interface OrganizationProfile {
  legalName: string | null;
  industry: string | null;
  streetAddress1: string | null;
  streetAddress2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  postalSameAsStreet: boolean;
  postalAddress1: string | null;
  postalAddress2: string | null;
  postalCity: string | null;
  postalRegion: string | null;
  postalPostalCode: string | null;
  postalCountryCode: string | null;
  phone: string | null;
  contactEmail: string | null;
  website: string | null;
  logoDocumentId: string | null;
  configured: boolean;
}

/** GET /organizations/profile — defaults returned even before the org has ever saved one. */
export async function getOrganizationProfile(signal?: AbortSignal): Promise<OrganizationProfile> {
  const body = await apiFetch<{ success: boolean; profile: OrganizationProfile }>(
    '/organizations/profile',
    { signal: signal ?? null },
  );
  return body.profile;
}

/** PATCH /organizations/profile — OWNER/ADMIN only. */
export async function updateOrganizationProfile(
  input: Partial<Omit<OrganizationProfile, 'configured'>>,
): Promise<OrganizationProfile> {
  const body = await apiFetch<{ success: boolean; profile: OrganizationProfile }>(
    '/organizations/profile',
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return body.profile;
}

/* ------------------------------------------------------ accounting: invoicing */

/** Mirrors server/src/types/accounting.ts's Customer. */
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

/** GET /customers */
export function listCustomers(
  params: { q?: string; includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; customers: Customer[] }> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.includeInactive === true) query.set('includeInactive', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/customers${suffix}`, { signal: signal ?? null });
}

/** POST /customers */
export function createCustomer(body: {
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  notes: string | null;
}): Promise<{ success: boolean; customer: Customer }> {
  return apiFetch('/customers', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /customers/:id */
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
  return apiFetch(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Mirrors server/src/types/accounting.ts's PaymentTerm. */
export interface PaymentTerm {
  id: string;
  code: string;
  name: string;
  netDays: number;
  isSystem: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /payment-terms */
export function listPaymentTerms(
  params: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; paymentTerms: PaymentTerm[] }> {
  const query = new URLSearchParams();
  if (params.includeInactive === true) query.set('includeInactive', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/payment-terms${suffix}`, { signal: signal ?? null });
}

/** POST /payment-terms */
export function createPaymentTerm(body: {
  code: string;
  name: string;
  netDays: number;
}): Promise<{ success: boolean; paymentTerm: PaymentTerm }> {
  return apiFetch('/payment-terms', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /payment-terms/:id */
export function updatePaymentTerm(
  id: string,
  body: Partial<{ name: string; netDays: number; isActive: boolean }>,
): Promise<{ success: boolean; paymentTerm: PaymentTerm }> {
  return apiFetch(`/payment-terms/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Phase 34b. Mirrors server/src/types/accounting.ts's RecurringKind. */
export const RECURRING_KINDS = ['INVOICE', 'BILL', 'JOURNAL'] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];

/** Phase 34b. Mirrors server/src/types/accounting.ts's RecurringFrequency. */
export const RECURRING_FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

/** Phase 34b. Mirrors server/src/types/accounting.ts's RecurringMode. */
export const RECURRING_MODES = ['DRAFT', 'POST'] as const;
export type RecurringMode = (typeof RECURRING_MODES)[number];

/** Phase 34b. Mirrors server/src/types/accounting.ts's RecurringStatus. */
export const RECURRING_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED'] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];

/** Phase 34b. Mirrors server/src/types/accounting.ts's RecurringSchedule. */
export interface RecurringSchedule {
  id: string;
  kind: RecurringKind;
  name: string;
  sourceId: string;
  frequency: RecurringFrequency;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  nextRunDate: string | null;
  nextOccurrenceIndex: number;
  mode: RecurringMode;
  autoReverse: boolean;
  status: RecurringStatus;
  lastError: string | null;
  lastErrorAt: string | null;
  lastRunDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Phase 34b. Mirrors server/src/types/accounting.ts's RecurringRun. */
export interface RecurringRun {
  id: string;
  runDate: string;
  occurrenceNumber: number;
  invoiceId: string | null;
  billId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  createdAt: string;
}

/** Phase 34b. Mirrors server/src/types/accounting.ts's RecurringScheduleDetail. */
export interface RecurringScheduleDetail extends RecurringSchedule {
  runs: RecurringRun[];
}

/** Phase 34b. */
export type CreateRecurringScheduleInput = {
  kind: RecurringKind;
  sourceId: string;
  name: string;
  frequency: RecurringFrequency;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  mode: RecurringMode;
  autoReverse: boolean;
};

/** GET /recurring-schedules */
export function listRecurringSchedules(
  params: { kind?: RecurringKind | null; status?: RecurringStatus | null } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; schedules: RecurringSchedule[] }> {
  const query = new URLSearchParams();
  if (params.kind !== undefined && params.kind !== null) query.set('kind', params.kind);
  if (params.status !== undefined && params.status !== null) query.set('status', params.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/recurring-schedules${suffix}`, { signal: signal ?? null });
}

/** GET /recurring-schedules/:id */
export function getRecurringSchedule(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; schedule: RecurringScheduleDetail }> {
  return apiFetch(`/recurring-schedules/${id}`, { signal: signal ?? null });
}

/** POST /recurring-schedules */
export function createRecurringSchedule(
  body: CreateRecurringScheduleInput,
): Promise<{ success: boolean; schedule: RecurringSchedule }> {
  return apiFetch('/recurring-schedules', { method: 'POST', body: JSON.stringify(body) });
}

/** POST /recurring-schedules/:id/pause */
export function pauseRecurringSchedule(
  id: string,
): Promise<{ success: boolean; schedule: RecurringSchedule }> {
  return apiFetch(`/recurring-schedules/${id}/pause`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /recurring-schedules/:id/resume */
export function resumeRecurringSchedule(
  id: string,
): Promise<{ success: boolean; schedule: RecurringSchedule }> {
  return apiFetch(`/recurring-schedules/${id}/resume`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /recurring-schedules/:id/end */
export function endRecurringSchedule(
  id: string,
): Promise<{ success: boolean; schedule: RecurringSchedule }> {
  return apiFetch(`/recurring-schedules/${id}/end`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /recurring-schedules/:id/run */
export function runRecurringSchedule(
  id: string,
): Promise<{ success: boolean; generated: number; lastError: string | null; schedule: RecurringScheduleDetail }> {
  return apiFetch(`/recurring-schedules/${id}/run`, { method: 'POST', body: JSON.stringify({}) });
}

/** Mirrors server/src/types/accounting.ts's ItemKind. */
export type ItemKind = 'SERVICE' | 'GOODS';

/** Phase 32. Mirrors server/src/types/accounting.ts's ItemType. */
export const ITEM_TYPES = ['SERVICE', 'NON_INVENTORY', 'INVENTORY', 'FIXED_ASSET'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Mirrors server/src/types/accounting.ts's Item. */
export interface Item {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: ItemKind;
  itemType: ItemType;
  /** true for INVENTORY / FIXED_ASSET — name and status are managed in inventory. */
  stockManaged: boolean;
  salePriceCents: number | null;
  purchasePriceCents: number | null;
  revenueAccountId: string | null;
  expenseAccountId: string | null;
  assetAccountId: string | null;
  cogsAccountId: string | null;
  saleTaxRateBp: number;
  purchaseTaxRateBp: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /items */
export function listItems(
  params: { q?: string; kind?: ItemKind; itemType?: ItemType; includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; items: Item[] }> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.kind !== undefined) query.set('kind', params.kind);
  if (params.itemType !== undefined) query.set('itemType', params.itemType);
  if (params.includeInactive === true) query.set('includeInactive', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/items${suffix}`, { signal: signal ?? null });
}

/** POST /items */
export function createItem(body: {
  code: string;
  name: string;
  description: string | null;
  /** Phase 32: SERVICE or NON_INVENTORY — inventory/asset items are created in inventory. */
  itemType: 'SERVICE' | 'NON_INVENTORY';
  salePriceCents: number | null;
  purchasePriceCents: number | null;
  revenueAccountId: string | null;
  expenseAccountId: string | null;
  saleTaxRateBp: number;
  purchaseTaxRateBp: number;
}): Promise<{ success: boolean; item: Item }> {
  return apiFetch('/items', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /items/:id */
export function updateItem(
  id: string,
  body: Partial<{
    name: string;
    description: string | null;
    salePriceCents: number | null;
    purchasePriceCents: number | null;
    revenueAccountId: string | null;
    expenseAccountId: string | null;
    saleTaxRateBp: number;
    purchaseTaxRateBp: number;
    isActive: boolean;
  }>,
): Promise<{ success: boolean; item: Item }> {
  return apiFetch(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Mirrors server/src/types/accounting.ts's InvoiceLine. */
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
  /** Phase 24 — which item catalogue entry this line was picked from, if any. */
  itemId: string | null;
  /** Phase 32 — where an INVENTORY line moves stock; null = the default location. */
  stockLocationId?: string | null;
}

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'VOID';

/** Mirrors server/src/types/accounting.ts's SettlementStatus. Derived, never stored. */
export type SettlementStatus = 'NOT_APPLICABLE' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE';

/** Mirrors server/src/types/accounting.ts's Invoice. */
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
  paymentTermsCode: string | null;
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
  /** Phase 26 — applied ISSUED credit notes. amountDueCents = total − allocated − credited. */
  creditedCents: number;
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

/** GET /invoices — paginated, filterable, lines nested. */
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

  return apiFetch(`/invoices${suffix}`, { signal: signal ?? null });
}

/** GET /invoices/:id */
export function getInvoice(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/invoices/${id}`, { signal: signal ?? null });
}

export interface InvoiceLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  revenueAccountId: string;
  taxRateBp: number;
  /** Phase 24 — which item catalogue entry this line was picked from, if any. */
  itemId: string | null;
  /** Phase 32 — where an INVENTORY line moves stock; null = the default location. */
  stockLocationId?: string | null;
}

export interface InvoiceInput {
  customerId: string;
  issueDate: string;
  /** Omitted when paymentTermsCode is set — the server derives it. */
  dueDate?: string;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string;
  notes: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  lines: InvoiceLineInput[];
}

/** POST /invoices — always drafted, never posted directly. */
export function createInvoice(body: InvoiceInput): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch('/invoices', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /invoices/:id — a draft only. */
export function updateInvoice(
  id: string,
  body: InvoiceInput,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/invoices/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /invoices/:id — a draft only. */
export async function deleteInvoice(id: string): Promise<void> {
  await apiFetch(`/invoices/${id}`, { method: 'DELETE' });
}

/** POST /invoices/:id/issue — allocates a number and posts a balanced journal entry. */
export function issueInvoice(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/invoices/${id}/issue`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/**
 * POST /invoices/:id/void — the only correction path once issued.
 * Posts a reversing journal entry; a draft is voided with no GL posting.
 */
export function voidInvoice(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/invoices/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/** Must track server/src/config/constants.ts — kept in sync by the plan. */
export const INVOICE_TEMPLATE_IDS = ['classic', 'modern', 'compact'] as const;
export const INVOICE_FONT_FAMILIES = ['sans', 'serif'] as const;
export const INVOICE_DENSITIES = ['comfortable', 'compact'] as const;

export type InvoiceTemplateId = (typeof INVOICE_TEMPLATE_IDS)[number];
export type InvoiceFontFamily = (typeof INVOICE_FONT_FAMILIES)[number];
export type InvoiceDensity = (typeof INVOICE_DENSITIES)[number];

/** Mirrors server/src/types/accounting.ts's InvoiceSettings. */
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
  templateId: InvoiceTemplateId;
  documentTitle: string;
  fontFamily: InvoiceFontFamily;
  density: InvoiceDensity;
  showLogo: boolean;
  showOrgAddress: boolean;
  showPaymentTerms: boolean;
  showDueDate: boolean;
  bankDetails: string | null;
  configured: boolean;
}

/** GET /settings/invoicing — defaults returned even before the org has ever saved one. */
export async function getInvoiceSettings(signal?: AbortSignal): Promise<InvoiceSettings> {
  const body = await apiFetch<{ success: boolean; invoiceSettings: InvoiceSettings }>(
    '/settings/invoicing',
    { signal: signal ?? null },
  );
  return body.invoiceSettings;
}

/** PATCH /settings/invoicing — OWNER/ADMIN only. */
export async function updateInvoiceSettings(
  input: Partial<InvoiceSettings>,
): Promise<InvoiceSettings> {
  const body = await apiFetch<{ success: boolean; invoiceSettings: InvoiceSettings }>(
    '/settings/invoicing',
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return body.invoiceSettings;
}

/* ------------------------------------------------------ accounting: accounts payable */

/** Mirrors server/src/types/accounting.ts's Vendor. */
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

/** GET /vendors */
export function listVendors(
  params: { q?: string; includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; vendors: Vendor[] }> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.includeInactive === true) query.set('includeInactive', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/vendors${suffix}`, { signal: signal ?? null });
}

/** POST /vendors */
export function createVendor(body: {
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  paymentTerms: string | null;
  notes: string | null;
}): Promise<{ success: boolean; vendor: Vendor }> {
  return apiFetch('/vendors', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /vendors/:id */
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
  return apiFetch(`/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/* --------------------------------------- accounting: party accounts (Phase 25) */

/** Mirrors server/src/types/accounting.ts's PartyKind. */
export type PartyKind = 'CUSTOMER' | 'VENDOR';

/** Mirrors server/src/types/accounting.ts's PartyLedgerEntryKind. */
export type PartyLedgerEntryKind =
  | 'INVOICE'
  | 'INVOICE_VOID'
  | 'BILL'
  | 'BILL_VOID'
  | 'PAYMENT'
  | 'PAYMENT_VOID'
  | 'CREDIT_NOTE'
  | 'CREDIT_NOTE_VOID'
  | 'DEBIT_NOTE'
  | 'DEBIT_NOTE_VOID';

/** Mirrors server/src/types/accounting.ts's PartyLedgerAllocation. */
export interface PartyLedgerAllocation {
  documentId: string;
  documentNumber: string | null;
  baseAmountCents: number;
}

/** Mirrors server/src/types/accounting.ts's PartyLedgerRow. */
export interface PartyLedgerRow {
  journalEntryId: string;
  entryDate: string;
  kind: PartyLedgerEntryKind;
  documentId: string;
  documentNumber: string | null;
  debitCents: number;
  creditCents: number;
  runningBalanceCents: number;
  allocations: PartyLedgerAllocation[];
}

/** Mirrors server/src/types/accounting.ts's PartyLedger. */
export interface PartyLedger {
  party: { kind: PartyKind; id: string; name: string };
  controlAccount: { id: string; code: string; name: string } | null;
  from: string | null;
  to: string | null;
  openingBalanceCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  closingBalanceCents: number;
  totalCount: number;
  rows: PartyLedgerRow[];
}

/** Mirrors server/src/types/accounting.ts's PartyOpenItem. */
export interface PartyOpenItem {
  /** Phase 26 — an unapplied credit/debit note is an open item with a negative outstanding. */
  documentKind: 'INVOICE' | 'BILL' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  documentId: string;
  documentNumber: string | null;
  documentDate: string;
  dueDate: string;
  currencyCode: string;
  totalCents: number;
  baseTotalCents: number;
  baseOutstandingCents: number;
  daysOverdue: number;
  bucket: AgingBucket;
}

/** Mirrors server/src/types/accounting.ts's PartyOpenItems. */
export interface PartyOpenItems {
  party: { kind: PartyKind; id: string; name: string };
  asOf: string;
  outstandingCents: number;
  overdueCents: number;
  items: PartyOpenItem[];
}

type PartyLedgerResponse = {
  success: boolean;
  count: number;
  currentPage: number;
  totalPages: number;
} & PartyLedger;

function partyLedger(
  base: 'customers' | 'vendors',
  id: string,
  params: { from?: string; to?: string; page?: number; limit?: number },
  signal: AbortSignal | undefined,
): Promise<PartyLedgerResponse> {
  const query = new URLSearchParams();
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/${base}/${id}/ledger${suffix}`, { signal: signal ?? null });
}

function partyOpenItems(
  base: 'customers' | 'vendors',
  id: string,
  asOf: string | null,
  signal: AbortSignal | undefined,
): Promise<{ success: boolean } & PartyOpenItems> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  return apiFetch(`/${base}/${id}/open-items${suffix}`, { signal: signal ?? null });
}

/** GET /customers/:id/ledger — the customer's account under AR, running balance server-side. */
export function getCustomerLedger(
  id: string,
  params: { from?: string; to?: string; page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<PartyLedgerResponse> {
  return partyLedger('customers', id, params, signal);
}

/** GET /vendors/:id/ledger */
export function getVendorLedger(
  id: string,
  params: { from?: string; to?: string; page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<PartyLedgerResponse> {
  return partyLedger('vendors', id, params, signal);
}

/** GET /customers/:id/open-items */
export function getCustomerOpenItems(
  id: string,
  asOf: string | null = null,
  signal?: AbortSignal,
): Promise<{ success: boolean } & PartyOpenItems> {
  return partyOpenItems('customers', id, asOf, signal);
}

/** GET /vendors/:id/open-items */
export function getVendorOpenItems(
  id: string,
  asOf: string | null = null,
  signal?: AbortSignal,
): Promise<{ success: boolean } & PartyOpenItems> {
  return partyOpenItems('vendors', id, asOf, signal);
}

/** Mirrors server/src/types/accounting.ts's AgingReport. */
export interface AgingReport {
  asOf: string;
  kind: 'AR' | 'AP';
  buckets: AgingBucketAmount[];
  totalOutstandingCents: number;
  totalOverdueCents: number;
  controlAccount: { id: string; code: string; name: string; balanceCents: number } | null;
  reconciles: boolean | null;
  rows: {
    counterpartyId: string;
    counterpartyName: string;
    currentCents: number;
    d1to30Cents: number;
    d31to60Cents: number;
    d61to90Cents: number;
    d90PlusCents: number;
    totalCents: number;
  }[];
}

/** GET /reports/ar-aging | ap-aging — per-party outstanding balances. */
export function getAgingReport(
  kind: 'AR' | 'AP',
  signal?: AbortSignal,
): Promise<{ success: boolean } & AgingReport> {
  const path = kind === 'AR' ? 'ar-aging' : 'ap-aging';
  return apiFetch(`/reports/${path}`, { signal: signal ?? null });
}

/** Mirrors server/src/types/accounting.ts's BillLine. */
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
  /** Phase 24 — which item catalogue entry this line was picked from, if any. */
  itemId: string | null;
  /** Phase 32 — where an INVENTORY line moves stock; null = the default location. */
  stockLocationId?: string | null;
}

export type BillStatus = 'DRAFT' | 'AWAITING_APPROVAL' | 'POSTED' | 'VOID';

/** Mirrors server/src/types/accounting.ts's Bill. */
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
  paymentTermsCode: string | null;
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
  /** Phase 26 — applied ISSUED debit notes. amountDueCents = total − allocated − debited. */
  debitedCents: number;
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

/** GET /bills — paginated, filterable, lines nested. */
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

  return apiFetch(`/bills${suffix}`, { signal: signal ?? null });
}

/** GET /bills/:id */
export function getBill(id: string, signal?: AbortSignal): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/bills/${id}`, { signal: signal ?? null });
}

export interface BillLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  expenseAccountId: string;
  taxRateBp: number;
  /** Phase 24 — which item catalogue entry this line was picked from, if any. */
  itemId: string | null;
  /** Phase 32 — where an INVENTORY line moves stock; null = the default location. */
  stockLocationId?: string | null;
}

export interface BillInput {
  vendorId: string;
  vendorReference: string;
  billDate: string;
  /** Omitted when paymentTermsCode is set — the server derives it. */
  dueDate?: string;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string;
  notes: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  lines: BillLineInput[];
}

/** POST /bills — always drafted, never posted directly. */
export function createBill(body: BillInput): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch('/bills', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /bills/:id — draft or in-review only. */
export function updateBill(id: string, body: BillInput): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/bills/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /bills/:id — draft or in-review only. */
export async function deleteBill(id: string): Promise<void> {
  await apiFetch(`/bills/${id}`, { method: 'DELETE' });
}

/** POST /bills/:id/submit — sends a draft for approval. */
export function submitBill(id: string): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/bills/${id}/submit`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /bills/:id/approve — OWNER/ADMIN only; posts a balanced journal entry. */
export function approveBill(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/bills/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/**
 * POST /bills/:id/void — the only correction path once posted.
 * Posts a reversing journal entry; a draft/in-review bill is voided with no GL posting.
 */
export function voidBill(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/bills/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/* ---------------------------------------------------------- accounting: payments */

export type PaymentDirection = 'RECEIVE' | 'PAY';
export type PaymentStatus = 'POSTED' | 'VOID';

/** Mirrors server/src/types/accounting.ts's PaymentAllocation. */
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

/** Mirrors server/src/types/accounting.ts's Payment. */
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

/** GET /payments */
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

  return apiFetch(`/payments${suffix}`, { signal: signal ?? null });
}

/** GET /payments/:id */
export function getPayment(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; payment: Payment }> {
  return apiFetch(`/payments/${id}`, { signal: signal ?? null });
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

/** POST /payments — born posted; posts a balanced journal entry in the same transaction. */
export function createPayment(body: PaymentInput): Promise<{ success: boolean; payment: Payment }> {
  return apiFetch('/payments', { method: 'POST', body: JSON.stringify(body) });
}

/** POST /payments/:id/void — the only correction path; posts a reversing journal entry. */
export function voidPayment(
  id: string,
  entryDate: string | null = null,
): Promise<{ success: boolean; payment: Payment }> {
  return apiFetch(`/payments/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ entryDate }),
  });
}

/* ------------------------------------------------------- accounting: AR/AP aging */

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

/** Mirrors server/src/types/accounting.ts's AgingReport. */
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

/** GET /reports/ar-aging?asOf=YYYY-MM-DD */
export async function getArAging(asOf: string | null = null, signal?: AbortSignal): Promise<AgingReport> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & AgingReport>(
    `/reports/ar-aging${suffix}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

/** GET /reports/ap-aging?asOf=YYYY-MM-DD */
export async function getApAging(asOf: string | null = null, signal?: AbortSignal): Promise<AgingReport> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & AgingReport>(
    `/reports/ap-aging${suffix}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

/* ---------------------------------------------------- accounting: Phase 4 statements */

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

/** GET /reports/profit-and-loss?from=YYYY-MM-DD&to=YYYY-MM-DD */
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
    `/reports/profit-and-loss${suffix}`,
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

/** GET /reports/balance-sheet?asOf=YYYY-MM-DD */
export async function getBalanceSheet(
  asOf: string | null = null,
  signal?: AbortSignal,
): Promise<BalanceSheet> {
  const suffix = asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`;
  const body = await apiFetch<{ success: boolean } & BalanceSheet>(
    `/reports/balance-sheet${suffix}`,
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

/** GET /fiscal-periods?fiscalYear=&status= */
export function getFiscalPeriods(
  status?: FiscalPeriodStatus,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; periods: FiscalPeriod[] }> {
  const suffix = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
  return apiFetch(`/fiscal-periods${suffix}`, { signal: signal ?? null });
}

/** POST /fiscal-periods/generate */
export function generateFiscalPeriods(containingDate: string): Promise<{
  success: boolean;
  fiscalYearLabel: string;
  created: boolean;
  count: number;
  periods: FiscalPeriod[];
}> {
  return apiFetch('/fiscal-periods/generate', {
    method: 'POST',
    body: JSON.stringify({ containingDate }),
  });
}

/** POST /fiscal-periods/:id/close */
export function closeFiscalPeriod(id: string): Promise<{ success: boolean; period: FiscalPeriod }> {
  return apiFetch(`/fiscal-periods/${id}/close`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /fiscal-periods/:id/reopen */
export function reopenFiscalPeriod(id: string): Promise<{ success: boolean; period: FiscalPeriod }> {
  return apiFetch(`/fiscal-periods/${id}/reopen`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /fiscal-periods/:id/lock — OWNER only; irreversible. */
export function lockFiscalPeriod(id: string): Promise<{ success: boolean; period: FiscalPeriod }> {
  return apiFetch(`/fiscal-periods/${id}/lock`, { method: 'POST', body: JSON.stringify({}) });
}

/* --------------------------------------------------------- audit trail (Phase 5) */

export type AuditOperation = 'INSERT' | 'UPDATE' | 'DELETE';

/** One row of the trail, without its before/after images — the list view's shape. */
export interface AuditLogEntry {
  id: string;
  txid: string;
  module: string;
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
  module?: string;
  tableName?: string;
  operation?: AuditOperation;
}

/**
 * GET /audit-logs — platform-level, not part of the accounting module: the trail spans
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
  // An empty filter box must send no parameter at all, not `?module=`.
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.module !== undefined && params.module !== '') query.set('module', params.module);
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

/** Mirrors server/src/types/accounting.ts's BankStatementImport. */
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

/** Mirrors server/src/types/accounting.ts's BankMatchSuggestion. */
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

/** Mirrors server/src/types/accounting.ts's BankTransaction. */
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
  /** Set instead of matchedPaymentId when the line was settled by a posted journal entry. */
  matchedJournalEntryId: string | null;
  /** Phase 34a — set when a bank rule posted the journal entry. Always null when matchedJournalEntryId is null. */
  matchedRuleId: string | null;
  matchedRuleName: string | null;
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

/** POST /bank-imports — the CSV text goes in the JSON body, never a multipart upload. */
export function importBankStatement(body: ImportStatementInput): Promise<{
  success: boolean;
  import: BankStatementImport;
  importedCount: number;
  duplicateCount: number;
  suggestedCount: number;
  autoMatchableCount: number;
  ruleMatchedCount: number;
}> {
  return apiFetch('/bank-imports', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /bank-imports */
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

  return apiFetch(`/bank-imports${suffix}`, { signal: signal ?? null });
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

/** GET /bank-transactions */
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

  return apiFetch(`/bank-transactions${suffix}`, { signal: signal ?? null });
}

/** GET /bank-transactions/:id */
export function getBankTransaction(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/bank-transactions/${id}`, { signal: signal ?? null });
}

/** POST /bank-transactions/:id/rescore */
export function rescoreBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/bank-transactions/${id}/rescore`, { method: 'POST', body: JSON.stringify({}) });
}

export interface MatchBankTransactionInput {
  suggestionId: string | null;
  invoiceId: string | null;
  billId: string | null;
}

/** POST /bank-transactions/:id/match */
export function matchBankTransaction(
  id: string,
  body: MatchBankTransactionInput,
): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/bank-transactions/${id}/match`, { method: 'POST', body: JSON.stringify(body) });
}

export interface PostBankLineJournalInput {
  accountId: string;
  description: string | null;
}

/** POST /bank-transactions/:id/post-journal — posts a GL entry for a line with no counterpart document. */
export function postBankLineJournal(
  id: string,
  body: PostBankLineJournalInput,
): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/bank-transactions/${id}/post-journal`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** POST /bank-transactions/:id/unmatch — voids the payment the match created. */
export function unmatchBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/bank-transactions/${id}/unmatch`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /bank-transactions/:id/ignore */
export function ignoreBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/bank-transactions/${id}/ignore`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /bank-transactions/:id/unignore */
export function unignoreBankTransaction(id: string): Promise<{ success: boolean; transaction: BankTransaction }> {
  return apiFetch(`/bank-transactions/${id}/unignore`, { method: 'POST', body: JSON.stringify({}) });
}

/**
 * GET /reports/bank-reconciliation — `reconciles` is a
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
  return apiFetch(`/reports/bank-reconciliation?${query.toString()}`, { signal: signal ?? null });
}

/** Phase 34a — mirrors server/src/types/accounting.ts's BankRule. */
export interface BankRule {
  id: string;
  name: string;
  priority: number;
  direction: 'IN' | 'OUT' | 'ANY';
  memoContains: string;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  bankAccountId: string | null;
  targetAccountId: string;
  targetAccountCode: string;
  targetAccountName: string;
  description: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type BankRuleInput = Omit<BankRule, 'id' | 'createdBy' | 'createdAt' | 'updatedAt' | 'targetAccountCode' | 'targetAccountName' | 'isActive'> & {
  isActive?: boolean;
};

/** GET /bank-rules */
export function listBankRules(
  includeInactive: boolean = false,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; bankRules: BankRule[] }> {
  const query = new URLSearchParams();
  if (includeInactive) query.set('includeInactive', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/bank-rules${suffix}`, { signal: signal ?? null });
}

/** POST /bank-rules */
export function createBankRule(body: BankRuleInput): Promise<{ success: boolean; bankRule: BankRule }> {
  return apiFetch('/bank-rules', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /bank-rules/:id */
export function updateBankRule(
  id: string,
  body: Partial<BankRuleInput> & { isActive?: boolean },
): Promise<{ success: boolean; bankRule: BankRule }> {
  return apiFetch(`/bank-rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** POST /bank-rules/apply */
export function applyBankRules(): Promise<{ success: boolean; appliedCount: number }> {
  return apiFetch('/bank-rules/apply', { method: 'POST', body: JSON.stringify({}) });
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

/** GET /webhooks — platform-level, not part of the accounting module (guardrails rule 16). */
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

/* ------------------------------------------------------------- accounting: FX */

/** Mirrors server/src/types/accounting.ts's FxRate. */
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

/** Mirrors server/src/types/accounting.ts's ResolvedRate. */
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

/** GET /fx-rates */
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
  return apiFetch(`/fx-rates${suffix}`, { signal: signal ?? null });
}

/** GET /fx-rates/latest?from=<currency>&on=YYYY-MM-DD */
export function getLatestFxRate(
  fromCode: string,
  on?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; rate: ResolvedRate }> {
  const query = new URLSearchParams({ from: fromCode });
  if (on !== undefined) query.set('on', on);
  return apiFetch(`/fx-rates/latest?${query.toString()}`, { signal: signal ?? null });
}

/** POST /fx-rates — re-posting the same (fromCode, toCode, rateDate) overwrites. */
export function upsertFxRate(body: {
  fromCode: string;
  toCode: string;
  rateDate: string;
  rate: string;
}): Promise<{ success: boolean; rate: FxRate }> {
  return apiFetch('/fx-rates', { method: 'POST', body: JSON.stringify(body) });
}

/** DELETE /fx-rates/:id */
export function deleteFxRate(id: string): Promise<void> {
  return apiFetch(`/fx-rates/${id}`, { method: 'DELETE' });
}

/** Mirrors server/src/types/accounting.ts's FxExposureDocument. */
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

/** Mirrors server/src/types/accounting.ts's FxExposureReport. */
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

/** GET /reports/fx-exposure?asOf=YYYY-MM-DD — read-only preview, posts nothing. */
export function getFxExposure(
  asOf?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; exposure: FxExposureReport }> {
  const query = asOf !== undefined ? `?asOf=${asOf}` : '';
  return apiFetch(`/reports/fx-exposure${query}`, { signal: signal ?? null });
}

/** Mirrors server/src/types/accounting.ts's FxRevaluationLine. */
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

/** Mirrors server/src/types/accounting.ts's FxRevaluation. */
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

/** GET /fx-revaluations */
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
  return apiFetch(`/fx-revaluations${suffix}`, { signal: signal ?? null });
}

/** GET /fx-revaluations/:id */
export function getFxRevaluation(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; revaluation: FxRevaluation }> {
  return apiFetch(`/fx-revaluations/${id}`, { signal: signal ?? null });
}

/** POST /fx-revaluations — OWNER/ADMIN only; posts a GL entry plus an automatic next-day reversal. */
export function runFxRevaluation(asOfDate: string): Promise<{ success: boolean; revaluation: FxRevaluation }> {
  return apiFetch('/fx-revaluations', { method: 'POST', body: JSON.stringify({ asOfDate }) });
}

/* -------------------------------------------------------- platform: onboarding (Phase 9a) */

/** Mirrors server/src/types/onboarding.ts's OnboardingStatus. */
export type OnboardingStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SKIPPED' | 'COMPLETED';

/** Mirrors server/src/types/onboarding.ts's OnboardingState. */
export interface OnboardingState {
  module: string;
  status: OnboardingStatus;
  currentStep: string | null;
  draft: Record<string, unknown>;
  completedAt: string | null;
  skippedAt: string | null;
  updatedAt: string | null;
}

/** Mirrors server/src/types/onboarding.ts's OnboardingChecklistItem. */
export interface OnboardingChecklistItem extends OnboardingState {
  /** Human-readable name of the setup task, e.g. "Accounting setup". */
  label: string;
  /** Inventory is optional; accounting setup is not. */
  optional: boolean;
}

/** GET /onboarding — one item per setup task (accounting, inventory); a missing row reads as NOT_STARTED. */
export function getOnboardingChecklist(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  items: OnboardingChecklistItem[];
}> {
  return apiFetch('/onboarding', { signal: signal ?? null });
}

/** GET /onboarding/:module */
export async function getOnboardingState(module: string, signal?: AbortSignal): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${module}`,
    { signal: signal ?? null },
  );
  return body.onboarding;
}

/** PUT /onboarding/:module/draft — OWNER/ADMIN only. */
export async function saveOnboardingDraft(
  module: string,
  input: { currentStep: string | null; draft: Record<string, unknown> },
): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${module}/draft`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
  return body.onboarding;
}

/** POST /onboarding/:module/skip — OWNER/ADMIN only; the draft is preserved. */
export async function skipOnboarding(module: string): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${module}/skip`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return body.onboarding;
}

/** POST /onboarding/:module/resume — OWNER/ADMIN only; legal from SKIPPED or COMPLETED. */
export async function resumeOnboarding(module: string): Promise<OnboardingState> {
  const body = await apiFetch<{ success: boolean; onboarding: OnboardingState }>(
    `/onboarding/${module}/resume`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return body.onboarding;
}

/* ---------------------------------------------- accounting: migration imports (9b) */

export type MigrationImportKind = 'CHART_OF_ACCOUNTS' | 'OPENING_BALANCES' | 'CUSTOMERS' | 'VENDORS';
export type MigrationImportStatus = 'DRAFT' | 'VALIDATED' | 'COMMITTED';
export type MigrationRowStatus = 'VALID' | 'INVALID' | 'EXCLUDED';

/** Mirrors server/src/types/accounting.ts's MigrationImport. */
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

/** Mirrors server/src/types/accounting.ts's MigrationImportRow. */
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
  /** CUSTOMERS and VENDORS only. */
  partyName: string | null;
  partyEmail: string | null;
  partyPhone: string | null;
  partyAddress: string | null;
  partyTaxNumber: string | null;
  partyPaymentTerms: string | null;
  partyNotes: string | null;
  errors: string[];
  status: MigrationRowStatus;
}

/** Mirrors server/src/types/accounting.ts's MigrationCommitPreview. */
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
  /** CUSTOMERS and VENDORS only. */
  partiesToCreate: number;
  partiesToMerge: number;
}

export type MigrationCommitResult =
  | { kind: 'CHART_OF_ACCOUNTS'; createdCount: number; mergedCount: number }
  | { kind: 'OPENING_BALANCES'; journalEntryId: string; plugCents: number }
  | { kind: 'CUSTOMERS' | 'VENDORS'; createdCount: number; mergedCount: number };

/** POST /migration-imports — OWNER, ADMIN or ACCOUNTANT. */
export function createMigrationImport(body: {
  kind: MigrationImportKind;
  fileName: string;
  content: string;
}): Promise<{ success: boolean; import: MigrationImport; rows: MigrationImportRow[] }> {
  return apiFetch('/migration-imports', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /migration-imports */
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
  return apiFetch(`/migration-imports${suffix}`, { signal: signal ?? null });
}

/** GET /migration-imports/:id */
export function getMigrationImport(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; import: MigrationImport }> {
  return apiFetch(`/migration-imports/${id}`, { signal: signal ?? null });
}

/** GET /migration-imports/:id/rows */
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
  return apiFetch(`/migration-imports/${id}/rows${suffix}`, { signal: signal ?? null });
}

/** PATCH /migration-imports/:id/rows/:rowId — OWNER, ADMIN or ACCOUNTANT. */
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
    partyName: string;
    partyEmail: string | null;
    partyPhone: string | null;
    partyAddress: string | null;
    partyTaxNumber: string | null;
    partyPaymentTerms: string | null;
    partyNotes: string | null;
    status: 'VALID' | 'EXCLUDED';
  }>,
): Promise<{ success: boolean; import: MigrationImport; row: MigrationImportRow }> {
  return apiFetch(`/migration-imports/${id}/rows/${rowId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** POST /migration-imports/:id/validate — OWNER, ADMIN or ACCOUNTANT. */
export function validateMigrationImport(id: string): Promise<{ success: boolean; import: MigrationImport }> {
  return apiFetch(`/migration-imports/${id}/validate`, { method: 'POST', body: JSON.stringify({}) });
}

/** GET /migration-imports/:id/preview — OWNER, ADMIN or ACCOUNTANT. */
export function previewMigrationImport(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; preview: MigrationCommitPreview }> {
  return apiFetch(`/migration-imports/${id}/preview`, { signal: signal ?? null });
}

/** POST /migration-imports/:id/commit — OWNER/ADMIN only; irreversible. */
export function commitMigrationImport(
  id: string,
): Promise<{ success: boolean; import: MigrationImport; result: MigrationCommitResult }> {
  return apiFetch(`/migration-imports/${id}/commit`, { method: 'POST', body: JSON.stringify({}) });
}

/** DELETE /migration-imports/:id — refused once COMMITTED. */
export async function deleteMigrationImport(id: string): Promise<void> {
  await apiFetch(`/migration-imports/${id}`, { method: 'DELETE' });
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
  module: string;
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
  module?: string;
  entityType?: string;
  entityId?: string;
}

/** GET /documents — platform-level, not part of the accounting module (guardrails rule 16). */
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
  if (params.module !== undefined && params.module !== '') query.set('module', params.module);
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
  body: { module: string; entityType: string; entityId: string },
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

// ---------------------------------------------------------- capture (Phase 10)

/** Mirrors server/src/types/capture.ts's CaptureDocumentStatus. */
export type CaptureDocumentStatus = 'PENDING' | 'PROCESSING' | 'EXTRACTED' | 'FAILED' | 'POSTED' | 'DUPLICATE';

export interface CaptureLineItem {
  description: string;
  amountCents: number;
}

export interface CaptureExtraction {
  id: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** Phase 19. 'YYYY-MM-DD'. */
  dueDate: string | null;
  currency: string | null;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  lineItems: CaptureLineItem[];
  fieldConfidence: Record<string, number>;
  arithmeticOk: boolean;
  validationErrors: string[];
  model: string;
  createdAt: string;
}

export interface CapturePage {
  id: string;
  pageNumber: number;
  widthPx: number;
  heightPx: number;
  redactedSha256: string;
  redactedRegions: { kind: string; box: { x0: number; y0: number; x1: number; y1: number } }[];
}

export interface CaptureDocument {
  id: string;
  documentId: string;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  status: CaptureDocumentStatus;
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
  /** Phase 19. The bill this document posted as. */
  billId: string | null;
  autoPosted: boolean;
  autoPostBlockers: CaptureAutoPostBlocker[];
  /** Non-null only when status is DUPLICATE — the earlier document this capture's bytes match. */
  duplicateOfId: string | null;
  /** The matched document's own original filename. Null unless duplicateOfId is set. */
  duplicateOfFilename: string | null;
}

/** Mirrors server/src/types/capture.ts's CaptureAutoPostBlockerCode. */
export interface CaptureAutoPostBlocker {
  code: string;
  message: string;
}

export interface CaptureSettings {
  autoPostEnabled: boolean;
  autoPostMinConfidence: number;
  autoPostMaxTotalCents: number | null;
  updatedAt: string | null;
}

/** Mirrors server/src/types/capture.ts's CaptureMappingSource. */
export type CaptureMappingSource = 'HISTORY' | 'CHART' | 'MODEL' | 'MANUAL' | 'NONE';

export interface CaptureLineItemRecord {
  id: string;
  lineIndex: number;
  description: string;
  amountCents: number;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  suggestedAccountId: string | null;
  mappingSource: CaptureMappingSource;
  mappingConfidence: number | null;
}

export interface CaptureReviewQueueEntry {
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
  autoPostBlockers: CaptureAutoPostBlocker[];
}

export interface CaptureDocumentDetail extends CaptureDocument {
  pages: CapturePage[];
  extraction: CaptureExtraction | null;
  lineItems: CaptureLineItemRecord[];
  /** Phase 19.1. Every metered model call this document caused, newest first. */
  modelCalls: AiModelCall[];
}

export interface CaptureDocumentFilters {
  status?: CaptureDocumentStatus;
  page?: number;
  limit?: number;
}

/** POST /capture/documents — registers an already-vaulted document. */
export function createCaptureDocument(documentId: string): Promise<{ success: boolean; document: CaptureDocument }> {
  return apiFetch('/capture/documents', { method: 'POST', body: JSON.stringify({ documentId }) });
}

/** POST /capture/documents/upload — multipart, field "file". Vaults and registers in one call. */
export function uploadCaptureDocument(
  file: File,
): Promise<{ success: boolean; document: CaptureDocument; created: boolean }> {
  return apiUpload('/capture/documents/upload', () => {
    const body = new FormData();
    body.append('file', file);
    return body;
  });
}

/** GET /capture/documents */
export function listCaptureDocuments(
  params: CaptureDocumentFilters = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  documents: CaptureDocument[];
}> {
  const query = new URLSearchParams();
  if (params.status !== undefined) query.set('status', params.status);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/capture/documents${suffix}`, { signal: signal ?? null });
}

/** GET /capture/documents/:id */
export function getCaptureDocument(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; document: CaptureDocumentDetail }> {
  return apiFetch(`/capture/documents/${id}`, { signal: signal ?? null });
}

/** GET /capture/documents/:id/pages/:pageNumber/image — the redacted preview, as a Blob. */
export function getCapturePageImage(id: string, pageNumber: number): Promise<{ blob: Blob; filename: string }> {
  return apiDownloadBlob(`/capture/documents/${id}/pages/${String(pageNumber)}/image`);
}

/** POST /capture/documents/:id/reextract */
export function reextractCaptureDocument(id: string): Promise<{ success: boolean; document: CaptureDocument }> {
  return apiFetch(`/capture/documents/${id}/reextract`, { method: 'POST' });
}

// ---------------------------------------------------------- capture (Phase 11)

/** GET /capture/review-queue — documents awaiting human review, lowest confidence first. */
export function listCaptureReviewQueue(
  params: { page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  entries: CaptureReviewQueueEntry[];
}> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/capture/review-queue${suffix}`, { signal: signal ?? null });
}

/** PATCH /capture/documents/:id/line-items/:lineId — a reviewer's account override. */
export function updateCaptureLineItem(
  documentId: string,
  lineItemId: string,
  accountId: string,
): Promise<{ success: boolean; document: CaptureDocumentDetail }> {
  return apiFetch(`/capture/documents/${documentId}/line-items/${lineItemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ accountId }),
  });
}

/** POST /capture/documents/:id/post — one-click approve & post into the books. No request body. */
export function postCaptureDocument(id: string): Promise<{ success: boolean; document: CaptureDocumentDetail }> {
  return apiFetch(`/capture/documents/${id}/post`, { method: 'POST' });
}

// ---------------------------------------------------------- capture (Phase 19)

/** GET /capture/settings */
export function getCaptureSettings(): Promise<{ success: boolean; settings: CaptureSettings }> {
  return apiFetch('/capture/settings');
}

/** PUT /capture/settings */
export function updateCaptureSettings(body: {
  autoPostEnabled: boolean;
  autoPostMinConfidence: number;
  autoPostMaxTotalCents: number | null;
}): Promise<{ success: boolean; settings: CaptureSettings }> {
  return apiFetch('/capture/settings', { method: 'PUT', body: JSON.stringify(body) });
}

// -------------------------------------------------- integrations drive (19.3)

/** Mirrors server/src/types/integrations.ts's DriveAuthMode/DriveConnectionStatus. */
export type DriveAuthMode = 'OAUTH' | 'SERVICE_ACCOUNT';
export type DriveConnectionStatus = 'PENDING_AUTH' | 'CONNECTED' | 'NEEDS_REAUTH';
export type DriveFolderPurpose = 'VENDOR_BILL' | 'BANK_STATEMENT';

export interface DriveConnection {
  id: string;
  status: DriveConnectionStatus;
  authMode: DriveAuthMode;
  googleAccountEmail: string | null;
  connectedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DriveColumnMap {
  date: string;
  description: string;
  amount: string | null;
  debit: string | null;
  credit: string | null;
  reference: string | null;
}

export interface DriveFolder {
  id: string;
  purpose: DriveFolderPurpose;
  folderId: string;
  folderName: string;
  isActive: boolean;
  ledgerAccountId: string | null;
  ledgerAccountCode: string | null;
  dateFormat: 'ISO' | 'DMY' | 'MDY' | null;
  columnMap: DriveColumnMap | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  importedFileCount: number;
  skippedFileCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DriveModes {
  oauth: boolean;
  serviceAccount: boolean;
  serviceAccountEmail: string | null;
}

/** GET /integrations/drive */
export function getDriveIntegration(): Promise<{
  success: boolean;
  connection: DriveConnection | null;
  folders: DriveFolder[];
  modes: DriveModes;
}> {
  return apiFetch('/integrations/drive');
}

/** POST /integrations/drive/connect */
export function startDriveConnect(): Promise<{ success: boolean; authorizationUrl: string }> {
  return apiFetch('/integrations/drive/connect', { method: 'POST' });
}

/** POST /integrations/drive/connect/service-account */
export function connectDriveServiceAccount(): Promise<{ success: boolean; connection: DriveConnection }> {
  return apiFetch('/integrations/drive/connect/service-account', { method: 'POST' });
}

/** DELETE /integrations/drive */
export async function disconnectDrive(): Promise<void> {
  await apiFetch('/integrations/drive', { method: 'DELETE' });
}

/** GET /integrations/drive/folders */
export function listDriveFolders(): Promise<{ success: boolean; folders: DriveFolder[] }> {
  return apiFetch('/integrations/drive/folders');
}

export interface CreateDriveFolderInput {
  purpose: DriveFolderPurpose;
  folder: string;
  ledgerAccountId: string | null;
  dateFormat: 'ISO' | 'DMY' | 'MDY' | null;
  columnMap: DriveColumnMap | null;
}

/** POST /integrations/drive/folders */
export function createDriveFolder(body: CreateDriveFolderInput): Promise<{ success: boolean; folder: DriveFolder }> {
  return apiFetch('/integrations/drive/folders', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /integrations/drive/folders/:id */
export function updateDriveFolder(
  id: string,
  body: Partial<CreateDriveFolderInput> & { isActive?: boolean },
): Promise<{ success: boolean; folder: DriveFolder }> {
  return apiFetch(`/integrations/drive/folders/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /integrations/drive/folders/:id */
export async function deleteDriveFolder(id: string): Promise<void> {
  await apiFetch(`/integrations/drive/folders/${id}`, { method: 'DELETE' });
}

/** POST /integrations/drive/folders/:id/sync */
export function syncDriveFolder(id: string): Promise<{ success: boolean; queued: boolean }> {
  return apiFetch(`/integrations/drive/folders/${id}/sync`, { method: 'POST' });
}

// ---------------------------------------------------------- ai-usage (19.1)

/** Mirrors server/src/types/aiUsage.ts. */
export type AiCallPurpose = 'EXTRACT' | 'CLASSIFY' | 'ANSWER' | 'EMBED';
export type AiCallStatus = 'OK' | 'ERROR';

export interface AiModelCall {
  id: string;
  module: string;
  purpose: AiCallPurpose;
  provider: string;
  model: string;
  entityType: string | null;
  entityId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costMicroUsd: number | null;
  pricingVersion: string | null;
  status: AiCallStatus;
  errorCode: string | null;
  latencyMs: number;
  createdAt: string;
}

export interface AiUsageTotals {
  callCount: number;
  okCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  unpricedCallCount: number;
}

export interface AiUsageGroup extends AiUsageTotals {
  key: string;
  provider: string | null;
}

export interface AiUsageDay extends AiUsageTotals {
  date: string;
}

export interface AiUsageSummary {
  totals: AiUsageTotals;
  byModel: AiUsageGroup[];
  byModule: AiUsageGroup[];
  byPurpose: AiUsageGroup[];
  byDay: AiUsageDay[];
  pricingVersion: string;
}

/** GET /ai-usage */
export function getAiUsage(
  params: { from?: string; to?: string; module?: string } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; usage: AiUsageSummary }> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set('from', params.from);
  if (params.to !== undefined) query.set('to', params.to);
  if (params.module !== undefined) query.set('module', params.module);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/ai-usage${suffix}`, { signal: signal ?? null });
}

/* ------------------------------------------- Phase 26 — credit & debit notes */

export type NoteStatus = 'DRAFT' | 'ISSUED' | 'VOID';
export type NoteReasonCode = 'RETURN' | 'PRICE_ADJUSTMENT' | 'DISCOUNT' | 'DAMAGED' | 'OTHER';
export const NOTE_REASON_CODES: readonly NoteReasonCode[] = ['RETURN', 'PRICE_ADJUSTMENT', 'DISCOUNT', 'DAMAGED', 'OTHER'];

/** Mirrors server/src/types/accounting.ts's CreditNoteLine. */
export interface CreditNoteLine {
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

/** Mirrors server/src/types/accounting.ts's CreditNoteAllocation. */
export interface CreditNoteAllocation {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amountCents: number;
  baseAmountCents: number;
  allocationDate: string;
  createdAt: string;
}

/** Mirrors server/src/types/accounting.ts's CreditNote. */
export interface CreditNote {
  id: string;
  creditNoteNumber: string | null;
  status: NoteStatus;
  customerId: string;
  customerName: string;
  invoiceId: string;
  invoiceNumber: string | null;
  issueDate: string;
  currencyCode: string;
  fxRate: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  customerNameSnapshot: string;
  customerAddressSnapshot: string | null;
  customerTaxNumberSnapshot: string | null;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
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
  lines: CreditNoteLine[];
  allocations: CreditNoteAllocation[];
  appliedCents: number;
  unappliedCents: number;
}

/** Mirrors server/src/types/accounting.ts's DebitNoteLine. */
export interface DebitNoteLine {
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

/** Mirrors server/src/types/accounting.ts's DebitNoteAllocation. */
export interface DebitNoteAllocation {
  id: string;
  billId: string;
  billVendorReference: string;
  amountCents: number;
  baseAmountCents: number;
  allocationDate: string;
  createdAt: string;
}

/** Mirrors server/src/types/accounting.ts's DebitNote. */
export interface DebitNote {
  id: string;
  debitNoteNumber: string | null;
  status: NoteStatus;
  vendorId: string;
  vendorName: string;
  billId: string;
  billVendorReference: string;
  vendorCreditReference: string | null;
  issueDate: string;
  currencyCode: string;
  fxRate: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  vendorNameSnapshot: string;
  vendorAddressSnapshot: string | null;
  vendorTaxNumberSnapshot: string | null;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
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
  lines: DebitNoteLine[];
  allocations: DebitNoteAllocation[];
  appliedCents: number;
  unappliedCents: number;
}

export interface NoteListFilters {
  page?: number;
  limit?: number;
  status?: NoteStatus | '';
  /** Credit notes: customerId; debit notes: vendorId. */
  partyId?: string;
  /** Credit notes: invoiceId; debit notes: billId. */
  originalId?: string;
}

interface NoteListResponse {
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
}

function noteQuery(params: NoteListFilters, partyKey: string, originalKey: string): string {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.partyId !== undefined && params.partyId !== '') query.set(partyKey, params.partyId);
  if (params.originalId !== undefined && params.originalId !== '') query.set(originalKey, params.originalId);
  return query.size > 0 ? `?${query.toString()}` : '';
}

export interface CreditNoteInput {
  invoiceId: string;
  issueDate: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  notes: string | null;
  lines: { description: string; quantityMilli: number; unitPriceCents: number; revenueAccountId: string; taxRateBp: number }[];
}

export interface DebitNoteInput {
  billId: string;
  issueDate: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  vendorCreditReference: string | null;
  notes: string | null;
  lines: { description: string; quantityMilli: number; unitPriceCents: number; expenseAccountId: string; taxRateBp: number }[];
}

/** GET /credit-notes */
export function listCreditNotes(
  params: NoteListFilters = {},
  signal?: AbortSignal,
): Promise<NoteListResponse & { creditNotes: CreditNote[] }> {
  return apiFetch(`/credit-notes${noteQuery(params, 'customerId', 'invoiceId')}`, { signal: signal ?? null });
}

/** GET /credit-notes/:id */
export function getCreditNote(id: string, signal?: AbortSignal): Promise<{ success: boolean; creditNote: CreditNote }> {
  return apiFetch(`/credit-notes/${id}`, { signal: signal ?? null });
}

/** POST /credit-notes — always a DRAFT against an issued invoice. */
export function createCreditNote(body: CreditNoteInput): Promise<{ success: boolean; creditNote: CreditNote }> {
  return apiFetch('/credit-notes', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /credit-notes/:id — a draft only. */
export function updateCreditNote(id: string, body: CreditNoteInput): Promise<{ success: boolean; creditNote: CreditNote }> {
  return apiFetch(`/credit-notes/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /credit-notes/:id — a draft only. */
export async function deleteCreditNote(id: string): Promise<void> {
  await apiFetch(`/credit-notes/${id}`, { method: 'DELETE' });
}

/** POST /credit-notes/:id/issue — numbers it, posts DR revenue/tax · CR AR, auto-applies to its invoice. */
export function issueCreditNote(id: string, entryDate: string | null = null): Promise<{ success: boolean; creditNote: CreditNote }> {
  return apiFetch(`/credit-notes/${id}/issue`, { method: 'POST', body: JSON.stringify({ entryDate }) });
}

/** POST /credit-notes/:id/void — posts a reversal; its allocations stop counting. */
export function voidCreditNote(id: string, entryDate: string | null = null): Promise<{ success: boolean; creditNote: CreditNote }> {
  return apiFetch(`/credit-notes/${id}/void`, { method: 'POST', body: JSON.stringify({ entryDate }) });
}

/** POST /credit-notes/:id/allocations — apply unapplied credit to an open invoice (no journal entry). */
export function applyCreditNote(
  id: string,
  body: { invoiceId: string; amountCents: number; allocationDate: string },
): Promise<{ success: boolean; creditNote: CreditNote }> {
  return apiFetch(`/credit-notes/${id}/allocations`, { method: 'POST', body: JSON.stringify(body) });
}

/** GET /debit-notes */
export function listDebitNotes(
  params: NoteListFilters = {},
  signal?: AbortSignal,
): Promise<NoteListResponse & { debitNotes: DebitNote[] }> {
  return apiFetch(`/debit-notes${noteQuery(params, 'vendorId', 'billId')}`, { signal: signal ?? null });
}

/** GET /debit-notes/:id */
export function getDebitNote(id: string, signal?: AbortSignal): Promise<{ success: boolean; debitNote: DebitNote }> {
  return apiFetch(`/debit-notes/${id}`, { signal: signal ?? null });
}

/** POST /debit-notes — always a DRAFT against an approved bill. */
export function createDebitNote(body: DebitNoteInput): Promise<{ success: boolean; debitNote: DebitNote }> {
  return apiFetch('/debit-notes', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /debit-notes/:id — a draft only. */
export function updateDebitNote(id: string, body: DebitNoteInput): Promise<{ success: boolean; debitNote: DebitNote }> {
  return apiFetch(`/debit-notes/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /debit-notes/:id — a draft only. */
export async function deleteDebitNote(id: string): Promise<void> {
  await apiFetch(`/debit-notes/${id}`, { method: 'DELETE' });
}

/** POST /debit-notes/:id/issue — numbers it, posts DR AP · CR expense/tax, auto-applies to its bill. */
export function issueDebitNote(id: string, entryDate: string | null = null): Promise<{ success: boolean; debitNote: DebitNote }> {
  return apiFetch(`/debit-notes/${id}/issue`, { method: 'POST', body: JSON.stringify({ entryDate }) });
}

/** POST /debit-notes/:id/void — posts a reversal; its allocations stop counting. */
export function voidDebitNote(id: string, entryDate: string | null = null): Promise<{ success: boolean; debitNote: DebitNote }> {
  return apiFetch(`/debit-notes/${id}/void`, { method: 'POST', body: JSON.stringify({ entryDate }) });
}

/** POST /debit-notes/:id/allocations — apply unapplied credit to an open bill (no journal entry). */
export function applyDebitNote(
  id: string,
  body: { billId: string; amountCents: number; allocationDate: string },
): Promise<{ success: boolean; debitNote: DebitNote }> {
  return apiFetch(`/debit-notes/${id}/allocations`, { method: 'POST', body: JSON.stringify(body) });
}

// --- inventory (Phase 28) ---

export const STOCK_INDUSTRY_KEYS = [
  'GENERAL',
  'RETAIL',
  'WHOLESALE_DISTRIBUTION',
  'MANUFACTURING',
  'FOOD_BEVERAGE',
  'PHARMA_HEALTHCARE',
  'APPAREL_FOOTWEAR',
  'ELECTRONICS',
  'AUTOMOTIVE',
  'REAL_ESTATE',
] as const;
export type StockIndustryKey = (typeof STOCK_INDUSTRY_KEYS)[number];

export const STOCK_ITEM_TYPES = [
  'RAW_MATERIAL',
  'COMPONENT',
  'WORK_IN_PROGRESS',
  'FINISHED_GOOD',
  'TRADING_GOOD',
  'CONSUMABLE',
  'PACKAGING',
  'SPARE_PART',
  'PROPERTY_UNIT',
] as const;
export type StockItemType = (typeof STOCK_ITEM_TYPES)[number];

export const STOCK_TRACKING_MODES = ['QUANTITY', 'LOT', 'SERIAL'] as const;
export type StockTrackingMode = (typeof STOCK_TRACKING_MODES)[number];

export const STOCK_ATTRIBUTE_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT'] as const;
export type StockAttributeType = (typeof STOCK_ATTRIBUTE_TYPES)[number];

export const STOCK_ATTRIBUTE_SCOPES = ['ITEM', 'SERIAL'] as const;
export type StockAttributeScope = (typeof STOCK_ATTRIBUTE_SCOPES)[number];

export const STOCK_LOCATION_KINDS = ['WAREHOUSE', 'STORE', 'SITE', 'ZONE', 'BIN'] as const;
export type StockLocationKind = (typeof STOCK_LOCATION_KINDS)[number];
export const STOCK_TOP_LEVEL_LOCATION_KINDS = ['WAREHOUSE', 'STORE', 'SITE'] as const;

export const STOCK_MOVEMENT_TYPES = [
  'RECEIPT',
  'ISSUE',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'RECEIPT_REVERSAL',
  'ISSUE_REVERSAL',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_SERIAL_STATUSES = ['AVAILABLE', 'ON_HOLD', 'BOOKED', 'ISSUED'] as const;
export type StockSerialStatus = (typeof STOCK_SERIAL_STATUSES)[number];

export const STOCK_LABEL_KINDS = ['ITEM', 'LOT', 'SERIAL', 'LOCATION'] as const;
export type StockLabelKind = (typeof STOCK_LABEL_KINDS)[number];

export type StockAttributeValue = string | boolean;
export type StockAttributes = Record<string, StockAttributeValue>;

export interface StockSettings {
  configured: boolean;
  /** Phase 32 — where a document line lands when it names no location. */
  defaultLocationId: string | null;
  industryProfile: StockIndustryKey | null;
  suggestedProfile: StockIndustryKey;
  updatedAt: string | null;
}
export interface StockUom {
  id: string;
  code: string;
  name: string;
  decimalPlaces: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockCategory {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  path: string;
  depth: number;
  itemType: StockItemType;
  defaultTracking: StockTrackingMode;
  defaultUomId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockAttributeDefinition {
  id: string;
  categoryId: string;
  appliesTo: StockAttributeScope;
  key: string;
  label: string;
  dataType: StockAttributeType;
  options: string[] | null;
  decimalPlaces: number | null;
  isRequired: boolean;
  sortOrder: number;
  isActive: boolean;
}
export interface StockCodeScheme {
  id: string;
  name: string;
  pattern: string;
  isDefault: boolean;
  isActive: boolean;
  example: string;
  createdAt: string;
  updatedAt: string;
}
export interface StockLocation {
  id: string;
  code: string;
  name: string;
  kind: StockLocationKind;
  parentId: string | null;
  path: string;
  depth: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  categoryId: string;
  categoryName: string;
  itemType: StockItemType;
  tracking: StockTrackingMode;
  uomId: string;
  uomCode: string;
  uomDecimalPlaces: number;
  codeSchemeId: string | null;
  barcode: string | null;
  attributes: StockAttributes;
  reorderPointMilli: number | null;
  onHandQuantityMilli: number;
  onHandValueCents: number;
  /** Phase 32 — the product this item is linked to; null = unlinked (posts no GL). */
  ledgerItemId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockLot {
  id: string;
  itemId: string;
  lotNumber: string;
  manufacturedOn: string | null;
  expiresOn: string | null;
  onHandQuantityMilli: number;
  createdAt: string;
}
export interface StockSerial {
  id: string;
  itemId: string;
  serialNumber: string;
  status: StockSerialStatus;
  locationId: string | null;
  locationCode: string | null;
  costCents: number;
  statusNote: string | null;
  attributes: StockAttributes;
  createdAt: string;
  updatedAt: string;
}
export interface StockMovement {
  id: string;
  movementGroupId: string;
  movementType: StockMovementType;
  itemId: string;
  itemCode: string;
  locationId: string;
  locationCode: string;
  lotId: string | null;
  lotNumber: string | null;
  serialId: string | null;
  serialNumber: string | null;
  quantityMilli: number;
  valueCents: number;
  runningLocationQuantityMilli: number;
  reference: string | null;
  reason: string | null;
  occurredOn: string;
  /** Phase 32 — ('bill'|'invoice', documentId) or ('stock', movementGroupId); null = no GL effect. */
  sourceType: string | null;
  sourceId: string | null;
  glAccountId: string | null;
  reversesMovementId: string | null;
  createdAt: string;
}
export interface StockBalance {
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string;
  locationId: string;
  locationCode: string;
  locationPath: string;
  lotId: string | null;
  lotNumber: string | null;
  expiresOn: string | null;
  quantityMilli: number;
  valueCents: number;
  averageUnitCostCents: number | null;
}
export interface StockSummary {
  activeItemCount: number;
  totalValueCents: number;
  lowStockItemCount: number;
  expiringLotCount: number;
  locationCount: number;
}
export interface StockLabel {
  kind: StockLabelKind;
  id: string;
  code: string;
  title: string;
  subtitle: string;
  payload: string;
  qrSvg: string;
  copies: number;
}
export interface StockLookupMatch {
  kind: StockLabelKind;
  id: string;
  itemId: string | null;
  code: string;
  title: string;
}

export interface StockIndustryProfileSummary {
  key: StockIndustryKey;
  name: string;
  description: string;
  locationName: string;
  categories: {
    code: string;
    name: string;
    itemType: StockItemType;
    defaultTracking: StockTrackingMode;
    attributes: { key: string; label: string; appliesTo: StockAttributeScope; dataType: StockAttributeType }[];
  }[];
  codeSchemes: { name: string; pattern: string; isDefault: boolean; example: string }[];
}

export interface StockCodeSchemePreset {
  name: string;
  pattern: string;
  description: string;
  example: string;
}

export interface StockMovementResult {
  movementGroupId: string;
  movements: StockMovement[];
}

/** GET /inventory/settings */
export function fetchStockSettings(signal?: AbortSignal): Promise<{ success: boolean; settings: StockSettings }> {
  return apiFetch('/inventory/settings', { signal: signal ?? null });
}

/** GET /inventory/setup/profiles */
export function fetchStockProfiles(
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; profiles: StockIndustryProfileSummary[] }> {
  return apiFetch('/inventory/setup/profiles', { signal: signal ?? null });
}

/** POST /inventory/setup */
export function applyStockProfile(industryProfile: StockIndustryKey): Promise<{
  success: boolean;
  settings: StockSettings;
  created: { uoms: number; categories: number; attributes: number; codeSchemes: number; locations: number };
}> {
  return apiFetch('/inventory/setup', { method: 'POST', body: JSON.stringify({ industryProfile }) });
}

/** GET /inventory/uoms */
export function fetchStockUoms(
  includeInactive?: boolean,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; uoms: StockUom[] }> {
  const suffix = includeInactive === true ? '?includeInactive=true' : '';
  return apiFetch(`/inventory/uoms${suffix}`, { signal: signal ?? null });
}

/** POST /inventory/uoms */
export function createStockUom(input: {
  code: string;
  name: string;
  decimalPlaces: number;
}): Promise<{ success: boolean; uom: StockUom }> {
  return apiFetch('/inventory/uoms', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /inventory/uoms/:id */
export function updateStockUom(
  id: string,
  input: Partial<{ name: string; isActive: boolean }>,
): Promise<{ success: boolean; uom: StockUom }> {
  return apiFetch(`/inventory/uoms/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** GET /inventory/categories */
export function fetchStockCategories(
  includeInactive?: boolean,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; categories: StockCategory[] }> {
  const suffix = includeInactive === true ? '?includeInactive=true' : '';
  return apiFetch(`/inventory/categories${suffix}`, { signal: signal ?? null });
}

/** GET /inventory/categories/:id */
export function fetchStockCategory(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; category: StockCategory; attributes: StockAttributeDefinition[] }> {
  return apiFetch(`/inventory/categories/${id}`, { signal: signal ?? null });
}

/** POST /inventory/categories */
export function createStockCategory(input: {
  code: string;
  name: string;
  itemType: StockItemType;
  defaultTracking: StockTrackingMode;
  defaultUomId: string | null;
  parentId: string | null;
}): Promise<{ success: boolean; category: StockCategory }> {
  return apiFetch('/inventory/categories', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /inventory/categories/:id */
export function updateStockCategory(
  id: string,
  input: Partial<{ name: string; defaultUomId: string | null; isActive: boolean }>,
): Promise<{ success: boolean; category: StockCategory }> {
  return apiFetch(`/inventory/categories/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** POST /inventory/categories/:id/attributes */
export function createStockAttribute(
  categoryId: string,
  input: {
    key: string;
    label: string;
    appliesTo: StockAttributeScope;
    dataType: StockAttributeType;
    options: string[] | null;
    decimalPlaces: number | null;
    isRequired: boolean;
    sortOrder: number;
  },
): Promise<{ success: boolean; attribute: StockAttributeDefinition }> {
  return apiFetch(`/inventory/categories/${categoryId}/attributes`, { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /inventory/categories/:id/attributes/:attributeId */
export function updateStockAttribute(
  categoryId: string,
  attributeId: string,
  input: Partial<{ label: string; options: string[]; isRequired: boolean; sortOrder: number; isActive: boolean }>,
): Promise<{ success: boolean; attribute: StockAttributeDefinition }> {
  return apiFetch(`/inventory/categories/${categoryId}/attributes/${attributeId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** GET /inventory/code-schemes */
export function fetchStockCodeSchemes(
  includeInactive?: boolean,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; codeSchemes: StockCodeScheme[] }> {
  const suffix = includeInactive === true ? '?includeInactive=true' : '';
  return apiFetch(`/inventory/code-schemes${suffix}`, { signal: signal ?? null });
}

/** GET /inventory/code-schemes/presets */
export function fetchStockCodePresets(
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; presets: StockCodeSchemePreset[] }> {
  return apiFetch('/inventory/code-schemes/presets', { signal: signal ?? null });
}

/** POST /inventory/code-schemes/preview */
export function previewStockCodePattern(input: {
  pattern: string;
  categoryId: string | null;
  attributes: Record<string, string | boolean>;
}): Promise<{ success: boolean; valid: boolean; example?: string; scopeKey?: string; error?: string }> {
  return apiFetch('/inventory/code-schemes/preview', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /inventory/code-schemes */
export function createStockCodeScheme(input: {
  name: string;
  pattern: string;
  isDefault: boolean;
}): Promise<{ success: boolean; codeScheme: StockCodeScheme }> {
  return apiFetch('/inventory/code-schemes', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /inventory/code-schemes/:id */
export function updateStockCodeScheme(
  id: string,
  input: Partial<{ name: string; isDefault: true; isActive: boolean }>,
): Promise<{ success: boolean; codeScheme: StockCodeScheme }> {
  return apiFetch(`/inventory/code-schemes/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** GET /inventory/locations */
export function fetchStockLocations(
  includeInactive?: boolean,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; locations: StockLocation[] }> {
  const suffix = includeInactive === true ? '?includeInactive=true' : '';
  return apiFetch(`/inventory/locations${suffix}`, { signal: signal ?? null });
}

/** POST /inventory/locations */
export function createStockLocation(input: {
  code: string;
  name: string;
  kind: StockLocationKind;
  parentId: string | null;
}): Promise<{ success: boolean; location: StockLocation }> {
  return apiFetch('/inventory/locations', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /inventory/locations/:id */
export function updateStockLocation(
  id: string,
  input: Partial<{ name: string; isActive: boolean }>,
): Promise<{ success: boolean; location: StockLocation }> {
  return apiFetch(`/inventory/locations/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** GET /inventory/items */
export function fetchStockItems(
  params: {
    q?: string | undefined;
    categoryId?: string | undefined;
    itemType?: StockItemType | undefined;
    tracking?: StockTrackingMode | undefined;
    includeInactive?: boolean | undefined;
    lowStock?: boolean | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  items: StockItem[];
}> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.categoryId !== undefined) query.set('categoryId', params.categoryId);
  if (params.itemType !== undefined) query.set('itemType', params.itemType);
  if (params.tracking !== undefined) query.set('tracking', params.tracking);
  if (params.includeInactive === true) query.set('includeInactive', 'true');
  if (params.lowStock === true) query.set('lowStock', 'true');
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/inventory/items${suffix}`, { signal: signal ?? null });
}

/** GET /inventory/items/:id */
export function fetchStockItem(
  id: string,
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  item: StockItem;
  attributes: StockAttributeDefinition[];
  serialAttributes: StockAttributeDefinition[];
}> {
  return apiFetch(`/inventory/items/${id}`, { signal: signal ?? null });
}

/** Phase 32 — the accounting side of the product a stock item is linked to. */
export interface StockItemProductInput {
  salePriceCents: number | null;
  purchasePriceCents: number | null;
  revenueAccountId: string | null;
  assetAccountId: string | null;
  cogsAccountId: string | null;
  saleTaxRateBp: number;
  purchaseTaxRateBp: number;
}

/** GET /inventory/product-balances — on-hand per product id. */
export interface StockProductBalance {
  ledgerItemId: string;
  stockItemId: string;
  tracking: StockTrackingMode;
  uomCode: string;
  uomDecimalPlaces: number;
  onHandQuantityMilli: number;
  isActive: boolean;
}
export function fetchStockProductBalances(
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; balances: StockProductBalance[] }> {
  return apiFetch('/inventory/product-balances', { signal: signal ?? null });
}

/** POST /inventory/items/:id/link-product */
export function linkStockItemProduct(
  id: string,
  product: StockItemProductInput,
): Promise<{ success: boolean; item: StockItem }> {
  return apiFetch(`/inventory/items/${id}/link-product`, { method: 'POST', body: JSON.stringify(product) });
}

/** PATCH /inventory/settings */
export function updateStockSettings(input: {
  defaultLocationId: string | null;
}): Promise<{ success: boolean; settings: StockSettings }> {
  return apiFetch('/inventory/settings', { method: 'PATCH', body: JSON.stringify(input) });
}

/** POST /inventory/items */
export function createStockItem(input: {
  name: string;
  description: string | null;
  categoryId: string;
  uomId: string | null;
  tracking: StockTrackingMode | null;
  code: string | null;
  codeSchemeId: string | null;
  barcode: string | null;
  attributes: Record<string, unknown>;
  reorderPointMilli: number | null;
  /** Phase 32 — prices/accounts of the linked product; omitted = defaults. */
  product?: StockItemProductInput;
}): Promise<{ success: boolean; item: StockItem }> {
  return apiFetch('/inventory/items', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /inventory/items/:id */
export function updateStockItem(
  id: string,
  input: Partial<{
    name: string;
    description: string | null;
    barcode: string | null;
    attributes: Record<string, unknown>;
    reorderPointMilli: number | null;
    isActive: boolean;
  }>,
): Promise<{ success: boolean; item: StockItem }> {
  return apiFetch(`/inventory/items/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export interface StockReceiptLineInput {
  itemId: string;
  quantityMilli: number;
  unitCostCents: number;
  lot: { lotNumber: string; manufacturedOn: string | null; expiresOn: string | null } | null;
  serials: { serialNumber: string; costCents: number | null; attributes: Record<string, unknown> }[] | null;
}
export interface StockOutboundLineInput {
  itemId: string;
  quantityMilli: number;
  lotId: string | null;
  serialIds: string[] | null;
}
export interface StockAdjustmentLineInput {
  itemId: string;
  direction: 'IN' | 'OUT';
  quantityMilli: number;
  lotId: string | null;
  unitCostCents: number | null;
}

/** POST /inventory/receipts */
export function postStockReceipt(input: {
  occurredOn: string;
  reference: string | null;
  locationId: string;
  lines: StockReceiptLineInput[];
}): Promise<{ success: boolean } & StockMovementResult> {
  return apiFetch('/inventory/receipts', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /inventory/issues */
export function postStockIssue(input: {
  occurredOn: string;
  reference: string | null;
  locationId: string;
  lines: StockOutboundLineInput[];
}): Promise<{ success: boolean } & StockMovementResult> {
  return apiFetch('/inventory/issues', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /inventory/transfers */
export function postStockTransfer(input: {
  occurredOn: string;
  reference: string | null;
  fromLocationId: string;
  toLocationId: string;
  lines: StockOutboundLineInput[];
}): Promise<{ success: boolean } & StockMovementResult> {
  return apiFetch('/inventory/transfers', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /inventory/adjustments */
export function postStockAdjustment(input: {
  occurredOn: string;
  reason: string;
  locationId: string;
  lines: StockAdjustmentLineInput[];
}): Promise<{ success: boolean } & StockMovementResult> {
  return apiFetch('/inventory/adjustments', { method: 'POST', body: JSON.stringify(input) });
}

/** GET /inventory/balances */
export function fetchStockBalances(
  params: { itemId?: string | undefined; locationId?: string | undefined; includeZero?: boolean | undefined } = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; balances: StockBalance[] }> {
  const query = new URLSearchParams();
  if (params.itemId !== undefined) query.set('itemId', params.itemId);
  if (params.locationId !== undefined) query.set('locationId', params.locationId);
  if (params.includeZero === true) query.set('includeZero', 'true');
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/inventory/balances${suffix}`, { signal: signal ?? null });
}

/** GET /inventory/movements */
export function fetchStockMovements(
  params: {
    itemId?: string | undefined;
    locationId?: string | undefined;
    type?: StockMovementType | undefined;
    groupId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  } = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  movements: StockMovement[];
}> {
  const query = new URLSearchParams();
  if (params.itemId !== undefined) query.set('itemId', params.itemId);
  if (params.locationId !== undefined) query.set('locationId', params.locationId);
  if (params.type !== undefined) query.set('type', params.type);
  if (params.groupId !== undefined) query.set('groupId', params.groupId);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/inventory/movements${suffix}`, { signal: signal ?? null });
}

/** GET /inventory/items/:id/lots */
export function fetchStockItemLots(
  itemId: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; lots: StockLot[] }> {
  return apiFetch(`/inventory/items/${itemId}/lots`, { signal: signal ?? null });
}

/** GET /inventory/items/:id/serials */
export function fetchStockItemSerials(
  itemId: string,
  status?: StockSerialStatus,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; serials: StockSerial[] }> {
  const suffix = status !== undefined ? `?status=${status}` : '';
  return apiFetch(`/inventory/items/${itemId}/serials${suffix}`, { signal: signal ?? null });
}

/** GET /inventory/summary */
export function fetchStockSummary(signal?: AbortSignal): Promise<{ success: boolean; summary: StockSummary }> {
  return apiFetch('/inventory/summary', { signal: signal ?? null });
}

/** POST /inventory/serials/:id/status */
export function changeStockSerialStatus(
  id: string,
  input: { status: 'AVAILABLE' | 'ON_HOLD' | 'BOOKED'; note: string | null },
): Promise<{ success: boolean; serial: StockSerial }> {
  return apiFetch(`/inventory/serials/${id}/status`, { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /inventory/serials/:id */
export function updateStockSerialAttributes(
  id: string,
  attributes: Record<string, unknown>,
): Promise<{ success: boolean; serial: StockSerial }> {
  return apiFetch(`/inventory/serials/${id}`, { method: 'PATCH', body: JSON.stringify({ attributes }) });
}

/** GET /inventory/lookup?q= */
export function lookupStock(
  q: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; matches: StockLookupMatch[] }> {
  const query = new URLSearchParams({ q });
  return apiFetch(`/inventory/lookup?${query.toString()}`, { signal: signal ?? null });
}

/** GET /inventory/lookup?kind=lot|serial&id= */
export function lookupStockById(
  kind: 'lot' | 'serial',
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; match: StockLookupMatch }> {
  const query = new URLSearchParams({ kind, id });
  return apiFetch(`/inventory/lookup?${query.toString()}`, { signal: signal ?? null });
}

/** POST /inventory/labels */
export function buildStockLabels(
  targets: { kind: StockLabelKind; id: string; copies: number }[],
): Promise<{ success: boolean; count: number; labels: StockLabel[] }> {
  return apiFetch('/inventory/labels', { method: 'POST', body: JSON.stringify({ targets }) });
}
