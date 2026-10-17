export const HISTORY_ENTITY_TYPES = [
  'INVOICE', 'BILL', 'CREDIT_NOTE', 'DEBIT_NOTE', 'QUOTE', 'PURCHASE_QUOTE',
  'SALES_ORDER', 'PURCHASE_ORDER', 'PAYMENT', 'MANUAL_JOURNAL',
  'CUSTOMER', 'VENDOR', 'BANK_TRANSACTION',
] as const;
export type HistoryEntityType = (typeof HISTORY_ENTITY_TYPES)[number];

/** The closed set of actions. Must stay in step with the CHECK pattern in migration 101 (A–Z and _ only, ≤ 40). */
export const HISTORY_ACTIONS = [
  'CREATED', 'UPDATED', 'SUBMITTED', 'APPROVED', 'ISSUED', 'POSTED', 'VOIDED',
  'SENT', 'REVISED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CONVERTED',
  'CONFIRMED', 'CLOSED', 'REOPENED', 'CANCELLED',
  'PAYMENT_RECEIVED', 'PAYMENT_MADE', 'PAYMENT_VOIDED', 'CREDIT_APPLIED',
  'IMPORTED', 'MATCHED', 'UNMATCHED', 'IGNORED', 'UNIGNORED', 'DELETED', 'RESTORED',
  'NOTE',
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export interface HistoryEntry {
  id: string;
  kind: 'EVENT' | 'NOTE';
  action: HistoryAction;
  summary: string;
  details: Record<string, unknown> | null;
  actorUserId: string | null;
  /** users.name, else users.email; null for a system action or a deleted user. */
  actorName: string | null;
  createdAt: string;
}

export interface RecordHistoryInput {
  entityType: HistoryEntityType;
  entityId: string;
  action: Exclude<HistoryAction, 'NOTE'>;
  summary: string;
  details?: Record<string, unknown>;
}
