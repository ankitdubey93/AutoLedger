import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import {
  SYSTEM_ACCOUNT_ROLES,
  type SystemAccountRole,
  type SystemAccountSettingColumn,
} from '../../config/systemAccounts.js';
import type { SystemAccountView, SystemRoleRef } from '../../types/accounting.js';
import { ApiError } from '../../utils/apiError.js';

/**
 * Phase 46a — system accounts. A role is DERIVED from configuration (the
 * settings column when set, else the default chart's code) and never stored,
 * so it cannot drift from what the posting resolvers use. Every statement is
 * scoped by `org_id` (rule 1) and the `*OnClient` functions use only the
 * handed-in client (rule 5).
 */

type Queryable = Pick<PoolClient, 'query'>;

export interface ResolvedSystemAccount {
  accountId: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface SettingsRow {
  payable_account_id: string | null;
  tax_input_account_id: string | null;
  stock_opening_account_id: string | null;
  realized_fx_gain_account_id: string | null;
  realized_fx_loss_account_id: string | null;
  unrealized_fx_account_id: string | null;
  inventory_account_id: string | null;
  cogs_account_id: string | null;
  inventory_adjustment_account_id: string | null;
  receivable_account_id: string | null;
  tax_payable_account_id: string | null;
  customer_deposit_account_id: string | null;
  supplier_prepayment_account_id: string | null;
}

/** Typed constant — the SQL below is literal, nothing is interpolated (rule 4). */
const SETTING_KEY: Record<SystemAccountSettingColumn, keyof SettingsRow> = {
  'ledger_settings.payable_account_id': 'payable_account_id',
  'ledger_settings.tax_input_account_id': 'tax_input_account_id',
  'ledger_settings.stock_opening_account_id': 'stock_opening_account_id',
  'ledger_settings.realized_fx_gain_account_id': 'realized_fx_gain_account_id',
  'ledger_settings.realized_fx_loss_account_id': 'realized_fx_loss_account_id',
  'ledger_settings.unrealized_fx_account_id': 'unrealized_fx_account_id',
  'ledger_settings.inventory_account_id': 'inventory_account_id',
  'ledger_settings.cogs_account_id': 'cogs_account_id',
  'ledger_settings.inventory_adjustment_account_id': 'inventory_adjustment_account_id',
  'ledger_invoice_settings.receivable_account_id': 'receivable_account_id',
  'ledger_invoice_settings.tax_payable_account_id': 'tax_payable_account_id',
  'ledger_invoice_settings.customer_deposit_account_id': 'customer_deposit_account_id',
  'ledger_invoice_settings.supplier_prepayment_account_id': 'supplier_prepayment_account_id',
};

/** role → its effective account, or null. Two queries, both org-scoped. */
export async function resolveSystemAccountsOnClient(
  q: Queryable,
  orgId: string,
): Promise<Map<SystemAccountRole, ResolvedSystemAccount | null>> {
  const { rows } = await q.query<SettingsRow>(
    `SELECT ls.payable_account_id, ls.tax_input_account_id, ls.stock_opening_account_id,
            ls.realized_fx_gain_account_id, ls.realized_fx_loss_account_id, ls.unrealized_fx_account_id,
            ls.inventory_account_id, ls.cogs_account_id, ls.inventory_adjustment_account_id,
            lis.receivable_account_id, lis.tax_payable_account_id,
            lis.customer_deposit_account_id, lis.supplier_prepayment_account_id
       FROM organizations o
       LEFT JOIN ledger_settings ls ON ls.org_id = o.id
       LEFT JOIN ledger_invoice_settings lis ON lis.org_id = o.id
      WHERE o.id = $1`,
    [orgId],
  );
  const settings = rows[0];

  const configuredIds: string[] = [];
  const configured = new Map<SystemAccountRole, string>();
  for (const def of SYSTEM_ACCOUNT_ROLES) {
    if (def.setting === null || settings === undefined) continue;
    const id = settings[SETTING_KEY[def.setting]];
    if (typeof id === 'string') {
      configured.set(def.role, id);
      configuredIds.push(id);
    }
  }
  const codes = SYSTEM_ACCOUNT_ROLES.map((d) => d.defaultCode);

  const { rows: accounts } = await q.query<{ id: string; code: string; name: string; is_active: boolean }>(
    `SELECT id, code, name, is_active FROM accounts
      WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR code = ANY($3::text[]))`,
    [orgId, configuredIds, codes],
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  const result = new Map<SystemAccountRole, ResolvedSystemAccount | null>();
  for (const def of SYSTEM_ACCOUNT_ROLES) {
    const configuredId = configured.get(def.role);
    const row = configuredId !== undefined ? byId.get(configuredId) : byCode.get(def.defaultCode);
    result.set(
      def.role,
      row === undefined ? null : { accountId: row.id, code: row.code, name: row.name, isActive: row.is_active },
    );
  }
  return result;
}

/** accountId → the roles it holds (only ids that hold ≥1 role appear). */
export async function rolesForAccountsOnClient(
  q: Queryable,
  orgId: string,
): Promise<Map<string, SystemRoleRef[]>> {
  const resolved = await resolveSystemAccountsOnClient(q, orgId);
  const byAccount = new Map<string, SystemRoleRef[]>();
  for (const def of SYSTEM_ACCOUNT_ROLES) {
    const account = resolved.get(def.role);
    if (account === null || account === undefined) continue;
    const list = byAccount.get(account.accountId) ?? [];
    list.push({ role: def.role, label: def.label });
    byAccount.set(account.accountId, list);
  }
  return byAccount;
}

export async function listSystemAccounts(orgId: string): Promise<SystemAccountView[]> {
  const resolved = await resolveSystemAccountsOnClient(pool, orgId);
  return SYSTEM_ACCOUNT_ROLES.map((def) => {
    const account = resolved.get(def.role) ?? null;
    return {
      role: def.role,
      label: def.label,
      defaultCode: def.defaultCode,
      remappable: def.remappable,
      accountId: account?.accountId ?? null,
      code: account?.code ?? null,
      name: account?.name ?? null,
      isActive: account?.isActive ?? null,
    };
  });
}

/** 422 `Account ${code} is retired — activate it before using it here` for the first retired id. Ignores null. */
export async function assertActiveAccountsOnClient(
  q: Queryable,
  orgId: string,
  accountIds: readonly (string | null | undefined)[],
): Promise<void> {
  const ids = [...new Set(accountIds.filter((v): v is string => typeof v === 'string'))];
  if (ids.length === 0) return;
  const { rows } = await q.query<{ id: string; code: string; is_active: boolean }>(
    'SELECT id, code, is_active FROM accounts WHERE org_id = $1 AND id = ANY($2::uuid[])',
    [orgId, ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (row !== undefined && !row.is_active) {
      throw new ApiError(422, `Account ${row.code} is retired — activate it before using it here`);
    }
  }
}
