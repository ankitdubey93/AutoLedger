import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import request from 'supertest';
import type { Express } from 'express';
import { pool } from '../../db/connect.js';
import { env } from '../../config/env.js';
import * as authService from '../../services/authService.js';
import type { Role } from '../../types/auth.js';

/**
 * Fixture builders. Every identifier is unique per call, so a leak across
 * tests shows up as an obviously wrong value rather than a coincidental match
 * against another test's "test@example.com".
 */

/**
 * Truncates every table. CASCADE follows the FKs; RESTART IDENTITY resets sequences.
 *
 * `accounts` is named explicitly even though CASCADE from `organizations` would
 * reach it — naming it keeps the list a readable inventory of what a test starts
 * from, and it survives a future FK changing to RESTRICT.
 *
 * TRUNCATE does **not** fire row-level triggers, so LedgerCore's immutability
 * trigger on posted rows does not block a reset between tests. `audit_logs`
 * is append-only by trigger too (Phase 5), but the same exemption applies —
 * TRUNCATE clears it and RESTART IDENTITY puts its BIGINT id back to 1.
 */
export async function resetTables(): Promise<void> {
  await pool.query(
    `TRUNCATE organizations, users, organization_members, refresh_tokens, accounts,
              ledger_settings, ledger_invoice_settings, customers, invoices, invoice_lines,
              vendors, bills, bill_lines, payments, payment_allocations, fiscal_periods,
              bank_statement_imports, bank_transactions, bank_match_suggestions,
              outbox_events, webhook_endpoints, webhook_deliveries,
              audit_logs, onboarding_states, migration_imports, migration_import_rows,
              documents, document_links,
              ap_flow_documents, ap_flow_pages, ap_flow_extractions,
              ap_flow_line_items, ap_flow_vendor_account_map,
              fpa_models, fpa_scenarios
     RESTART IDENTITY CASCADE`,
  );
}

export function uniqueEmail(label = 'user'): string {
  return `${label}-${randomUUID()}@example.com`;
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  orgId: string;
}

/** Registers a user with their own organization, as POST /auth/register would. */
export async function createUserWithOrg(options: { label?: string; orgName?: string } = {}) {
  const label = options.label ?? 'user';
  const email = uniqueEmail(label);
  const password = 'a-perfectly-fine-password';

  const user = await authService.register({
    name: label,
    email,
    password,
    organizationName: options.orgName ?? `Org ${randomUUID().slice(0, 8)}`,
  });

  const { rows } = await pool.query<{ org_id: string }>(
    'SELECT org_id FROM organization_members WHERE user_id = $1',
    [user.id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('register() did not create a membership');

  return { id: user.id, email, password, orgId: row.org_id } satisfies SeededUser;
}

/** Adds an existing user to an existing organization. */
export async function addMember(orgId: string, userId: string, role: Role): Promise<void> {
  await pool.query('INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    userId,
    role,
  ]);
}

/**
 * Wipes STORAGE_ROOT between Document Vault tests. vitest.config.ts pins
 * this to `storage-test/`, never the dev store.
 */
export async function clearStorage(): Promise<void> {
  await rm(env.STORAGE_ROOT, { recursive: true, force: true });
}

/**
 * A supertest agent that has logged in and is holding the session cookies.
 *
 * `request.agent` keeps a cookie jar across requests, which is what makes the
 * httpOnly-cookie flow testable at all — and it honours cookie `path`, so the
 * refresh cookie is correctly withheld from everything outside /api/v1/auth.
 */
export async function loginAgent(app: Express, user: SeededUser) {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: user.password });

  if (response.status !== 200) {
    throw new Error(`login failed in fixture: ${response.status} ${response.text}`);
  }
  return agent;
}
