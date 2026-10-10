import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { env } from '../../config/env.js';
import { STATEMENT_LINK_TTL_MS } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { randomUrlToken, sha256Hex } from '../../utils/pkce.js';
import {
  fillPlaceholders,
  unknownLegacyPlaceholders,
  type PlaceholderContext,
} from '../../utils/placeholders.js';
import { enqueueEmailOnClient } from '../mail/emailOutboxService.js';
import * as organizationService from '../organizationService.js';
import * as statementService from './statementService.js';
import type {
  PartyKind,
  PartyStatement,
  SendStatementsResult,
  StatementEmailTemplate,
  StatementSend,
  StatementType,
} from '../../types/accounting.js';

/**
 * Emailing statements (Phase 39b): the organization's editable email
 * templates, and sending a statement as an email carrying a "Review and pay"
 * (customer) or "View statement" (vendor) link.
 *
 * The link is a bearer token: 32 random bytes, of which only the SHA-256
 * hash is stored (`statement_sends.token_hash`) — the organization_invitations
 * pattern. The raw token leaves this process exactly once, inside the
 * outbox row's `secret_link`, encrypted at rest and cleared once sent.
 *
 * Every send is one transaction: the `statement_sends` row and its outbox
 * row commit together or not at all (rule 5), and the worker's drain does
 * the actual sending afterwards.
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

// ------------------------------------------------------------------ templates

/** The code defaults, used until an organization saves its own template for a kind. */
export const BUILT_IN_TEMPLATES: Record<PartyKind, Omit<StatementEmailTemplate, 'partyKind'>> = {
  CUSTOMER: {
    id: null,
    name: 'Standard statement',
    subject: 'Statement from [Organisation Name]',
    body: [
      'Hi [Contact Name],',
      'Here is your account statement from [Organisation Name] as at [Statement Date].',
      'Balance due: [Balance Due]\nOverdue: [Overdue Amount]',
      'You can review your open invoices and pay online using the link below.',
      'Thank you,\n[Organisation Name]',
    ].join('\n\n'),
    isDefault: true,
    builtIn: true,
    updatedAt: null,
  },
  VENDOR: {
    id: null,
    name: 'Standard vendor statement',
    subject: 'Account statement from [Organisation Name]',
    body: [
      'Hi [Contact Name],',
      'Here is our statement of account with you as recorded by [Organisation Name] on [Statement Date].',
      'Balance we owe: [Balance Due]',
      'Please let us know if anything differs from your records.',
      'Thank you,\n[Organisation Name]',
    ].join('\n\n'),
    isDefault: true,
    builtIn: true,
    updatedAt: null,
  },
};

interface TemplateRow {
  id: string;
  party_kind: PartyKind;
  name: string;
  subject: string;
  body: string;
  is_default: boolean;
  updated_at: Date;
}

const TEMPLATE_COLUMNS = 'id, party_kind, name, subject, body, is_default, updated_at';

function toTemplate(row: TemplateRow): StatementEmailTemplate {
  return {
    id: row.id,
    partyKind: row.party_kind,
    name: row.name,
    subject: row.subject,
    body: row.body,
    isDefault: row.is_default,
    builtIn: false,
    updatedAt: row.updated_at.toISOString(),
  };
}

function builtIn(kind: PartyKind): StatementEmailTemplate {
  return { ...BUILT_IN_TEMPLATES[kind], partyKind: kind };
}

/**
 * 422 when a subject or body names a `{{legacy}}` placeholder that does not
 * exist. Bracket text is never refused — "[draft]" is ordinary prose.
 */
function assertKnownPlaceholders(subject: string | undefined, body: string | undefined): void {
  const unknown = [...unknownLegacyPlaceholders(subject ?? ''), ...unknownLegacyPlaceholders(body ?? '')];
  if (unknown.length > 0) {
    throw new ApiError(422, `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((n) => `{{${n}}}`).join(', ')}`);
  }
}

/**
 * GET /settings/statement-email-templates. The organization's templates, plus
 * the built-in default for any kind it has none of — so the list is never
 * empty and "the default" always exists.
 */
export async function listTemplates(orgId: string, kind: PartyKind | null): Promise<StatementEmailTemplate[]> {
  const { rows } = await pool.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM statement_email_templates
      WHERE org_id = $1 AND ($2::text IS NULL OR party_kind = $2)
      ORDER BY party_kind, is_default DESC, name, id`,
    [orgId, kind],
  );
  const templates = rows.map(toTemplate);
  for (const k of kind === null ? (['CUSTOMER', 'VENDOR'] as const) : [kind]) {
    if (!templates.some((t) => t.partyKind === k)) templates.push(builtIn(k));
  }
  return templates;
}

export interface CreateTemplateInput {
  partyKind: PartyKind;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
}

export interface UpdateTemplateInput {
  name?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  isDefault?: boolean | undefined;
}

/**
 * The first template an organization saves for a kind becomes its default,
 * so a kind never has stored templates but no default. Setting a template
 * as default clears the previous one in the same transaction — the partial
 * unique index (085) is what makes a racing second default fail rather than
 * silently coexist.
 */
async function clearDefaultOnClient(client: Queryable, orgId: string, kind: PartyKind, exceptId: string | null) {
  await client.query(
    `UPDATE statement_email_templates SET is_default = false
      WHERE org_id = $1 AND party_kind = $2 AND is_default AND ($3::uuid IS NULL OR id <> $3)`,
    [orgId, kind, exceptId],
  );
}

function mapDefaultConflict(err: unknown): never {
  if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
    throw new ApiError(409, 'Another template was made the default at the same time — try again');
  }
  throw err;
}

/** POST /settings/statement-email-templates */
export async function createTemplate(
  orgId: string,
  userId: string,
  input: CreateTemplateInput,
): Promise<StatementEmailTemplate> {
  assertKnownPlaceholders(input.subject, input.body);
  try {
    return await withTransaction(async (client) => {
      const { rows: existing } = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM statement_email_templates WHERE org_id = $1 AND party_kind = $2',
        [orgId, input.partyKind],
      );
      const isDefault = input.isDefault || existing[0]?.n === '0';
      if (isDefault) await clearDefaultOnClient(client, orgId, input.partyKind, null);
      const { rows } = await client.query<TemplateRow>(
        `INSERT INTO statement_email_templates (org_id, party_kind, name, subject, body, is_default, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${TEMPLATE_COLUMNS}`,
        [orgId, input.partyKind, input.name, input.subject, input.body, isDefault, userId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
      return toTemplate(row);
    });
  } catch (err) {
    return mapDefaultConflict(err);
  }
}

/** PATCH /settings/statement-email-templates/:id. Un-defaulting is done by defaulting another. */
export async function updateTemplate(
  orgId: string,
  id: string,
  input: UpdateTemplateInput,
): Promise<StatementEmailTemplate> {
  assertKnownPlaceholders(input.subject, input.body);
  if (input.isDefault === false) {
    throw new ApiError(422, 'Make another template the default instead of un-defaulting this one');
  }
  try {
    return await withTransaction(async (client) => {
      const { rows: current } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM statement_email_templates WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, id],
      );
      const row = current[0];
      if (row === undefined) throw new ApiError(404, 'Email template not found');
      if (input.isDefault === true) await clearDefaultOnClient(client, orgId, row.party_kind, id);
      const { rows } = await client.query<TemplateRow>(
        `UPDATE statement_email_templates
            SET name = COALESCE($3, name),
                subject = COALESCE($4, subject),
                body = COALESCE($5, body),
                is_default = is_default OR COALESCE($6, false)
          WHERE org_id = $1 AND id = $2
          RETURNING ${TEMPLATE_COLUMNS}`,
        [orgId, id, input.name ?? null, input.subject ?? null, input.body ?? null, input.isDefault ?? null],
      );
      const updated = rows[0];
      if (updated === undefined) throw new ApiError(404, 'Email template not found');
      return toTemplate(updated);
    });
  } catch (err) {
    return mapDefaultConflict(err);
  }
}

/**
 * DELETE /settings/statement-email-templates/:id. Deleting the default
 * promotes the most recently edited remaining template of the same kind (or
 * leaves the built-in to take over). Past sends keep their history: the FK
 * nulls `statement_sends.template_id`.
 */
export async function deleteTemplate(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ party_kind: PartyKind; is_default: boolean }>(
      'DELETE FROM statement_email_templates WHERE org_id = $1 AND id = $2 RETURNING party_kind, is_default',
      [orgId, id],
    );
    const deleted = rows[0];
    if (deleted === undefined) throw new ApiError(404, 'Email template not found');
    if (deleted.is_default) {
      await client.query(
        `UPDATE statement_email_templates SET is_default = true
          WHERE org_id = $1
            AND id = (SELECT id FROM statement_email_templates
                       WHERE org_id = $1 AND party_kind = $2
                       ORDER BY updated_at DESC, id LIMIT 1)`,
        [orgId, deleted.party_kind],
      );
    }
  });
}

/** The template a send uses: the one asked for, else the org's default, else the built-in. */
async function resolveTemplate(
  orgId: string,
  kind: PartyKind,
  templateId: string | null,
): Promise<StatementEmailTemplate> {
  if (templateId !== null) {
    const { rows } = await pool.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM statement_email_templates WHERE org_id = $1 AND id = $2`,
      [orgId, templateId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Email template not found');
    if (row.party_kind !== kind) {
      throw new ApiError(422, `That template is for ${row.party_kind === 'CUSTOMER' ? 'customers' : 'vendors'}`);
    }
    return toTemplate(row);
  }
  const { rows } = await pool.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM statement_email_templates
      WHERE org_id = $1 AND party_kind = $2 AND is_default`,
    [orgId, kind],
  );
  const row = rows[0];
  return row === undefined ? builtIn(kind) : toTemplate(row);
}

// ------------------------------------------------------------------ rendering

/** 1234567 → "USD 12,345.67" — integer arithmetic only (rule 3). */
export function formatMoney(cents: number, currency: string): string {
  const magnitude = Math.abs(cents);
  const major = String(Math.trunc(magnitude / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minor = String(magnitude % 100).padStart(2, '0');
  return `${currency} ${cents < 0 ? '-' : ''}${major}.${minor}`;
}

export function statementContext(
  organizationName: string,
  currency: string,
  statement: PartyStatement,
): PlaceholderContext {
  return {
    date: statement.statementDate,
    contactName: statement.party.name,
    organisationName: organizationName,
    balanceDue: formatMoney(statement.closingBalanceCents, currency),
    overdueAmount: formatMoney(statement.overdueCents, currency),
    statementDate: statement.statementDate,
    periodFrom: statement.from,
    periodTo: statement.statementDate,
    openInvoiceCount: statement.openItems.filter((i) => i.documentKind === 'INVOICE' || i.documentKind === 'BILL')
      .length,
  };
}

export interface StatementEmailPreview {
  toEmail: string | null;
  subject: string;
  body: string;
}

/**
 * POST /statements/:kind/preview-email — exactly what one party would
 * receive: their real statement through the chosen template.
 */
export async function previewStatementEmail(
  orgId: string,
  kind: PartyKind,
  partyId: string,
  request: statementService.StatementRequest,
  templateId: string | null,
): Promise<StatementEmailPreview> {
  const [organization, template, statement] = await Promise.all([
    organizationService.getById(orgId),
    resolveTemplate(orgId, kind, templateId),
    statementService.getStatement(orgId, kind, partyId, request),
  ]);
  const ctx = statementContext(organization.name, organization.baseCurrency, statement);
  return {
    toEmail: statement.party.email,
    subject: fillPlaceholders(template.subject, 'STATEMENT', ctx),
    body: fillPlaceholders(template.body, 'STATEMENT', ctx),
  };
}

// -------------------------------------------------------------------- sending

export interface SendStatementsInput {
  partyIds: string[];
  request: statementService.StatementRequest;
  templateId: string | null;
  /** Only with exactly one party: send somewhere other than the party's saved email. */
  toEmail: string | null;
}

function linkFor(token: string): string {
  return `${new URL(env.FRONTEND_URL).origin}/statement/${encodeURIComponent(token)}`;
}

/** POST /statements/:kind/send */
export async function sendStatements(
  orgId: string,
  userId: string,
  kind: PartyKind,
  input: SendStatementsInput,
): Promise<SendStatementsResult> {
  const partyIds = [...new Set(input.partyIds)];
  if (input.toEmail !== null && partyIds.length !== 1) {
    throw new ApiError(422, 'A different recipient address can only be given when sending to one party');
  }

  // Reads first, outside the transaction: each statement is a read of
  // committed data, and holding a transaction open across N statement
  // computations would only lengthen it.
  const [organization, template] = await Promise.all([
    organizationService.getById(orgId),
    resolveTemplate(orgId, kind, input.templateId),
  ]);
  const statements: PartyStatement[] = [];
  for (const partyId of partyIds) {
    statements.push(await statementService.getStatement(orgId, kind, partyId, input.request));
  }

  const result: SendStatementsResult = { sent: [], skipped: [] };
  const expiresAt = new Date(Date.now() + STATEMENT_LINK_TTL_MS);
  const { request } = input;

  await withTransaction(async (client) => {
    for (const statement of statements) {
      const toEmail = (input.toEmail ?? statement.party.email)?.trim().toLowerCase() ?? '';
      if (toEmail === '') {
        result.skipped.push({ partyId: statement.party.id, name: statement.party.name, reason: 'NO_EMAIL' });
        continue;
      }

      const token = randomUrlToken();
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO statement_sends
           (org_id, party_kind, customer_id, vendor_id, statement_type, as_of, period_from, period_to,
            template_id, to_email, sent_by, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          orgId,
          kind,
          kind === 'CUSTOMER' ? statement.party.id : null,
          kind === 'VENDOR' ? statement.party.id : null,
          request.type,
          request.type === 'OUTSTANDING' ? request.asOf : null,
          request.type === 'ACTIVITY' ? request.from : null,
          request.type === 'ACTIVITY' ? request.to : null,
          template.id,
          toEmail,
          userId,
          sha256Hex(token),
          expiresAt,
        ],
      );
      const sendId = rows[0]?.id;
      if (sendId === undefined) throw new Error('INSERT ... RETURNING produced no row');

      const ctx = statementContext(organization.name, organization.baseCurrency, statement);
      await enqueueEmailOnClient(client, {
        orgId,
        to: toEmail,
        toName: statement.party.name,
        template: 'party_statement',
        data: {
          organizationName: organization.name,
          subject: fillPlaceholders(template.subject, 'STATEMENT', ctx),
          body: fillPlaceholders(template.body, 'STATEMENT', ctx),
          actionLabel: kind === 'CUSTOMER' ? 'pay' : 'view',
        },
        link: linkFor(token),
      });
      result.sent.push({ partyId: statement.party.id, sendId, toEmail });
    }
  });

  return result;
}

interface SendRow {
  id: string;
  party_kind: PartyKind;
  customer_id: string | null;
  vendor_id: string | null;
  statement_type: StatementType;
  as_of: string | null;
  period_from: string | null;
  period_to: string | null;
  to_email: string;
  template_name: string | null;
  sent_by_name: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_viewed_at: Date | null;
}

function toSend(row: SendRow): StatementSend {
  return {
    id: row.id,
    partyKind: row.party_kind,
    partyId: row.customer_id ?? row.vendor_id ?? '',
    statementType: row.statement_type,
    asOf: row.as_of,
    from: row.period_from,
    to: row.period_to,
    toEmail: row.to_email,
    templateName: row.template_name,
    sentByName: row.sent_by_name,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    lastViewedAt: row.last_viewed_at?.toISOString() ?? null,
  };
}

const SEND_SELECT = `
  SELECT s.id, s.party_kind, s.customer_id, s.vendor_id, s.statement_type,
         s.as_of::text AS as_of, s.period_from::text AS period_from, s.period_to::text AS period_to,
         s.to_email, t.name AS template_name, u.name AS sent_by_name,
         s.created_at, s.expires_at, s.revoked_at, s.last_viewed_at
    FROM statement_sends s
    LEFT JOIN statement_email_templates t ON t.org_id = s.org_id AND t.id = s.template_id
    LEFT JOIN users u ON u.id = s.sent_by`;

/** GET /statements/:kind/:id/sends — newest first. */
export async function listSends(orgId: string, kind: PartyKind, partyId: string): Promise<StatementSend[]> {
  // 404 for a party outside the org, through its own service.
  await statementService.assertParty(orgId, kind, partyId);
  const column = kind === 'CUSTOMER' ? 'customer_id' : 'vendor_id';
  const { rows } = await pool.query<SendRow>(
    `${SEND_SELECT}
      WHERE s.org_id = $1 AND s.${column} = $2
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 50`,
    [orgId, partyId],
  );
  return rows.map(toSend);
}

/** POST /statement-sends/:id/revoke — the link stops working; idempotent. */
export async function revokeSend(orgId: string, id: string): Promise<StatementSend> {
  const { rowCount } = await pool.query(
    'UPDATE statement_sends SET revoked_at = COALESCE(revoked_at, now()) WHERE org_id = $1 AND id = $2',
    [orgId, id],
  );
  if (rowCount === 0) throw new ApiError(404, 'Statement link not found');
  const { rows } = await pool.query<SendRow>(`${SEND_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [orgId, id]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Statement link not found');
  return toSend(row);
}
