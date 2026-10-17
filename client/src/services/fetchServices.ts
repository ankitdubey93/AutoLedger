import {
  AUTH_EXPIRED_EVENT,
  fetchWithAutoRefresh,
  refreshSession,
  type AutoRefreshOptions,
} from '../utils/fetchWithAutoRefresh';
import type { PaymentTermRule } from '../utils/dueDate';
import { saveBlob } from '../utils/saveBlob';

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
/** Built-in roles; 'CUSTOM' (Phase 38c) means an organization-defined role — see `roleName`. */
export type BuiltinRole = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER';
export type Role = BuiltinRole | 'CUSTOM';

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
  roleName: string;
  joinedAt: string;
}

export interface OrganizationMember {
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  customRoleId: string | null;
  roleName: string;
  joinedAt: string;
}

/** The body of /auth/check, /auth/login, /auth/refresh and /auth/switch-org. */
export interface SessionResponse {
  success: boolean;
  user: PublicUser;
  organization: OrganizationSummary | null;
  role: Role | null;
  /** Phase 38c — the active role's display name (a custom role's own name). */
  roleName: string | null;
  /** Phase 38c — permission keys held in the active organization (display only; the server re-checks). */
  permissions: string[];
  memberships: Membership[];
  accessTokenExpiresAt: string;
}

/**
 * Exactly one of `organizationName` (create your own organization) or
 * `inviteToken` (Phase 37 — join the organization that invited you).
 */
export type RegisterInput = {
  name: string;
  email: string;
  password: string;
} & ({ organizationName: string; inviteToken?: never } | { inviteToken: string; organizationName?: never });

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
 * POST /auth/forgot-password — always resolves the same way whether or not the
 * email has an account; the server never says which.
 */
export function requestPasswordReset(email: string): Promise<{ success: boolean; message: string }> {
  return apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }, NO_AUTO_REFRESH);
}

/** POST /auth/reset-password — consumes the emailed token; every existing session is signed out. */
export function resetPassword(token: string, password: string): Promise<{ success: boolean }> {
  return apiFetch('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }, NO_AUTO_REFRESH);
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

/** Phase 46d — one member's sign-in and change counts (server: loginEventService.listMemberActivity). */
export interface MemberActivity {
  userId: string;
  name: string | null;
  email: string;
  role: string;
  lastSignInAt: string | null;
  failedSignInsLast30Days: number;
  changesLast30Days: number;
}

/** GET /organizations/members/activity — requires audit.view (OWNER, ADMIN). */
export function listMemberActivity(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  members: MemberActivity[];
}> {
  return apiFetch('/organizations/members/activity', { signal: signal ?? null });
}

/* ------------------------------------------- Phase 38a — user settings */

/** One signed-in browser. `id` survives token rotation; `current` is this one. */
export interface ActiveSession {
  id: string;
  startedAt: string;
  lastActiveAt: string;
  userAgent: string | null;
  ip: string | null;
  organizationName: string | null;
  current: boolean;
}

/** PATCH /auth/me — your own display name. */
export function updateProfile(input: { name: string }): Promise<{ success: boolean; user: PublicUser }> {
  return apiFetch('/auth/me', { method: 'PATCH', body: JSON.stringify(input) });
}

/**
 * POST /auth/change-password — signs every other session out. A wrong
 * current password is a 400 (not 401, which would trigger a token refresh).
 */
export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; signedOutSessions: number }> {
  return apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify(input) });
}

/** GET /auth/sessions */
export function listSessions(): Promise<{ success: boolean; count: number; sessions: ActiveSession[] }> {
  return apiFetch('/auth/sessions');
}

/** DELETE /auth/sessions/:id — sign one other browser out. */
export function revokeSession(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/auth/sessions/${id}`, { method: 'DELETE' });
}

/** POST /auth/sessions/revoke-others — sign out everywhere except here. */
export function revokeOtherSessions(): Promise<{ success: boolean; signedOutSessions: number }> {
  return apiFetch('/auth/sessions/revoke-others', { method: 'POST' });
}

/** Phase 46d — what a sign-in history row records (server: LOGIN_OUTCOMES). */
export type LoginOutcome =
  | 'SUCCESS'
  | 'FAILED'
  | 'LOGOUT'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'SESSION_REVOKED';

/** Phase 46d — one row of the caller's own sign-in history. */
export interface LoginEvent {
  id: string;
  outcome: LoginOutcome;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** GET /auth/login-events — the caller's own sign-in history, newest first. */
export function listMyLoginEvents(): Promise<{ success: boolean; count: number; events: LoginEvent[] }> {
  return apiFetch('/auth/login-events');
}

/* ------------------------------------------------ Phase 38b — email */

/** POST /auth/verify-email — public; the token is the proof. */
export function verifyEmail(token: string): Promise<{ success: boolean }> {
  return apiFetch('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }, NO_AUTO_REFRESH);
}

/** POST /auth/verify-email/resend — 429 within a minute of the last one. */
export function resendVerification(): Promise<{ success: boolean }> {
  return apiFetch('/auth/verify-email/resend', { method: 'POST' });
}

/** POST /auth/me/email — sends a confirmation link to the new address; nothing changes until it is opened. */
export function requestEmailChange(input: { newEmail: string; currentPassword: string }): Promise<{ success: boolean }> {
  return apiFetch('/auth/me/email', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /auth/confirm-email-change — public; the token is the proof. */
export function confirmEmailChange(token: string): Promise<{ success: boolean }> {
  return apiFetch('/auth/confirm-email-change', { method: 'POST', body: JSON.stringify({ token }) }, NO_AUTO_REFRESH);
}

export type NotificationEvent = 'bill_awaiting_approval' | 'invitation_accepted' | 'quote_responded';

export interface NotificationPreference {
  event: NotificationEvent;
  enabled: boolean;
}

/** GET /auth/me/notifications */
export function getNotificationPreferences(): Promise<{ success: boolean; preferences: NotificationPreference[] }> {
  return apiFetch('/auth/me/notifications');
}

/** PUT /auth/me/notifications */
export function setNotificationPreferences(
  preferences: NotificationPreference[],
): Promise<{ success: boolean; preferences: NotificationPreference[] }> {
  return apiFetch('/auth/me/notifications', { method: 'PUT', body: JSON.stringify({ preferences }) });
}

export interface OrganizationEmailSettings {
  senderName: string | null;
  replyTo: string | null;
  fromEmail: string;
  transport: 'log' | 'mailpit' | 'brevo';
}

/** GET /organizations/email-settings — OWNER and ADMIN. */
export function getEmailSettings(): Promise<{ success: boolean; settings: OrganizationEmailSettings }> {
  return apiFetch('/organizations/email-settings');
}

/** PATCH /organizations/email-settings — `null` resets a field to the default. */
export function updateEmailSettings(input: {
  senderName?: string | null;
  replyTo?: string | null;
}): Promise<{ success: boolean; settings: OrganizationEmailSettings }> {
  return apiFetch('/organizations/email-settings', { method: 'PATCH', body: JSON.stringify(input) });
}

/* ---------------------------------------------- Phase 37 — organizations */

/**
 * The session-moving organization calls live under /auth on the server,
 * like /auth/switch-org, because the refresh cookie is only sent there.
 */

/** POST /auth/organizations — create an organization you own; the session moves into it. */
export function createOrganization(name: string): Promise<SessionResponse> {
  return apiFetch('/auth/organizations', { method: 'POST', body: JSON.stringify({ name }) });
}

/** POST /auth/leave-org — leave the active organization; the session moves to another. */
export function leaveOrganization(): Promise<SessionResponse> {
  return apiFetch('/auth/leave-org', { method: 'POST' });
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  customRoleId: string | null;
  roleName: string;
  status: InvitationStatus;
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreview {
  organizationName: string;
  invitedByName: string | null;
  email: string;
  role: Role;
  roleName: string;
  status: InvitationStatus;
  expiresAt: string;
}

/** GET /auth/invitations/:token — public; what the invite link is for. */
export function previewInvitation(token: string): Promise<{ success: boolean; invitation: InvitationPreview }> {
  return apiFetch(`/auth/invitations/${encodeURIComponent(token)}`, {}, NO_AUTO_REFRESH);
}

/** POST /auth/invitations/:token/accept — join the organization; the session moves into it. */
export function acceptInvitation(token: string): Promise<SessionResponse> {
  return apiFetch(`/auth/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' });
}

/** GET /organizations/invitations — OWNER and ADMIN only. */
export function listInvitations(): Promise<{ success: boolean; count: number; invitations: Invitation[] }> {
  return apiFetch('/organizations/invitations');
}

/** POST /organizations/invitations — the accept link is returned this once and never again. */
/** Phase 38c — a member's role is either built in or one of the organization's custom roles. */
export type RoleChoice = { role: BuiltinRole } | { customRoleId: string };

export function createInvitation(
  input: { email: string } & RoleChoice,
): Promise<{ success: boolean; invitation: Invitation; acceptUrl: string }> {
  return apiFetch('/organizations/invitations', { method: 'POST', body: JSON.stringify(input) });
}

/** DELETE /organizations/invitations/:id */
export function revokeInvitation(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/organizations/invitations/${id}`, { method: 'DELETE' });
}

/** PATCH /organizations/members/:userId — only an OWNER may grant or change OWNER. */
export function updateMemberRole(userId: string, choice: RoleChoice): Promise<{ success: boolean; member: OrganizationMember }> {
  return apiFetch(`/organizations/members/${userId}`, { method: 'PATCH', body: JSON.stringify(choice) });
}

/* -------------------------------------------- Phase 38c — custom roles */

export interface PermissionDefinition {
  key: string;
  area: string;
  label: string;
  tier: 'V' | 'A' | 'M' | 'O';
  requires?: string[];
}

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  memberCount: number;
}

export interface RolesOverview {
  builtin: Array<{ role: BuiltinRole; permissions: string[] }>;
  custom: CustomRole[];
  catalogue: PermissionDefinition[];
}

/** GET /organizations/roles */
export function listRoles(): Promise<{ success: boolean } & RolesOverview> {
  return apiFetch('/organizations/roles');
}

export interface RoleInput {
  name: string;
  description: string | null;
  permissions: string[];
}

/** POST /organizations/roles — the server closes the set over `requires`. */
export function createRole(input: RoleInput): Promise<{ success: boolean; role: CustomRole }> {
  return apiFetch('/organizations/roles', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /organizations/roles/:id — applies to every holder on their next request. */
export function updateRole(id: string, input: RoleInput): Promise<{ success: boolean; role: CustomRole }> {
  return apiFetch(`/organizations/roles/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** DELETE /organizations/roles/:id — 409 while anyone holds it. */
export function deleteRole(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/organizations/roles/${id}`, { method: 'DELETE' });
}

/** DELETE /organizations/members/:userId — someone else; leaving yourself is leaveOrganization(). */
export function removeMember(userId: string): Promise<{ success: boolean }> {
  return apiFetch(`/organizations/members/${userId}`, { method: 'DELETE' });
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

/** Phase 44. Mirrors server/src/types/accounting.ts's BankAccountKind. */
export const BANK_ACCOUNT_KINDS = ['BANK', 'CREDIT_CARD'] as const;
export type BankAccountKind = (typeof BANK_ACCOUNT_KINDS)[number];

/** Phase 45. Mirrors server/src/types/accounting.ts's CashFlowCategory. */
export type CashFlowCategory = 'CASH' | 'OPERATING' | 'INVESTING' | 'FINANCING';

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
  description: string | null;
  /** Phase 44 — null unless the account is a bank (Asset) or credit card (Liability) account. */
  bankAccountKind: BankAccountKind | null;
  /** Phase 45 — null means "derived from the account's type and code". Optional so pre-Phase-45 fixtures still typecheck. */
  cashFlowCategory?: CashFlowCategory | null;
  /** Phase 46a — the system roles this account holds. Optional so pre-46a fixtures still typecheck. */
  systemRoles?: SystemRoleRef[];
  createdAt: string;
  updatedAt: string;
}

/** Phase 46a. Mirrors server/src/types/accounting.ts's SystemRoleRef. */
export interface SystemRoleRef {
  role: string;
  label: string;
}

/** Phase 46a. Mirrors server/src/types/accounting.ts's SystemAccountView — one row of GET /accounts/system. */
export interface SystemAccountView {
  role: string;
  label: string;
  defaultCode: string;
  remappable: boolean;
  accountId: string | null;
  code: string | null;
  name: string | null;
  isActive: boolean | null;
}

export interface AccountNode extends Account {
  children: AccountNode[];
}

export interface LedgerLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Phase 44 — the line's own description; null if it has none. */
  description: string | null;
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
  /** Phase 40 — the description as written, before its placeholders were filled; null if it had none. */
  descriptionTemplate: string | null;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  /** Phase 44 — the manual journal that owns this posting, if any. */
  manualJournalId: string | null;
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

/** Phase 46a — GET /accounts/system: one row per system role, in registry order. */
export function listSystemAccounts(signal?: AbortSignal): Promise<{
  success: boolean;
  count: number;
  systemAccounts: SystemAccountView[];
}> {
  return apiFetch('/accounts/system', { signal: signal ?? null });
}

/** Mirrors server/src/schemas/accounting/accountSchema.ts's createAccountSchema. */
export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  description: string | null;
  /** Phase 44. */
  bankAccountKind?: BankAccountKind | null;
  /** Phase 45. */
  cashFlowCategory?: CashFlowCategory | null;
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
  /** Phase 44. */
  bankAccountKind?: BankAccountKind | null;
  /** Phase 45. */
  cashFlowCategory?: CashFlowCategory | null;
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

/* -------------------------------------------- Phase 44 — manual journals */

/** Phase 44. Mirrors server/src/types/accounting.ts's ManualJournalStatus. */
export const MANUAL_JOURNAL_STATUSES = ['DRAFT', 'TEMPLATE', 'POSTED', 'VOIDED'] as const;
export type ManualJournalStatus = (typeof MANUAL_JOURNAL_STATUSES)[number];

/** Phase 44. Mirrors server/src/types/accounting.ts's ManualJournalOrigin. */
export const MANUAL_JOURNAL_ORIGINS = ['MANUAL', 'RECURRING', 'IMPORT'] as const;
export type ManualJournalOrigin = (typeof MANUAL_JOURNAL_ORIGINS)[number];

/** Phase 44. Mirrors server/src/types/accounting.ts's ManualJournalLine. */
export interface ManualJournalLine {
  id: string;
  lineNumber: number;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  description: string | null;
  debitCents: number;
  creditCents: number;
}

/** Phase 44. Mirrors server/src/types/accounting.ts's ManualJournalSummary. */
export interface ManualJournalSummary {
  id: string;
  status: ManualJournalStatus;
  origin: ManualJournalOrigin;
  narration: string;
  narrationTemplate: string | null;
  entryDate: string;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  recurringScheduleId: string | null;
  /** Set on a TEMPLATE: the schedule that runs it. */
  templateScheduleId: string | null;
  postedAt: string | null;
  voidedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  totalDebitCents: number;
  totalCreditCents: number;
}

/** Phase 44. Mirrors server/src/types/accounting.ts's ManualJournal. */
export interface ManualJournal extends ManualJournalSummary {
  lines: ManualJournalLine[];
}

/** Phase 44. The body of POST/PATCH /manual-journals (and the base of a repeating journal). */
export interface ManualJournalInput {
  narration: string;
  entryDate: string;
  lines: Array<{
    accountId: string | null;
    description: string | null;
    debitCents: number;
    creditCents: number;
  }>;
}

/** Phase 44. */
export interface ManualJournalListParams {
  status?: 'all' | 'draft' | 'posted' | 'voided';
  q?: string;
  from?: string;
  to?: string;
  page?: number;
}

/** Phase 44. The body of POST /manual-journals/repeating. */
export interface CreateRepeatingJournalInput extends ManualJournalInput {
  name: string;
  frequency: RecurringFrequency;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  autoReverse: boolean;
}

/** GET /manual-journals — paginated; `counts` ignores the status filter. */
export function listManualJournals(
  params: ManualJournalListParams = {},
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  count: number;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  counts: { all: number; draft: number; posted: number; voided: number };
  journals: ManualJournalSummary[];
}> {
  const query = new URLSearchParams();
  // An empty filter box must send no parameter at all, not `?q=`.
  if (params.status !== undefined) query.set('status', params.status);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.page !== undefined) query.set('page', String(params.page));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch(`/manual-journals${suffix}`, { signal: signal ?? null });
}

/** GET /manual-journals/:id */
export function getManualJournal(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; journal: ManualJournal }> {
  return apiFetch(`/manual-journals/${id}`, { signal: signal ?? null });
}

/** POST /manual-journals — `action` 'draft' saves a draft, 'post' posts it at once. */
export function createManualJournal(
  body: ManualJournalInput & { action: 'draft' | 'post' },
): Promise<{ success: boolean; journal: ManualJournal }> {
  return apiFetch('/manual-journals', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /manual-journals/:id — full replacement; a draft or a repeating template only. */
export function updateManualJournal(
  id: string,
  body: ManualJournalInput,
): Promise<{ success: boolean; journal: ManualJournal }> {
  return apiFetch(`/manual-journals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /manual-journals/:id — a draft only. */
export async function deleteManualJournal(id: string): Promise<void> {
  await apiFetch(`/manual-journals/${id}`, { method: 'DELETE' });
}

/** POST /manual-journals/:id/post — posts a draft; the GL entry is immutable from here. */
export function postManualJournal(
  id: string,
): Promise<{ success: boolean; journal: ManualJournal }> {
  return apiFetch(`/manual-journals/${id}/post`, { method: 'POST', body: JSON.stringify({}) });
}

/** POST /manual-journals/:id/void — posts a reversal; the original is kept. */
export function voidManualJournal(
  id: string,
  body: { voidDate: string | null },
): Promise<{ success: boolean; journal: ManualJournal }> {
  return apiFetch(`/manual-journals/${id}/void`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /manual-journals/repeating — creates the template and its schedule together. */
export function createRepeatingJournal(
  body: CreateRepeatingJournalInput,
): Promise<{ success: boolean; journal: ManualJournal; schedule: RecurringSchedule }> {
  return apiFetch('/manual-journals/repeating', { method: 'POST', body: JSON.stringify(body) });
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
  /** Phase 35a. `null` falls back to chart codes 1140/5050/5400/3400. */
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  inventoryAdjustmentAccountId: string | null;
  stockOpeningAccountId: string | null;
  /** Phase 43a. `null` means no organization default term for that side. */
  defaultSalesPaymentTermId: string | null;
  defaultPurchasePaymentTermId: string | null;
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
  inventoryAccountId?: string | null;
  cogsAccountId?: string | null;
  inventoryAdjustmentAccountId?: string | null;
  stockOpeningAccountId?: string | null;
  defaultSalesPaymentTermId?: string | null;
  defaultPurchasePaymentTermId?: string | null;
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
  /** Phase 43a. `null` means "use the organization default". */
  defaultPaymentTermId: string | null;
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
  defaultPaymentTermId?: string | null;
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
    defaultPaymentTermId: string | null;
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
  /** Phase 43a. How `netDays` is applied to a document date. */
  rule: PaymentTermRule;
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
  rule?: PaymentTermRule;
}): Promise<{ success: boolean; paymentTerm: PaymentTerm }> {
  return apiFetch('/payment-terms', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /payment-terms/:id */
export function updatePaymentTerm(
  id: string,
  body: Partial<{ name: string; netDays: number; isActive: boolean; rule: PaymentTermRule }>,
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
  /** Phase 44 — the manual journal this schedule runs from, if it is a repeating journal. */
  sourceManualJournalId: string | null;
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

/** GET /items/:id */
export function getItem(id: string, signal?: AbortSignal): Promise<{ success: boolean; item: Item }> {
  return apiFetch(`/items/${id}`, { signal: signal ?? null });
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
    /** Inventory items only. */
    assetAccountId: string | null;
    cogsAccountId: string | null;
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
  /** Phase 40 — the description as written, before its placeholders were filled; null if it had none. */
  descriptionTemplate: string | null;
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
  /** Phase 42 — the order line this invoice line bills, if any. */
  orderLineId: string | null;
}

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'VOID';

/** Mirrors server/src/types/accounting.ts's SettlementStatus. Derived, never stored. */
export type SettlementStatus = 'NOT_APPLICABLE' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE';

/** Mirrors server/src/types/accounting.ts's Invoice. */
/** Phase 42 — mirrors server DepositApplication (base currency only). */
export interface DepositApplication {
  id: string;
  direction: QuoteDirection;
  depositDocumentId: string;
  depositDocumentNumber: string | null;
  targetDocumentId: string;
  targetDocumentNumber: string | null;
  amountCents: number;
  applicationDate: string;
  status: 'POSTED' | 'VOID';
  journalEntryId: string;
  voidJournalEntryId: string | null;
  createdAt: string;
}

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
  /** Phase 40 — the notes as written, before their placeholders were filled; null if they had none. */
  notesTemplate: string | null;
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
  /** Phase 41 — the accepted quote this invoice was converted from, if any. */
  sourceQuote: SourceQuoteRef | null;
  /** Phase 42 — POSTED deposit applications against this invoice. `0` unless status is ISSUED. */
  depositAppliedCents: number;
  /** Phase 42 — STANDARD, or DEPOSIT for a deposit invoice raised on a confirmed order. */
  kind: 'STANDARD' | 'DEPOSIT';
  /** Phase 42 — the order a DEPOSIT invoice was raised for; null for STANDARD. */
  depositForOrderId: string | null;
  /** Phase 42 — applications where this document is the deposit or the target. [] in lists. */
  depositApplications: DepositApplication[];
  /** Phase 43b — the sales order this invoice references; null if none. */
  salesOrderId: string | null;
  /** Phase 43b — the referenced sales order's number; null if none. */
  salesOrderNumber: string | null;
}

export type SettlementFilter = 'OUTSTANDING' | 'OVERDUE' | 'PAID';

export type InvoiceSortKey = 'issueDate' | 'dueDate' | 'number' | 'customer' | 'total' | 'status';

export interface InvoiceFilters {
  page?: number;
  limit?: number;
  status?: InvoiceStatus | '';
  customerId?: string;
  from?: string;
  to?: string;
  q?: string;
  settlement?: SettlementFilter | '';
  /** 2026-09-30 — server-side sort; omitted means the server's newest-first default. */
  sort?: InvoiceSortKey;
  dir?: 'asc' | 'desc';
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
  if (params.sort !== undefined) query.set('sort', params.sort);
  if (params.dir !== undefined) query.set('dir', params.dir);
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
  /** Phase 42 — the order line this invoice line bills, if any. */
  orderLineId?: string | null;
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
  /** Phase 43b — vault documents to link to the invoice in the same transaction. */
  attachmentDocumentIds?: string[];
  /** Phase 43b — a confirmed or closed sales order for the same customer; null clears it. */
  salesOrderId?: string | null;
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
  applyCredits?: { kind: 'NOTE' | 'DEPOSIT'; id: string; amountCents: number }[],
): Promise<{ success: boolean; invoice: Invoice }> {
  return apiFetch(`/invoices/${id}/issue`, {
    method: 'POST',
    body: JSON.stringify({ entryDate, applyCredits }),
  });
}

/** One open credit a draft bill or invoice can apply on approval or issue (Phase 43c). */
export interface AvailableCredit {
  kind: 'NOTE' | 'DEPOSIT';
  id: string;
  number: string | null;
  date: string;
  currencyCode: string;
  availableCents: number;
}

/**
 * GET /bills/:id/available-credits (PURCHASE) or /invoices/:id/available-credits (SALES).
 * Lists the party's open debit/credit notes and prepayments/deposits for a draft document.
 */
export function getAvailableCredits(
  direction: 'PURCHASE' | 'SALES',
  id: string,
): Promise<{ success: boolean; credits: AvailableCredit[] }> {
  const base = direction === 'PURCHASE' ? 'bills' : 'invoices';
  return apiFetch(`/${base}/${id}/available-credits`);
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
  quotePrefix: string;
  quoteNextNumber: number;
  purchaseQuotePrefix: string;
  purchaseQuoteNextNumber: number;
  defaultQuoteValidityDays: number;
  defaultQuoteTerms: string | null;
  quoteAcceptanceRequiresCode: boolean;
  /** Phase 42 — Liability account for deposit invoices; null falls back to code 2130. */
  customerDepositAccountId: string | null;
  /** Phase 42 — Asset account for deposit bills; null falls back to code 1150. */
  supplierPrepaymentAccountId: string | null;
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
  /** Phase 43a. `null` means "use the organization default". */
  defaultPaymentTermId: string | null;
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
  defaultPaymentTermId?: string | null;
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
    defaultPaymentTermId: string | null;
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
  | 'DEBIT_NOTE_VOID'
  | 'DEPOSIT_APPLICATION'
  | 'DEPOSIT_APPLICATION_VOID';

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

/* ------------------------------------------- accounting: statements (Phase 39) */

export const STATEMENT_TYPES = ['OUTSTANDING', 'ACTIVITY'] as const;
/** Mirrors server/src/types/accounting.ts's StatementType. */
export type StatementType = (typeof STATEMENT_TYPES)[number];

/** Mirrors server/src/types/accounting.ts's StatementSettings. */
export interface StatementSettings {
  templateId: InvoiceTemplateId;
  documentTitle: string;
  defaultType: StatementType;
  showLogo: boolean;
  showOrgAddress: boolean;
  showAgingSummary: boolean;
  showRemittance: boolean;
  footerNotes: string | null;
  accentColor: string;
  configured: boolean;
}

/** Mirrors server/src/types/accounting.ts's StatementParty. */
export interface StatementParty {
  kind: PartyKind;
  id: string;
  name: string;
  email: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
}

/** Mirrors server/src/types/accounting.ts's PartyStatement. Every amount is base currency. */
export interface PartyStatement {
  type: StatementType;
  party: StatementParty;
  statementDate: string;
  from: string | null;
  openingBalanceCents: number | null;
  periodDebitCents: number;
  periodCreditCents: number;
  closingBalanceCents: number;
  rows: PartyLedgerRow[];
  openItems: PartyOpenItem[];
  outstandingCents: number;
  overdueCents: number;
  aging: Record<AgingBucket, number>;
}

/** Mirrors server/src/types/accounting.ts's StatementListRow. */
export interface StatementListRow {
  partyId: string;
  name: string;
  email: string | null;
  isActive: boolean;
  outstandingCents: number;
  overdueCents: number;
  lastSentAt: string | null;
}

/** What a statement is asked for: OUTSTANDING on `asOf`, or ACTIVITY over `from`..`to`. */
export type StatementRequest =
  | { type: 'OUTSTANDING'; asOf: string }
  | { type: 'ACTIVITY'; from: string; to: string };

export type StatementPartyPath = 'customers' | 'vendors';

export function statementQuery(request: StatementRequest): string {
  const query = new URLSearchParams({ type: request.type });
  if (request.type === 'OUTSTANDING') query.set('asOf', request.asOf);
  else {
    query.set('from', request.from);
    query.set('to', request.to);
  }
  return query.toString();
}

/** GET /statements/customers|vendors — outstanding and overdue per party on `asOf`. */
export function listStatementParties(
  path: StatementPartyPath,
  params: { asOf: string; q?: string; includeZero?: boolean },
  signal?: AbortSignal,
): Promise<{ success: boolean; asOf: string; count: number; parties: StatementListRow[] }> {
  const query = new URLSearchParams({ asOf: params.asOf });
  if (params.q !== undefined && params.q.trim() !== '') query.set('q', params.q.trim());
  if (params.includeZero === true) query.set('includeZero', 'true');
  return apiFetch(`/statements/${path}?${query.toString()}`, { signal: signal ?? null });
}

/** GET /statements/customers|vendors/:id */
export async function getPartyStatement(
  path: StatementPartyPath,
  id: string,
  request: StatementRequest,
  signal?: AbortSignal,
): Promise<PartyStatement> {
  const body = await apiFetch<{ success: boolean; statement: PartyStatement }>(
    `/statements/${path}/${id}?${statementQuery(request)}`,
    { signal: signal ?? null },
  );
  return body.statement;
}

/** GET /settings/statements — defaults returned until the org saves one. */
export async function getStatementSettings(signal?: AbortSignal): Promise<StatementSettings> {
  const body = await apiFetch<{ success: boolean; statementSettings: StatementSettings }>(
    '/settings/statements',
    { signal: signal ?? null },
  );
  return body.statementSettings;
}

/** PATCH /settings/statements — OWNER/ADMIN only. */
export async function updateStatementSettings(
  input: Partial<StatementSettings>,
): Promise<StatementSettings> {
  const body = await apiFetch<{ success: boolean; statementSettings: StatementSettings }>(
    '/settings/statements',
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return body.statementSettings;
}

/* ------------------------------------- statements: email & public link (Phase 39b) */

/** Mirrors server/src/types/accounting.ts's StatementEmailTemplate. */
export interface StatementEmailTemplate {
  id: string | null;
  partyKind: PartyKind;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
  builtIn: boolean;
  updatedAt: string | null;
}

/** Mirrors server/src/types/accounting.ts's StatementSend. */
export interface StatementSend {
  id: string;
  partyKind: PartyKind;
  partyId: string;
  statementType: StatementType;
  asOf: string | null;
  from: string | null;
  to: string | null;
  toEmail: string;
  templateName: string | null;
  sentByName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
}

export interface SendStatementsResult {
  sent: { partyId: string; sendId: string; toEmail: string }[];
  skipped: { partyId: string; name: string; reason: 'NO_EMAIL' }[];
}

export interface StatementEmailPreview {
  toEmail: string | null;
  subject: string;
  body: string;
}

function requestBody(request: StatementRequest): Record<string, string> {
  return request.type === 'OUTSTANDING'
    ? { type: request.type, asOf: request.asOf }
    : { type: request.type, from: request.from, to: request.to };
}

/** GET /settings/statement-email-templates — built-in defaults included when none are saved. */
export async function listStatementEmailTemplates(kind?: PartyKind): Promise<StatementEmailTemplate[]> {
  const suffix = kind === undefined ? '' : `?kind=${kind}`;
  const body = await apiFetch<{ success: boolean; templates: StatementEmailTemplate[] }>(
    `/settings/statement-email-templates${suffix}`,
  );
  return body.templates;
}

export async function createStatementEmailTemplate(input: {
  partyKind: PartyKind;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
}): Promise<StatementEmailTemplate> {
  const body = await apiFetch<{ success: boolean; template: StatementEmailTemplate }>(
    '/settings/statement-email-templates',
    { method: 'POST', body: JSON.stringify(input) },
  );
  return body.template;
}

export async function updateStatementEmailTemplate(
  id: string,
  input: Partial<{ name: string; subject: string; body: string; isDefault: boolean }>,
): Promise<StatementEmailTemplate> {
  const body = await apiFetch<{ success: boolean; template: StatementEmailTemplate }>(
    `/settings/statement-email-templates/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return body.template;
}

export async function deleteStatementEmailTemplate(id: string): Promise<void> {
  await apiFetch(`/settings/statement-email-templates/${id}`, { method: 'DELETE' });
}

/** POST /statements/customers|vendors/send */
export function sendStatements(
  path: StatementPartyPath,
  input: { partyIds: string[]; request: StatementRequest; templateId: string | null; toEmail: string | null },
): Promise<{ success: boolean } & SendStatementsResult> {
  return apiFetch(`/statements/${path}/send`, {
    method: 'POST',
    body: JSON.stringify({
      ...requestBody(input.request),
      partyIds: input.partyIds,
      templateId: input.templateId,
      toEmail: input.toEmail,
    }),
  });
}

/** POST /statements/customers|vendors/preview-email */
export async function previewStatementEmail(
  path: StatementPartyPath,
  input: { partyId: string; request: StatementRequest; templateId: string | null },
): Promise<StatementEmailPreview> {
  const body = await apiFetch<{ success: boolean; preview: StatementEmailPreview }>(
    `/statements/${path}/preview-email`,
    {
      method: 'POST',
      body: JSON.stringify({ ...requestBody(input.request), partyId: input.partyId, templateId: input.templateId }),
    },
  );
  return body.preview;
}

/** GET /statements/customers|vendors/:id/sends */
export async function listStatementSends(path: StatementPartyPath, partyId: string): Promise<StatementSend[]> {
  const body = await apiFetch<{ success: boolean; sends: StatementSend[] }>(`/statements/${path}/${partyId}/sends`);
  return body.sends;
}

/** POST /statement-sends/:id/revoke */
export async function revokeStatementSend(id: string): Promise<StatementSend> {
  const body = await apiFetch<{ success: boolean; send: StatementSend }>(`/statement-sends/${id}/revoke`, {
    method: 'POST',
  });
  return body.send;
}

/** What the public statement link shows — no session involved. */
export interface PublicStatementView {
  merchant: { name: string; addressLines: string[]; hasLogo: boolean; baseCurrency: string };
  partyKind: PartyKind;
  partyName: string;
  statement: PartyStatement;
  current: PartyOpenItems;
  settings: StatementSettings;
  bankDetails: string | null;
  payment: { enabled: boolean; publishableKey: string | null };
  expiresAt: string;
}

/** GET /public/statements/:token — public; the token is the credential. */
export async function getPublicStatement(token: string, signal?: AbortSignal): Promise<PublicStatementView> {
  return apiFetch<{ success: boolean } & PublicStatementView>(
    `/public/statements/${encodeURIComponent(token)}`,
    { signal: signal ?? null, credentials: 'omit' },
    NO_AUTO_REFRESH,
  );
}

/** GET /public/statements/:token/logo as a blob (the API is cross-origin, so no bare <img>). */
export async function getPublicStatementLogo(token: string, signal?: AbortSignal): Promise<Blob | null> {
  if (!API_BASE_URL) return null;
  const response = await fetch(`${API_BASE_URL}${API_PREFIX}/public/statements/${encodeURIComponent(token)}/logo`, {
    credentials: 'omit',
    signal: signal ?? null,
  });
  return response.ok ? response.blob() : null;
}

/* ------------------------------------- statements: online payment (Phase 39c) */

export type OnlinePaymentStatus = 'PENDING' | 'RECORDED' | 'NEEDS_REVIEW' | 'FAILED' | 'CANCELED';

/** Mirrors server/src/types/accounting.ts's OnlinePaymentSettings. */
export interface OnlinePaymentSettings {
  enabled: boolean;
  depositAccountId: string | null;
  providerConfigured: boolean;
}

/** Mirrors server/src/types/accounting.ts's OnlinePayment. */
export interface OnlinePayment {
  id: string;
  customerId: string;
  customerName: string;
  providerIntentId: string | null;
  currencyCode: string;
  amountCents: number;
  status: OnlinePaymentStatus;
  paymentId: string | null;
  failureReason: string | null;
  invoices: { invoiceId: string; invoiceNumber: string | null; amountCents: number }[];
  createdAt: string;
  updatedAt: string;
}

export async function getOnlinePaymentSettings(): Promise<OnlinePaymentSettings> {
  const body = await apiFetch<{ success: boolean; onlinePaymentSettings: OnlinePaymentSettings }>(
    '/settings/online-payments',
  );
  return body.onlinePaymentSettings;
}

export async function updateOnlinePaymentSettings(input: {
  enabled?: boolean;
  depositAccountId?: string | null;
}): Promise<OnlinePaymentSettings> {
  const body = await apiFetch<{ success: boolean; onlinePaymentSettings: OnlinePaymentSettings }>(
    '/settings/online-payments',
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return body.onlinePaymentSettings;
}

/** GET /online-payments?status= */
export async function listOnlinePayments(status?: OnlinePaymentStatus): Promise<OnlinePayment[]> {
  const body = await apiFetch<{ success: boolean; onlinePayments: OnlinePayment[] }>(
    `/online-payments${status === undefined ? '' : `?status=${status}`}`,
  );
  return body.onlinePayments;
}

export interface StartedStatementPayment {
  onlinePaymentId: string;
  clientSecret: string;
  publishableKey: string;
  amountCents: number;
  currencyCode: string;
}

/** POST /public/statements/:token/payments — public; the server computes the amount. */
export async function startStatementPayment(token: string, invoiceIds: string[]): Promise<StartedStatementPayment> {
  const body = await apiFetch<{ success: boolean; payment: StartedStatementPayment }>(
    `/public/statements/${encodeURIComponent(token)}/payments`,
    { method: 'POST', body: JSON.stringify({ invoiceIds }), credentials: 'omit' },
    NO_AUTO_REFRESH,
  );
  return body.payment;
}

/** POST /public/statements/:token/payments/:intentId/confirm — public. */
export function confirmStatementPayment(
  token: string,
  intentId: string,
): Promise<{ success: boolean; status: OnlinePaymentStatus; paymentId: string | null }> {
  return apiFetch(
    `/public/statements/${encodeURIComponent(token)}/payments/${encodeURIComponent(intentId)}/confirm`,
    { method: 'POST', credentials: 'omit' },
    NO_AUTO_REFRESH,
  );
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
  /** Phase 40 — the description as written, before its placeholders were filled; null if it had none. */
  descriptionTemplate: string | null;
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
  /** Phase 42 — the order line this bill line bills, if any. */
  orderLineId: string | null;
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
  /** Phase 40 — the notes as written, before their placeholders were filled; null if they had none. */
  notesTemplate: string | null;
  /** Phase 40 — the vendor reference as written (`RENT-[Month]`); null if it had no placeholders. */
  vendorReferenceTemplate: string | null;
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
  /** Phase 41 — the accepted purchase quote this bill was converted from, if any. */
  sourceQuote: SourceQuoteRef | null;
  /** Phase 42 — POSTED deposit applications against this bill. `0` unless status is POSTED. */
  depositAppliedCents: number;
  /** Phase 42 — STANDARD, or DEPOSIT for a prepayment bill raised on a confirmed purchase order. */
  kind: 'STANDARD' | 'DEPOSIT';
  /** Phase 42 — the purchase order a DEPOSIT bill was raised for; null for STANDARD. */
  depositForOrderId: string | null;
  /** Phase 42 — applications where this document is the deposit or the target. [] in lists. */
  depositApplications: DepositApplication[];
  /** Phase 43b — the purchase order this bill references; null if none. */
  purchaseOrderId: string | null;
  /** Phase 43b — the referenced purchase order's number; null if none. */
  purchaseOrderNumber: string | null;
}

export type BillSortKey = 'billDate' | 'dueDate' | 'reference' | 'vendor' | 'total' | 'status';

export interface BillFilters {
  page?: number;
  limit?: number;
  status?: BillStatus | '';
  vendorId?: string;
  from?: string;
  to?: string;
  q?: string;
  settlement?: SettlementFilter | '';
  /** 2026-09-30 — server-side sort; omitted means the server's newest-first default. */
  sort?: BillSortKey;
  dir?: 'asc' | 'desc';
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
  if (params.sort !== undefined) query.set('sort', params.sort);
  if (params.dir !== undefined) query.set('dir', params.dir);
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
  /** Phase 42 — the order line this bill line bills, if any. */
  orderLineId?: string | null;
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
  /** Phase 43b — vault documents to link to the bill in the same transaction. */
  attachmentDocumentIds?: string[];
  /** Phase 43b — a confirmed or closed purchase order for the same vendor; null clears it. */
  purchaseOrderId?: string | null;
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
  applyCredits?: { kind: 'NOTE' | 'DEPOSIT'; id: string; amountCents: number }[],
): Promise<{ success: boolean; bill: Bill }> {
  return apiFetch(`/bills/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ entryDate, applyCredits }),
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

/* ------------------------------------------------------- accounting: tax summary */

/** Mirrors server/src/types/accounting.ts's TaxSummaryRow. */
export interface TaxSummaryRow {
  rateBp: number;
  netCents: number;
  taxCents: number;
  documentCount: number;
}

/** Mirrors server/src/types/accounting.ts's TaxSummaryDirection. */
export interface TaxSummaryDirection {
  rows: TaxSummaryRow[];
  netCents: number;
  taxCents: number;
}

/** Mirrors server/src/types/accounting.ts's TaxSummaryAccountCheck. */
export interface TaxSummaryAccountCheck {
  account: { id: string; code: string; name: string } | null;
  glCents: number;
  differenceCents: number;
}

/** Mirrors server/src/types/accounting.ts's TaxSummary. */
export interface TaxSummary {
  from: string;
  to: string;
  output: TaxSummaryDirection;
  input: TaxSummaryDirection;
  netTaxPayableCents: number;
  outputCheck: TaxSummaryAccountCheck;
  inputCheck: TaxSummaryAccountCheck;
}

/** GET /reports/tax-summary?from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function getTaxSummary(from: string, to: string, signal?: AbortSignal): Promise<TaxSummary> {
  const params = new URLSearchParams({ from, to });
  const body = await apiFetch<{ success: boolean } & TaxSummary>(
    `/reports/tax-summary?${params.toString()}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

/* ---------------------------------------------------- accounting: Phase 45 cash flow */

/** Mirrors server/src/types/accounting.ts's CashFlowRow. */
export interface CashFlowRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  category: 'OPERATING' | 'INVESTING' | 'FINANCING';
  categorySource: 'OVERRIDE' | 'DERIVED';
  /** Cash effect: credit − debit over the period. */
  amountCents: number;
}

/** Mirrors server/src/types/accounting.ts's CashFlowSection. */
export interface CashFlowSection {
  rows: CashFlowRow[];
  totalCents: number;
}

/** Mirrors server/src/types/accounting.ts's CashFlowCashAccount. */
export interface CashFlowCashAccount {
  accountId: string;
  code: string;
  name: string;
  openingCents: number;
  closingCents: number;
}

/** Mirrors server/src/types/accounting.ts's CashFlowStatement. */
export interface CashFlowStatement {
  from: string;
  to: string;
  netIncomeCents: number;
  /** totalCents = netIncomeCents + Σ rows. */
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChangeCents: number;
  openingCashCents: number;
  closingCashCents: number;
  cashAccounts: CashFlowCashAccount[];
}

/** GET /reports/cash-flow?from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function getCashFlow(
  from: string | null = null,
  to: string | null = null,
  signal?: AbortSignal,
): Promise<CashFlowStatement> {
  const params = new URLSearchParams();
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  const suffix = params.size === 0 ? '' : `?${params.toString()}`;
  const body = await apiFetch<{ success: boolean } & CashFlowStatement>(`/reports/cash-flow${suffix}`, {
    signal: signal ?? null,
  });
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

// ---- Phase 45 — P&L comparison (mirrors server types/accounting.ts)

export type ComparisonMode = 'previousPeriod' | 'samePeriodLastYear';
export interface ComparisonPeriod {
  from: string;
  to: string;
  label: string;
}
export interface Variance {
  cents: number;
  bp: number | null;
}
export interface ComparisonStatementRow {
  accountId: string;
  code: string;
  name: string;
  type: StatementRow['type'];
  amountsCents: number[];
  variance: Variance;
}
export interface ComparisonSection {
  rows: ComparisonStatementRow[];
  totalsCents: number[];
  variance: Variance;
}
export interface ProfitAndLossComparison {
  mode: ComparisonMode;
  periods: ComparisonPeriod[];
  revenue: ComparisonSection;
  costOfSales: ComparisonSection;
  grossProfitCents: number[];
  grossProfitVariance: Variance;
  operatingExpenses: ComparisonSection;
  netIncomeCents: number[];
  netIncomeVariance: Variance;
}

/** GET /reports/profit-and-loss/comparison?from&to&compare&periods */
export async function getProfitAndLossComparison(
  from: string | null,
  to: string | null,
  compare: ComparisonMode,
  periods: number,
  signal?: AbortSignal,
): Promise<ProfitAndLossComparison> {
  const params = new URLSearchParams();
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  params.set('compare', compare);
  params.set('periods', String(periods));
  const body = await apiFetch<{ success: boolean } & ProfitAndLossComparison>(
    `/reports/profit-and-loss/comparison?${params.toString()}`,
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
  /** Phase 46d — only changes made by this user (a member's id). */
  actorUserId?: string;
  /** Phase 46d — only changes to this row (a UUID). */
  rowId?: string;
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
  if (params.actorUserId !== undefined && params.actorUserId !== '') query.set('actorUserId', params.actorUserId);
  if (params.rowId !== undefined && params.rowId !== '') query.set('rowId', params.rowId);
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

export type MigrationImportKind =
  | 'CHART_OF_ACCOUNTS'
  | 'OPENING_BALANCES'
  | 'CUSTOMERS'
  | 'VENDORS'
  | 'ITEMS'
  | 'INVENTORY_ITEMS'
  | 'JOURNALS'
  | 'INVOICES'
  | 'BILLS';
export type ImportDateFormat = 'ISO' | 'DMY' | 'MDY';
export type MigrationImportStatus = 'DRAFT' | 'VALIDATED' | 'COMMITTED';
export type MigrationRowStatus = 'VALID' | 'INVALID' | 'EXCLUDED';

/** One CSV column an import kind understands (Phase 36). */
export interface ImportColumnMeta {
  key: string;
  header: string;
  label: string;
  required: boolean;
  synonyms: string[];
  note: string;
  example: string;
  inTemplate: boolean;
  type: 'text' | 'money' | 'signedMoney' | 'percent' | 'quantity' | 'date' | 'enum';
  maxLength: number | null;
  enumAliases: Record<string, string> | null;
  enumLabels: string[] | null;
}

/** One field the review page lets a user fix on a staged row. */
export interface ImportEditFieldMeta {
  key: string;
  label: string;
  input: 'text' | 'money' | 'accountType' | 'enum';
  maxLength: number | null;
  nullable: boolean;
  options: string[] | null;
}

export interface ImportKindMeta {
  kind: MigrationImportKind;
  label: string;
  noun: string;
  columns: ImportColumnMeta[];
  requiredOneOf: (string[])[];
  missingMessages: Record<string, string>;
  editFields: ImportEditFieldMeta[];
  storage: 'typed' | 'data';
  /** Columns shown in a group's header row; empty = not a grouped kind. */
  groupHeaderFields: string[];
  /** Commit modes the kind offers; empty = none. */
  commitModes: ('DRAFT' | 'POST')[];
  /** True when the import may be staged in conversion mode. */
  supportsConversionMode: boolean;
}

export interface MigrationImportInspection {
  kind: MigrationImportKind;
  headers: string[];
  delimiter: string;
  rowCount: number;
  sampleRows: string[][];
  suggestedMap: Record<string, string | null>;
  missingRequired: string[];
  exactMatch: boolean;
  suggestedDateFormat: ImportDateFormat | null;
}

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
  columnMap: Record<string, string | null> | null;
  result: MigrationCommitResult | null;
  dateFormat: ImportDateFormat;
  conversionMode: boolean;
  commitOptions: { mode: 'DRAFT' | 'POST'; postingDate: string | null } | null;
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
  /** Data-storage kinds: parsed cell values by column key. */
  values: Record<string, string | number | null>;
  groupKey: string | null;
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
  summary: PreviewSummaryItem[];
  warnings: string[];
}

export interface PreviewSummaryItem {
  label: string;
  value: number;
  format: 'count' | 'money';
}

export type MigrationCommitResult =
  | { kind: 'CHART_OF_ACCOUNTS'; createdCount: number; mergedCount: number }
  | { kind: 'OPENING_BALANCES'; journalEntryId: string; plugCents: number }
  | { kind: 'CUSTOMERS' | 'VENDORS'; createdCount: number; mergedCount: number }
  | { kind: 'ITEMS'; createdCount: number; mergedCount: number }
  | { kind: 'INVENTORY_ITEMS'; createdCount: number; openingStockCount: number }
  | { kind: 'JOURNALS'; entryCount: number; lineCount: number }
  | { kind: 'INVOICES' | 'BILLS'; documentCount: number; lineCount: number; mode: 'DRAFT' | 'POST' };

/** POST /migration-imports — OWNER, ADMIN or ACCOUNTANT. */
export function createMigrationImport(body: {
  kind: MigrationImportKind;
  fileName: string;
  content: string;
  columnMap?: Record<string, string | null> | null;
  dateFormat?: ImportDateFormat;
  conversionMode?: boolean;
}): Promise<{ success: boolean; import: MigrationImport; rows: MigrationImportRow[] }> {
  return apiFetch('/migration-imports', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /migration-imports */
export function listMigrationImports(
  params: { page?: number; limit?: number; kind?: MigrationImportKind; status?: MigrationImportStatus } = {},
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
  if (params.status !== undefined) query.set('status', params.status);
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
  // Typed kinds: flat ImportEditFieldMeta keys. Data kinds: { values: { key: text | null } }.
  body: Record<string, string | number | null | Record<string, string | null>>,
): Promise<{ success: boolean; import: MigrationImport; row: MigrationImportRow }> {
  return apiFetch(`/migration-imports/${id}/rows/${rowId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** POST /migration-imports/:id/rows/status — OWNER, ADMIN or ACCOUNTANT. */
export function setMigrationImportRowsStatus(
  id: string,
  body: { rowIds: string[]; status: 'VALID' | 'EXCLUDED' },
): Promise<{ success: boolean; import: MigrationImport }> {
  return apiFetch(`/migration-imports/${id}/rows/status`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /migration-imports/:id/validate — OWNER, ADMIN or ACCOUNTANT. */
export function validateMigrationImport(id: string): Promise<{ success: boolean; import: MigrationImport }> {
  return apiFetch(`/migration-imports/${id}/validate`, { method: 'POST', body: JSON.stringify({}) });
}

/** GET /migration-imports/:id/preview — OWNER, ADMIN or ACCOUNTANT. */
export function previewMigrationImport(
  id: string,
  signal?: AbortSignal,
  params: { mode?: 'DRAFT' | 'POST'; postingDate?: string } = {},
): Promise<{ success: boolean; preview: MigrationCommitPreview }> {
  const query = new URLSearchParams();
  if (params.mode !== undefined) query.set('mode', params.mode);
  if (params.postingDate !== undefined && params.postingDate !== '') query.set('postingDate', params.postingDate);
  const qs = query.toString();
  return apiFetch(`/migration-imports/${id}/preview${qs === '' ? '' : `?${qs}`}`, { signal: signal ?? null });
}

/** POST /migration-imports/:id/commit — OWNER/ADMIN only; irreversible. */
export function commitMigrationImport(
  id: string,
  body: { mode?: 'DRAFT' | 'POST'; postingDate?: string | null } = {},
): Promise<{ success: boolean; import: MigrationImport; result: MigrationCommitResult }> {
  return apiFetch(`/migration-imports/${id}/commit`, { method: 'POST', body: JSON.stringify(body) });
}

/** DELETE /migration-imports/:id — refused once COMMITTED. */
export async function deleteMigrationImport(id: string): Promise<void> {
  await apiFetch(`/migration-imports/${id}`, { method: 'DELETE' });
}

/** GET /migration-imports/kinds */
export function getMigrationImportKinds(signal?: AbortSignal): Promise<{ success: boolean; kinds: ImportKindMeta[] }> {
  return apiFetch('/migration-imports/kinds', { signal: signal ?? null });
}

/** POST /migration-imports/inspect — OWNER, ADMIN or ACCOUNTANT. Persists nothing. */
export function inspectMigrationImport(
  body: { kind: MigrationImportKind; content: string },
): Promise<{ success: boolean; inspection: MigrationImportInspection }> {
  return apiFetch('/migration-imports/inspect', { method: 'POST', body: JSON.stringify(body) });
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
  /** Phase 43b — case-insensitive filename search. */
  q?: string;
  /** Phase 43b — only documents with no links (sent as `unattached=true` only when true). */
  unattached?: boolean;
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
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.unattached === true) query.set('unattached', 'true');
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

// ---------------------------------------------------------- report export (Phase 45)

export type ReportFormat = 'csv' | 'xlsx' | 'pdf';

/**
 * path like '/reports/trial-balance'; params with null values are omitted; adds format.
 * The filename comes from the server's Content-Disposition; the fallback is the last path segment.
 */
export async function downloadReport(
  path: string,
  params: Record<string, string | null>,
  format: ReportFormat,
): Promise<void> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) search.set(key, value);
  }
  search.set('format', format);
  const { blob, filename } = await apiDownloadBlob(`${path}?${search.toString()}`);
  saveBlob(blob, filename !== 'download' ? filename : `${path.split('/').pop() ?? 'report'}.${format}`);
}

// ---------------------------------------------------------- account transactions (Phase 45)

/** Mirrors server/src/types/accounting.ts's AccountTransactionGrouping. */
export type AccountTransactionGrouping = 'account' | 'month' | 'sourceType' | 'contact' | 'none';
export type AccountTransactionMode = 'detail' | 'summary';

export interface AccountTransactionLine {
  lineId: string;
  entryId: string;
  entryDate: string;
  sourceType: string;
  sourceId: string | null;
  sourceLabel: string;
  reference: string | null;
  contactType: 'CUSTOMER' | 'VENDOR' | null;
  contactId: string | null;
  contactName: string | null;
  description: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  netCents: number;
  runningBalanceCents: number | null;
  currencyCode: string;
  nativeDebitCents: number;
  nativeCreditCents: number;
  /** Exact NUMERIC text, never a float. */
  fxRate: string;
  createdByName: string | null;
}

export interface AccountTransactionGroup {
  key: string;
  label: string;
  openingBalanceCents: number | null;
  debitCents: number;
  creditCents: number;
  netCents: number;
  closingBalanceCents: number | null;
  lineCount: number;
  lines: AccountTransactionLine[];
}

export interface AccountTransactionsReport {
  accountIds: string[] | null;
  from: string;
  to: string;
  sourceTypes: string[] | null;
  groupBy: AccountTransactionGrouping;
  mode: AccountTransactionMode;
  groups: AccountTransactionGroup[];
  totalDebitCents: number;
  totalCreditCents: number;
  lineCount: number;
}

export interface AccountTransactionsParams {
  accountIds: string[];
  from: string;
  to: string;
  groupBy: AccountTransactionGrouping;
  mode: AccountTransactionMode;
  sourceTypes: string[];
}

/** GET /reports/account-transactions — empty accountIds / sourceTypes arrays are omitted; arrays join with ','. */
export async function getAccountTransactions(
  params: AccountTransactionsParams,
  signal?: AbortSignal,
): Promise<AccountTransactionsReport> {
  const search = new URLSearchParams();
  if (params.accountIds.length > 0) search.set('accountIds', params.accountIds.join(','));
  search.set('from', params.from);
  search.set('to', params.to);
  search.set('groupBy', params.groupBy);
  search.set('mode', params.mode);
  if (params.sourceTypes.length > 0) search.set('sourceTypes', params.sourceTypes.join(','));
  const body = await apiFetch<{ success: boolean } & AccountTransactionsReport>(
    `/reports/account-transactions?${search.toString()}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

// ------------------------------------------------ GL exceptions (Phase 45)

/** Mirrors server GL_EXCEPTION_RULES. */
export type GlExceptionRule = 'UNUSUAL_AMOUNT' | 'UNEXPECTED_SIDE' | 'NON_DEFAULT_TAX' | 'POSSIBLE_DUPLICATE';
export const GL_EXCEPTION_RULES: readonly GlExceptionRule[] = [
  'UNUSUAL_AMOUNT',
  'UNEXPECTED_SIDE',
  'NON_DEFAULT_TAX',
  'POSSIBLE_DUPLICATE',
];
export const GL_EXCEPTION_RULE_LABELS: Readonly<Record<GlExceptionRule, string>> = {
  UNUSUAL_AMOUNT: 'Unusual amount',
  UNEXPECTED_SIDE: 'Unexpected debit or credit',
  NON_DEFAULT_TAX: 'Non-default tax rate',
  POSSIBLE_DUPLICATE: 'Possible duplicate',
};
export type GlExceptionSubjectType = 'LEDGER_LINE' | 'JOURNAL_ENTRY' | 'INVOICE_LINE' | 'BILL_LINE';

export interface GlExceptionReview {
  id: string;
  note: string;
  reviewedAt: string;
  reviewedByName: string;
}

export interface GlException {
  rule: GlExceptionRule;
  subjectType: GlExceptionSubjectType;
  subjectId: string;
  entryDate: string;
  journalEntryId: string | null;
  documentType: 'INVOICE' | 'BILL' | null;
  documentId: string | null;
  documentNumber: string | null;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  amountCents: number;
  currencyCode: string;
  expected: string;
  actual: string;
  reason: string;
  review: GlExceptionReview | null;
}

export interface GlExceptionReport {
  from: string;
  to: string;
  rules: GlExceptionRule[];
  includeReviewed: boolean;
  counts: Record<GlExceptionRule, { open: number; reviewed: number }>;
  exceptions: GlException[];
  truncated: boolean;
}

/** GET /reports/exceptions */
export async function getGlExceptions(
  params: { from: string; to: string; rules: GlExceptionRule[]; includeReviewed: boolean },
  signal?: AbortSignal,
): Promise<GlExceptionReport> {
  const search = new URLSearchParams();
  search.set('from', params.from);
  search.set('to', params.to);
  search.set('rules', params.rules.join(','));
  search.set('includeReviewed', String(params.includeReviewed));
  const body = await apiFetch<{ success: boolean } & GlExceptionReport>(
    `/reports/exceptions?${search.toString()}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

/** POST /reports/exceptions/reviews */
export async function createGlExceptionReview(input: {
  rule: GlExceptionRule;
  subjectType: GlExceptionSubjectType;
  subjectId: string;
  note: string;
}): Promise<GlExceptionReview> {
  const body = await apiFetch<{ success: boolean; review: GlExceptionReview }>('/reports/exceptions/reviews', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.review;
}

/** DELETE /reports/exceptions/reviews/:id — reopens the flag. */
export async function deleteGlExceptionReview(id: string): Promise<void> {
  await apiFetch(`/reports/exceptions/reviews/${id}`, { method: 'DELETE' });
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
  'RECLASS_OUT', // Phase 35a: value-only pair (qty 0) moving an item's value between GL accounts.
  'RECLASS_IN',
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
  linkedValueCents: number;
  unlinkedValueCents: number;
  unlinkedItemCount: number;
}
/** Phase 35a — GET /inventory/valuation. Differences are GL minus stock subledger, base cents. */
export interface InventoryValuationLine {
  journalEntryId: string;
  entryDate: string;
  description: string | null;
  sourceType: string;
  netDebitCents: number;
}
export interface InventoryValuationAccount {
  accountId: string;
  code: string;
  name: string;
  subledgerCents: number;
  glCents: number;
  differenceCents: number;
  unexplainedLines: InventoryValuationLine[];
}
export interface InventoryMisplacedValue {
  stockItemId: string;
  itemCode: string;
  itemName: string;
  accountId: string;
  currentAccountId: string;
  valueCents: number;
}
export interface InventoryValuation {
  asOf: string | null;
  accounts: InventoryValuationAccount[];
  totalSubledgerCents: number;
  totalGlCents: number;
  totalDifferenceCents: number;
  misplaced: InventoryMisplacedValue[];
  unlinkedItemCount: number;
  unlinkedValueCents: number;
  tiesOut: boolean;
}
export interface InventoryTrueUp {
  id: string;
  accountId: string;
  glBeforeCents: number;
  subledgerCents: number;
  differenceCents: number;
  journalEntryId: string;
  occurredOn: string;
}
export interface LinkAllResult {
  linkedCount: number;
  failures: { stockItemId: string; code: string; message: string }[];
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

/**
 * Opening stock posted with a new tracked product (Dr Inventory / Cr Opening
 * stock). Omitted unit cost = the product's purchase price; omitted location =
 * the default location.
 */
export interface OpeningStockInput {
  quantityMilli: number;
  unitCostCents?: number | null;
  occurredOn: string;
  locationId?: string | null;
}

/**
 * POST /inventory/items. Everything but `name` is optional: with no category
 * or code, the server uses the default category and code scheme, and it sets
 * inventory up silently the first time.
 */
export function createStockItem(input: {
  name: string;
  description?: string | null;
  categoryId?: string | null;
  uomId?: string | null;
  tracking?: StockTrackingMode | null;
  code?: string | null;
  codeSchemeId?: string | null;
  barcode?: string | null;
  attributes?: Record<string, unknown>;
  reorderPointMilli?: number | null;
  /** Phase 32 — prices/accounts of the linked product; omitted = defaults. */
  product?: StockItemProductInput;
  opening?: OpeningStockInput;
}): Promise<{ success: boolean; item: StockItem }> {
  return apiFetch('/inventory/items', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /inventory/items/from-product/:productId — start tracking a non-inventory product (forward-only). */
export function createStockItemFromProduct(
  productId: string,
  input: {
    categoryId?: string | null;
    assetAccountId?: string | null;
    cogsAccountId?: string | null;
    opening?: OpeningStockInput;
  } = {},
): Promise<{ success: boolean; item: StockItem }> {
  return apiFetch(`/inventory/items/from-product/${productId}`, { method: 'POST', body: JSON.stringify(input) });
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
  purpose?: 'OPENING' | 'ADJUSTMENT';
}): Promise<{ success: boolean } & StockMovementResult> {
  return apiFetch('/inventory/receipts', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /inventory/issues */
export function postStockIssue(input: {
  occurredOn: string;
  reference: string | null;
  locationId: string;
  lines: StockOutboundLineInput[];
  expenseAccountId?: string | null;
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

export function fetchInventoryValuation(asOf?: string, signal?: AbortSignal): Promise<{ success: boolean; valuation: InventoryValuation }> {
  const query = new URLSearchParams();
  if (asOf !== undefined) query.set('asOf', asOf);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/inventory/valuation${suffix}`, { signal: signal ?? null });
}

export function postInventoryTrueUp(input: { accountId: string; expectedDifferenceCents: number }): Promise<{ success: boolean; trueUp: InventoryTrueUp }> {
  return apiFetch('/inventory/reconcile/true-up', { method: 'POST', body: JSON.stringify(input) });
}

export function postInventoryReclass(): Promise<{ success: boolean; postingCount: number }> {
  return apiFetch('/inventory/reconcile/reclass', { method: 'POST', body: JSON.stringify({}) });
}

export function postLinkAllStockItems(): Promise<{ success: boolean; result: LinkAllResult }> {
  return apiFetch('/inventory/items/link-all', { method: 'POST', body: JSON.stringify({}) });
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

/* ------------------------------------------------------- quotes (Phase 41) */

export type QuoteDirection = 'SALES' | 'PURCHASE';

export const QUOTE_STATUSES = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'VOID',
  'SUPERSEDED',
  'CONVERTED',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface SourceQuoteRef {
  id: string;
  quoteNumber: string;
  revision: number;
}

export interface QuoteLine {
  id: string;
  lineNumber: number;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  taxRateBp: number;
  netCents: number;
  taxCents: number;
  itemId: string | null;
}

export interface QuoteResponse {
  response: 'ACCEPTED' | 'DECLINED';
  channel: 'PUBLIC_LINK' | 'INTERNAL';
  signerName: string | null;
  signerEmail: string | null;
  signerEmailVerified: boolean;
  termsAccepted: boolean;
  declineReason: string | null;
  clientIp: string | null;
  userAgent: string | null;
  recordedBy: string | null;
  recordedByName: string | null;
  note: string | null;
  quoteContentSha256: string;
  respondedAt: string;
}

export interface QuoteLinkSummary {
  id: string;
  toEmail: string;
  sentBy: string;
  sentByName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  live: boolean;
}

export interface QuoteSummary {
  id: string;
  direction: QuoteDirection;
  quoteNumber: string | null;
  revision: number;
  status: QuoteStatus;
  /** A SENT quote past its validity reads EXPIRED before the sweep persists it. */
  effectiveStatus: QuoteStatus;
  partyId: string;
  partyName: string;
  quoteDate: string;
  validUntil: string;
  currencyCode: string;
  title: string | null;
  totalCents: number;
  createdAt: string;
}

export interface Quote extends QuoteSummary {
  rootQuoteId: string;
  supersedesQuoteId: string | null;
  partyNameSnapshot: string;
  partyAddressSnapshot: string | null;
  partyTaxNumberSnapshot: string | null;
  partyEmailSnapshot: string | null;
  partyReference: string | null;
  notes: string | null;
  terms: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  subtotalCents: number;
  taxCents: number;
  /** Indicative only — never frozen; the invoice/bill uses the rate of its own date. */
  indicativeFxRate: string | null;
  indicativeBaseTotalCents: number | null;
  contentSha256: string | null;
  sentAt: string | null;
  sentBy: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  supersededAt: string | null;
  convertedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  updatedAt: string;
  lines: QuoteLine[];
  revisions: { id: string; revision: number; status: QuoteStatus }[];
  links: QuoteLinkSummary[];
  response: QuoteResponse | null;
  convertedDocument: { kind: 'INVOICE' | 'BILL' | 'ORDER'; id: string; number: string | null; status: string } | null;
  /** Phase 42 — the deposit requested on acceptance, as basis points (1–10000); null when none. */
  depositPercentBp: number | null;
}

export interface QuoteInput {
  partyId: string;
  quoteDate: string;
  validUntil?: string;
  currencyCode?: string;
  partyReference: string | null;
  title: string | null;
  notes: string | null;
  terms?: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  /** Phase 42 — basis points 1–10000; null or omitted = no deposit. */
  depositPercentBp?: number | null;
  lines: {
    description: string;
    quantityMilli: number;
    unitPriceCents: number;
    accountId: string;
    taxRateBp: number;
    itemId: string | null;
  }[];
}

export type QuoteSortKey = 'quoteDate' | 'validUntil' | 'number' | 'party' | 'total' | 'status';

export interface QuoteFilters {
  page?: number;
  limit?: number;
  status?: QuoteStatus | '';
  partyId?: string;
  q?: string;
  sort?: QuoteSortKey;
  dir?: 'asc' | 'desc';
}

/** `/quotes` for sales, `/purchase-quotes` for purchase — the same resource in two directions. */
function quoteBase(direction: QuoteDirection): string {
  return direction === 'SALES' ? '/quotes' : '/purchase-quotes';
}

/** GET /quotes|purchase-quotes/:id/pdf as a blob (Phase 42, Slice E). */
export async function downloadQuotePdf(direction: QuoteDirection, id: string): Promise<Blob> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not set — copy client/.env.example to client/.env');
  }
  const response = await fetch(`${API_BASE_URL}${API_PREFIX}${quoteBase(direction)}/${id}/pdf`, {
    credentials: 'include',
  });
  if (!response.ok) throw new ApiRequestError(response.status, 'Could not download the PDF');
  return response.blob();
}

/** GET /quotes | /purchase-quotes */
export function listQuotes(
  direction: QuoteDirection,
  params: QuoteFilters = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; totalCount: number; currentPage: number; totalPages: number; quotes: QuoteSummary[] }> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.partyId !== undefined && params.partyId !== '') query.set('partyId', params.partyId);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.sort !== undefined) query.set('sort', params.sort);
  if (params.dir !== undefined) query.set('dir', params.dir);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`${quoteBase(direction)}${suffix}`, { signal: signal ?? null });
}

export function getQuote(direction: QuoteDirection, id: string, signal?: AbortSignal): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}`, { signal: signal ?? null });
}

export function createQuote(direction: QuoteDirection, body: QuoteInput): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(quoteBase(direction), { method: 'POST', body: JSON.stringify(body) });
}

export function updateQuote(direction: QuoteDirection, id: string, body: QuoteInput): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteQuote(direction: QuoteDirection, id: string): Promise<void> {
  await apiFetch(`${quoteBase(direction)}/${id}`, { method: 'DELETE' });
}

export function sendQuote(
  direction: QuoteDirection,
  id: string,
  body: { delivery: 'EMAIL' | 'MANUAL'; toEmail: string | null; message: string | null; templateId: string | null },
): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}/send`, { method: 'POST', body: JSON.stringify(body) });
}

/* ------------------------------------- quote email templates (Phase 42, Slice C) */

/** Mirrors server/src/types/accounting.ts's QuoteEmailTemplate. */
export interface QuoteEmailTemplate {
  id: string | null;
  direction: QuoteDirection;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
  builtIn: boolean;
  updatedAt: string | null;
}

/** GET /settings/quote-email-templates?direction= — the built-in template is included when none is saved. */
export async function listQuoteEmailTemplates(direction: QuoteDirection): Promise<QuoteEmailTemplate[]> {
  const body = await apiFetch<{ success: boolean; templates: QuoteEmailTemplate[] }>(
    `/settings/quote-email-templates?direction=${direction}`,
  );
  return body.templates;
}

export async function createQuoteEmailTemplate(input: {
  direction: QuoteDirection;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
}): Promise<QuoteEmailTemplate> {
  const body = await apiFetch<{ success: boolean; template: QuoteEmailTemplate }>('/settings/quote-email-templates', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.template;
}

export async function updateQuoteEmailTemplate(
  id: string,
  input: Partial<{ name: string; subject: string; body: string; isDefault: boolean }>,
): Promise<QuoteEmailTemplate> {
  const body = await apiFetch<{ success: boolean; template: QuoteEmailTemplate }>(
    `/settings/quote-email-templates/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return body.template;
}

export async function deleteQuoteEmailTemplate(id: string): Promise<void> {
  await apiFetch(`/settings/quote-email-templates/${id}`, { method: 'DELETE' });
}

/** POST /quotes|purchase-quotes/:id/email-preview — fills the template without sending. */
export async function previewQuoteEmail(
  direction: QuoteDirection,
  id: string,
  templateId: string | null,
): Promise<{ success: boolean; subject: string; body: string }> {
  return apiFetch(`${quoteBase(direction)}/${id}/email-preview`, {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  });
}

export function reviseQuote(direction: QuoteDirection, id: string): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}/revise`, { method: 'POST', body: '{}' });
}

export function recordQuoteAcceptance(
  direction: QuoteDirection,
  id: string,
  body: { signerName: string; note: string | null },
): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}/accept`, { method: 'POST', body: JSON.stringify(body) });
}

export function recordQuoteDecline(
  direction: QuoteDirection,
  id: string,
  body: { reason: string | null; note: string | null },
): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}/decline`, { method: 'POST', body: JSON.stringify(body) });
}

export function voidQuote(direction: QuoteDirection, id: string, reason: string): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function revokeQuoteLink(direction: QuoteDirection, id: string, linkId: string): Promise<{ success: boolean; quote: Quote }> {
  return apiFetch(`${quoteBase(direction)}/${id}/links/${linkId}/revoke`, { method: 'POST', body: '{}' });
}

export function convertQuote(
  direction: QuoteDirection,
  id: string,
  body: { documentDate: string | null; dueDate: string | null; vendorReference: string | null; target?: 'INVOICE' | 'ORDER' },
): Promise<{ success: boolean; document: { kind: 'INVOICE' | 'BILL' | 'ORDER'; id: string } }> {
  return apiFetch(`${quoteBase(direction)}/${id}/convert`, { method: 'POST', body: JSON.stringify(body) });
}

/* ----------------------------------------------- quotes: public link (no session) */

export interface PublicQuoteView {
  merchant: { name: string; addressLines: string[]; hasLogo: boolean };
  direction: QuoteDirection;
  quoteNumber: string;
  revision: number;
  effectiveStatus: QuoteStatus;
  canRespond: boolean;
  requiresEmailCode: boolean;
  partyName: string;
  partyAddress: string | null;
  partyTaxNumber: string | null;
  partyReference: string | null;
  quoteDate: string;
  validUntil: string;
  currencyCode: string;
  title: string | null;
  notes: string | null;
  terms: string | null;
  paymentTerms: string | null;
  lines: {
    lineNumber: number;
    description: string;
    quantityMilli: number;
    unitPriceCents: number;
    taxRateBp: number;
    netCents: number;
    taxCents: number;
  }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  contentSha256: string;
  response: { response: 'ACCEPTED' | 'DECLINED'; signerName: string | null; respondedAt: string } | null;
  /** Phase 42 — the deposit requested on acceptance, in basis points; null when none. */
  depositPercentBp: number | null;
}

/** GET /public/quotes/:token — no cookies: the token is the credential. */
export function getPublicQuote(token: string, signal?: AbortSignal): Promise<{ success: boolean; quote: PublicQuoteView }> {
  return apiFetch(`/public/quotes/${encodeURIComponent(token)}`, { signal: signal ?? null, credentials: 'omit' }, NO_AUTO_REFRESH);
}

/** GET /public/quotes/:token/logo as a blob (the API is cross-origin, so no bare <img>). */
export async function getPublicQuoteLogo(token: string, signal?: AbortSignal): Promise<Blob | null> {
  if (!API_BASE_URL) return null;
  const response = await fetch(`${API_BASE_URL}${API_PREFIX}/public/quotes/${encodeURIComponent(token)}/logo`, {
    credentials: 'omit',
    signal: signal ?? null,
  });
  return response.ok ? response.blob() : null;
}

/** GET /public/quotes/:token/pdf as a blob — no cookies: the token is the credential (Phase 42, Slice E). */
export async function downloadPublicQuotePdf(token: string): Promise<Blob> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not set — copy client/.env.example to client/.env');
  }
  const response = await fetch(`${API_BASE_URL}${API_PREFIX}/public/quotes/${encodeURIComponent(token)}/pdf`, {
    credentials: 'omit',
  });
  if (!response.ok) throw new ApiRequestError(response.status, 'Could not download the PDF');
  return response.blob();
}

export function acceptPublicQuote(
  token: string,
  body: { signerName: string; signerEmail: string | null; acceptTerms: true; contentSha256: string; code: string | null },
): Promise<{ success: boolean; quote: PublicQuoteView }> {
  return apiFetch(
    `/public/quotes/${encodeURIComponent(token)}/accept`,
    { method: 'POST', body: JSON.stringify(body), credentials: 'omit' },
    NO_AUTO_REFRESH,
  );
}

/** POST /public/quotes/:token/verify-email — emails a 6-digit code to the signer's address (Phase 42, Slice D). */
export function requestPublicQuoteCode(
  token: string,
  signerEmail: string,
): Promise<{ success: boolean; expiresAt: string }> {
  return apiFetch(
    `/public/quotes/${encodeURIComponent(token)}/verify-email`,
    { method: 'POST', body: JSON.stringify({ signerEmail }), credentials: 'omit' },
    NO_AUTO_REFRESH,
  );
}

export function declinePublicQuote(token: string, reason: string | null): Promise<{ success: boolean; quote: PublicQuoteView }> {
  return apiFetch(
    `/public/quotes/${encodeURIComponent(token)}/decline`,
    { method: 'POST', body: JSON.stringify({ reason }), credentials: 'omit' },
    NO_AUTO_REFRESH,
  );
}

/* ------------------------------------------------------- orders (Phase 42) */

export const ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderBillingStatus = 'NOT_BILLED' | 'PARTIALLY_BILLED' | 'FULLY_BILLED';

export interface OrderLine {
  id: string;
  lineNumber: number;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  taxRateBp: number;
  netCents: number;
  taxCents: number;
  itemId: string | null;
  billedQuantityMilli: number;
  remainingQuantityMilli: number;
}

export interface OrderSummary {
  id: string;
  direction: QuoteDirection;
  orderNumber: string | null;
  status: OrderStatus;
  billingStatus: OrderBillingStatus;
  partyId: string;
  partyName: string;
  orderDate: string;
  expectedDate: string | null;
  currencyCode: string;
  totalCents: number;
  createdAt: string;
}

export interface Order extends OrderSummary {
  partyNameSnapshot: string;
  partyAddressSnapshot: string | null;
  partyTaxNumberSnapshot: string | null;
  partyReference: string | null;
  notes: string | null;
  terms: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  subtotalCents: number;
  taxCents: number;
  sourceQuote: SourceQuoteRef | null;
  confirmedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string;
  createdByName: string | null;
  updatedAt: string;
  lines: OrderLine[];
  documents: { kind: 'INVOICE' | 'BILL'; id: string; number: string | null; status: string; totalCents: number }[];
}

export interface OrderInput {
  partyId: string;
  orderDate: string;
  expectedDate: string | null;
  currencyCode?: string;
  partyReference: string | null;
  notes: string | null;
  terms: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  lines: {
    description: string;
    quantityMilli: number;
    unitPriceCents: number;
    accountId: string;
    taxRateBp: number;
    itemId: string | null;
  }[];
}

export type OrderSortKey = 'orderDate' | 'number' | 'party' | 'total' | 'status';

export interface OrderFilters {
  page?: number;
  limit?: number;
  status?: OrderStatus | '';
  partyId?: string;
  from?: string;
  to?: string;
  q?: string;
  sort?: OrderSortKey;
  dir?: 'asc' | 'desc';
}

export interface OrderConvertBody {
  documentDate: string | null;
  dueDate: string | null;
  vendorReference: string | null;
  /** Omitted/null = everything still unbilled. */
  lines?: { orderLineId: string; quantityMilli: number }[] | null;
}

/** `/orders` for sales, `/purchase-orders` for purchase — the same resource in two directions. */
function orderBase(direction: QuoteDirection): string {
  return direction === 'SALES' ? '/orders' : '/purchase-orders';
}

/** GET /orders | /purchase-orders */
export function listOrders(
  direction: QuoteDirection,
  params: OrderFilters = {},
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; totalCount: number; currentPage: number; totalPages: number; orders: OrderSummary[] }> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.partyId !== undefined && params.partyId !== '') query.set('partyId', params.partyId);
  if (params.from !== undefined && params.from !== '') query.set('from', params.from);
  if (params.to !== undefined && params.to !== '') query.set('to', params.to);
  if (params.q !== undefined && params.q !== '') query.set('q', params.q);
  if (params.sort !== undefined) query.set('sort', params.sort);
  if (params.dir !== undefined) query.set('dir', params.dir);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`${orderBase(direction)}${suffix}`, { signal: signal ?? null });
}

export function getOrder(direction: QuoteDirection, id: string, signal?: AbortSignal): Promise<{ success: boolean; order: Order }> {
  return apiFetch(`${orderBase(direction)}/${id}`, { signal: signal ?? null });
}

export function createOrder(direction: QuoteDirection, body: OrderInput): Promise<{ success: boolean; order: Order }> {
  return apiFetch(orderBase(direction), { method: 'POST', body: JSON.stringify(body) });
}

export function updateOrder(direction: QuoteDirection, id: string, body: OrderInput): Promise<{ success: boolean; order: Order }> {
  return apiFetch(`${orderBase(direction)}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteOrder(direction: QuoteDirection, id: string): Promise<void> {
  await apiFetch(`${orderBase(direction)}/${id}`, { method: 'DELETE' });
}

export function confirmOrder(direction: QuoteDirection, id: string): Promise<{ success: boolean; order: Order }> {
  return apiFetch(`${orderBase(direction)}/${id}/confirm`, { method: 'POST', body: '{}' });
}

export function closeOrder(direction: QuoteDirection, id: string): Promise<{ success: boolean; order: Order }> {
  return apiFetch(`${orderBase(direction)}/${id}/close`, { method: 'POST', body: '{}' });
}

export function reopenOrder(direction: QuoteDirection, id: string): Promise<{ success: boolean; order: Order }> {
  return apiFetch(`${orderBase(direction)}/${id}/reopen`, { method: 'POST', body: '{}' });
}

export function cancelOrder(direction: QuoteDirection, id: string, reason: string): Promise<{ success: boolean; order: Order }> {
  return apiFetch(`${orderBase(direction)}/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function convertOrder(
  direction: QuoteDirection,
  id: string,
  body: OrderConvertBody,
): Promise<{ success: boolean; document: { kind: 'INVOICE' | 'BILL'; id: string } }> {
  return apiFetch(`${orderBase(direction)}/${id}/convert`, { method: 'POST', body: JSON.stringify(body) });
}

// ------------------------------------------------------------ Phase 42 deposits

/** Body of `POST /orders/:id/deposit` and `/purchase-orders/:id/deposit`: exactly one of percentBp or amountCents. */
export interface DepositInput {
  percentBp?: number | null;
  amountCents?: number | null;
  documentDate?: string | null;
  dueDate?: string | null;
  vendorReference?: string | null;
}

/** Body of `POST /invoices/:id/apply-deposit` and `/bills/:id/apply-prepayment`. */
export interface ApplyDepositInput {
  depositDocumentId: string;
  amountCents: number;
  applicationDate: string;
}

/** POST /orders|/purchase-orders/:id/deposit — a DRAFT deposit invoice (or prepayment bill). */
export function createOrderDeposit(
  direction: QuoteDirection,
  orderId: string,
  body: DepositInput,
): Promise<{ success: boolean; document: { kind: 'INVOICE' | 'BILL'; id: string } }> {
  return apiFetch(`${orderBase(direction)}/${orderId}/deposit`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /invoices/:id/apply-deposit */
export function applyDeposit(
  invoiceId: string,
  body: ApplyDepositInput,
): Promise<{ success: boolean; application: DepositApplication }> {
  return apiFetch(`/invoices/${invoiceId}/apply-deposit`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /bills/:id/apply-prepayment */
export function applyPrepayment(
  billId: string,
  body: ApplyDepositInput,
): Promise<{ success: boolean; application: DepositApplication }> {
  return apiFetch(`/bills/${billId}/apply-prepayment`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /deposit-applications/sales|purchase/:id/void — entryDate null = the server's default date. */
export function voidDepositApplication(
  direction: QuoteDirection,
  id: string,
): Promise<{ success: boolean; application: DepositApplication }> {
  const side = direction === 'SALES' ? 'sales' : 'purchase';
  return apiFetch(`/deposit-applications/${side}/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ entryDate: null }),
  });
}

/** Phase 43d — an organization's email-in address for the bill inbox (`address` is `<token>@<domain>`). */
export interface InboundMailAddress {
  address: string;
  rotatedAt: string | null;
}

/** One row of the email-in message log (`inbound_messages`). */
export interface InboundMailMessage {
  id: string;
  fromAddress: string;
  subject: string | null;
  receivedAt: string;
  status: 'RECEIVED' | 'IMPORTED' | 'PARTIAL' | 'REJECTED' | 'FAILED';
  attachmentCount: number;
  importedCount: number;
  error: string | null;
}

export interface InboundMailMessagesPage {
  success: boolean;
  messages: InboundMailMessage[];
  totalCount: number;
  currentPage: number;
  totalPages: number;
}

/** GET /integrations/inbound-mail — 404 when INBOUND_MAIL is off. */
export function getInboundMailAddress(): Promise<{ success: boolean } & InboundMailAddress> {
  return apiFetch('/integrations/inbound-mail');
}

/** POST /integrations/inbound-mail/rotate — the previous address stops working. */
export function rotateInboundMailAddress(): Promise<{ success: boolean } & InboundMailAddress> {
  return apiFetch('/integrations/inbound-mail/rotate', { method: 'POST' });
}

/** GET /integrations/inbound-mail/messages?page= */
export function listInboundMessages(params: { page: number }): Promise<InboundMailMessagesPage> {
  return apiFetch(`/integrations/inbound-mail/messages?page=${params.page}`);
}

// ---- Phase 45 — sales and purchases by customer, vendor and item (mirrors server types/accounting.ts)

export type SalesPurchasesReportKind =
  | 'sales-by-customer'
  | 'purchases-by-vendor'
  | 'sales-by-item'
  | 'purchases-by-item';

export interface SalesPurchasesRow {
  key: string;
  label: string;
  code: string | null;
  quantityMilli: number | null;
  netCents: number;
  taxCents: number;
  grossCents: number;
  documentCount: number;
  comparisonNetCents: number | null;
}

export interface SalesPurchasesReport {
  kind: SalesPurchasesReportKind;
  from: string;
  to: string;
  comparison: ComparisonPeriod | null;
  rows: SalesPurchasesRow[];
  totalNetCents: number;
  totalTaxCents: number;
  totalGrossCents: number;
  totalComparisonNetCents: number | null;
}

/** GET /reports/{kind}?from&to[&compare] */
export async function getSalesPurchasesReport(
  kind: SalesPurchasesReportKind,
  from: string,
  to: string,
  compare: ComparisonMode | null,
  signal?: AbortSignal,
): Promise<SalesPurchasesReport> {
  const params = new URLSearchParams({ from, to });
  if (compare !== null) params.set('compare', compare);
  const body = await apiFetch<{ success: boolean } & SalesPurchasesReport>(
    `/reports/${kind}?${params.toString()}`,
    { signal: signal ?? null },
  );
  const { success, ...report } = body;
  return report;
}

/** Phase 46c — one row of a document's History & notes timeline. */
export interface HistoryEntry {
  id: string;
  kind: 'EVENT' | 'NOTE';
  action: string;
  summary: string;
  details: Record<string, unknown> | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
}

export function listHistory(
  basePath: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; history: HistoryEntry[] }> {
  return apiFetch(`${basePath}/${id}/history`, { signal: signal ?? null });
}

export function addHistoryNote(
  basePath: string,
  id: string,
  text: string,
): Promise<{ success: boolean; entry: HistoryEntry }> {
  return apiFetch(`${basePath}/${id}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
}
