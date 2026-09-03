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

/** PATCH /organizations — the organization's name and/or base currency. OWNER/ADMIN only. */
export async function updateOrganization(input: {
  name?: string;
  baseCurrency?: string;
}): Promise<OrganizationSummary> {
  const body = await apiFetch<{ success: boolean; organization: OrganizationSummary }>('/organizations', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.organization;
}
