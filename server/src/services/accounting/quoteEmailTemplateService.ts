import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { fillPlaceholders, type PlaceholderContext } from '../../utils/placeholders.js';
import type { QuoteDirection, QuoteEmailTemplate } from '../../types/accounting.js';

/**
 * Phase 42 slice C — user-editable subject/body for the quote email, per
 * direction. Mirrors `statementEmailService`'s template half: the code
 * defaults stand in until an organization saves its own, at most one stored
 * default per (org, direction) is enforced by a partial unique index (090),
 * and text is filled with `[Placeholders]` on the QUOTE surface in `final`
 * mode at send time. Every query is scoped by `org_id` (rule 1).
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_UNIQUE_VIOLATION = '23505';
const DIRECTIONS: readonly QuoteDirection[] = ['SALES', 'PURCHASE'];

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/** The code defaults, used until an organization saves its own template for a direction. */
export const BUILT_IN_QUOTE_TEMPLATES: Record<QuoteDirection, Omit<QuoteEmailTemplate, 'direction'>> = {
  SALES: {
    id: null,
    name: 'Standard quote',
    subject: 'Quote [Quote Number] from [Organisation Name]',
    body: 'Hi [Contact Name],\n\nPlease find our quote [Quote Number] for [Quote Total], valid until [Valid Until].\n\nYou can review and accept it online using the button below.\n\nThank you,\n[Organisation Name]',
    isDefault: true,
    builtIn: true,
    updatedAt: null,
  },
  PURCHASE: {
    id: null,
    name: 'Standard price confirmation',
    subject: 'Price confirmation [Quote Number] from [Organisation Name]',
    body: 'Hi [Contact Name],\n\nPlease confirm the prices in [Quote Number] ([Quote Total]) by [Valid Until].\n\nThank you,\n[Organisation Name]',
    isDefault: true,
    builtIn: true,
    updatedAt: null,
  },
};

interface TemplateRow {
  id: string;
  direction: QuoteDirection;
  name: string;
  subject: string;
  body: string;
  is_default: boolean;
  updated_at: Date;
}

const TEMPLATE_COLUMNS = 'id, direction, name, subject, body, is_default, updated_at';

function toTemplate(row: TemplateRow): QuoteEmailTemplate {
  return {
    id: row.id,
    direction: row.direction,
    name: row.name,
    subject: row.subject,
    body: row.body,
    isDefault: row.is_default,
    builtIn: false,
    updatedAt: row.updated_at.toISOString(),
  };
}

function builtIn(direction: QuoteDirection): QuoteEmailTemplate {
  return { ...BUILT_IN_QUOTE_TEMPLATES[direction], direction };
}

/**
 * 422 when a subject or body carries a `{{double-brace}}` token. That syntax
 * is a statement-only legacy; on a quote it would be sent literally, so it is
 * refused as a typo. Bracket text is never refused — "[draft]" is prose.
 */
function assertNoBraceTokens(subject: string | undefined, body: string | undefined): void {
  const found: string[] = [];
  for (const text of [subject ?? '', body ?? '']) {
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      const name = m[1];
      if (name !== undefined && !found.includes(name)) found.push(name);
    }
  }
  if (found.length > 0) {
    throw new ApiError(422, `Unknown placeholder${found.length > 1 ? 's' : ''}: ${found.map((n) => `{{${n}}}`).join(', ')}`);
  }
}

/**
 * The organization's templates, plus the built-in default for any direction
 * it has none of — so the list is never empty and "the default" always exists.
 */
export async function listQuoteTemplates(orgId: string, direction: QuoteDirection | null): Promise<QuoteEmailTemplate[]> {
  const { rows } = await pool.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM quote_email_templates
      WHERE org_id = $1 AND ($2::text IS NULL OR direction = $2)
      ORDER BY direction, is_default DESC, name, id`,
    [orgId, direction],
  );
  const templates = rows.map(toTemplate);
  for (const d of direction === null ? DIRECTIONS : [direction]) {
    if (!templates.some((t) => t.direction === d)) templates.unshift(builtIn(d));
  }
  return templates;
}

async function clearDefaultOnClient(client: Queryable, orgId: string, direction: QuoteDirection, exceptId: string | null) {
  await client.query(
    `UPDATE quote_email_templates SET is_default = false
      WHERE org_id = $1 AND direction = $2 AND is_default AND ($3::uuid IS NULL OR id <> $3)`,
    [orgId, direction, exceptId],
  );
}

function mapDefaultConflict(err: unknown): never {
  if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
    throw new ApiError(409, 'Another template was made the default at the same time — try again');
  }
  throw err;
}

export interface CreateQuoteTemplateInput {
  direction: QuoteDirection;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
}

export interface UpdateQuoteTemplateInput {
  name?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  isDefault?: boolean | undefined;
}

/** The first template saved for a direction becomes its default. */
export async function createQuoteTemplate(
  orgId: string,
  userId: string,
  input: CreateQuoteTemplateInput,
): Promise<QuoteEmailTemplate> {
  assertNoBraceTokens(input.subject, input.body);
  try {
    return await withTransaction(async (client) => {
      const { rows: existing } = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM quote_email_templates WHERE org_id = $1 AND direction = $2',
        [orgId, input.direction],
      );
      const isDefault = input.isDefault || existing[0]?.n === '0';
      if (isDefault) await clearDefaultOnClient(client, orgId, input.direction, null);
      const { rows } = await client.query<TemplateRow>(
        `INSERT INTO quote_email_templates (org_id, direction, name, subject, body, is_default, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${TEMPLATE_COLUMNS}`,
        [orgId, input.direction, input.name, input.subject, input.body, isDefault, userId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
      return toTemplate(row);
    });
  } catch (err) {
    return mapDefaultConflict(err);
  }
}

/** Un-defaulting is done by defaulting another. */
export async function updateQuoteTemplate(
  orgId: string,
  id: string,
  input: UpdateQuoteTemplateInput,
): Promise<QuoteEmailTemplate> {
  assertNoBraceTokens(input.subject, input.body);
  if (input.isDefault === false) {
    throw new ApiError(422, 'Make another template the default instead of un-defaulting this one');
  }
  try {
    return await withTransaction(async (client) => {
      const { rows: current } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM quote_email_templates WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, id],
      );
      const row = current[0];
      if (row === undefined) throw new ApiError(404, 'Email template not found');
      if (input.isDefault === true) await clearDefaultOnClient(client, orgId, row.direction, id);
      const { rows } = await client.query<TemplateRow>(
        `UPDATE quote_email_templates
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

/** Deleting the default promotes the most recently edited remaining template (or the built-in takes over). */
export async function deleteQuoteTemplate(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ direction: QuoteDirection; is_default: boolean }>(
      'DELETE FROM quote_email_templates WHERE org_id = $1 AND id = $2 RETURNING direction, is_default',
      [orgId, id],
    );
    const deleted = rows[0];
    if (deleted === undefined) throw new ApiError(404, 'Email template not found');
    if (deleted.is_default) {
      await client.query(
        `UPDATE quote_email_templates SET is_default = true
          WHERE org_id = $1
            AND id = (SELECT id FROM quote_email_templates
                       WHERE org_id = $1 AND direction = $2
                       ORDER BY updated_at DESC, id LIMIT 1)`,
        [orgId, deleted.direction],
      );
    }
  });
}

/**
 * The template to send with — the chosen one, else the stored default for the
 * direction, else the built-in — filled for one quote. Runs on the caller's
 * transaction client (rule 5).
 */
export async function renderQuoteEmailOnClient(
  client: Queryable,
  orgId: string,
  direction: QuoteDirection,
  templateId: string | null,
  ctx: PlaceholderContext,
): Promise<{ subject: string; body: string }> {
  let template: { subject: string; body: string };
  if (templateId !== null) {
    const { rows } = await client.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM quote_email_templates WHERE org_id = $1 AND id = $2 AND direction = $3`,
      [orgId, templateId, direction],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(422, 'Email template not found');
    template = row;
  } else {
    const { rows } = await client.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM quote_email_templates WHERE org_id = $1 AND direction = $2 AND is_default`,
      [orgId, direction],
    );
    template = rows[0] ?? builtIn(direction);
  }
  assertNoBraceTokens(template.subject, template.body);
  return {
    subject: fillPlaceholders(template.subject, 'QUOTE', ctx, 'final'),
    body: fillPlaceholders(template.body, 'QUOTE', ctx, 'final'),
  };
}
