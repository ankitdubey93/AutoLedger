import type { PoolClient } from 'pg';
import type { AccountType } from '../../types/accounting.js';

/**
 * Shared account-code resolution for the JSONB-staged import kinds. One query
 * per import, never per row; every statement is scoped by org_id (rule 1).
 */
export interface ImportAccount {
  id: string;
  code: string;
  type: AccountType;
  isPostable: boolean;
  isActive: boolean;
}

export async function loadAccountsByCodeOnClient(
  client: PoolClient,
  orgId: string,
  codes: readonly string[],
): Promise<Map<string, ImportAccount>> {
  const out = new Map<string, ImportAccount>();
  if (codes.length === 0) return out;
  const { rows } = await client.query<{
    id: string;
    code: string;
    type: AccountType;
    is_postable: boolean;
    is_active: boolean;
  }>(
    'SELECT id, code, type, is_postable, is_active FROM accounts WHERE org_id = $1 AND code = ANY($2::text[])',
    [orgId, [...codes]],
  );
  for (const r of rows) {
    out.set(r.code, { id: r.id, code: r.code, type: r.type, isPostable: r.is_postable, isActive: r.is_active });
  }
  return out;
}

/** null when ok; otherwise the one row-level message the account fails on. */
export function accountCodeError(
  label: string,
  code: string,
  account: ImportAccount | undefined,
  wantTypes: readonly AccountType[],
): string | null {
  if (account === undefined) return `${label} "${code}" was not found`;
  if (!wantTypes.includes(account.type)) {
    const typeText = wantTypes.join(' or ');
    const article = /^[AEIOU]/i.test(typeText) ? 'an' : 'a';
    return `${label} "${code}" must be ${article} ${typeText} account`;
  }
  if (!account.isPostable) return `${label} "${code}" is a header account and cannot be posted to`;
  if (!account.isActive) return `${label} "${code}" is inactive`;
  return null;
}
