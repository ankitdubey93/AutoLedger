/**
 * Phase 38c — the permission set a built-in role's session carries, for
 * test fixtures. Imported from the SERVER's catalogue (a self-contained file
 * with no imports) rather than copied, so a fixture can never drift from
 * what the real server sends.
 */
import { BUILTIN_ROLE_PERMISSIONS } from '../../../../server/src/config/permissions';

export function permissionsFor(role: string | null): string[] {
  if (role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT' || role === 'VIEWER') {
    return [...BUILTIN_ROLE_PERMISSIONS[role]].sort();
  }
  return [];
}
