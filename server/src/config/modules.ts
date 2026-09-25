/**
 * AutoLedger is one product (Phase 33). Inside it, three modules own their
 * own code and tables: accounting (the general ledger and everything that
 * posts to it), capture (the bill inbox: OCR, extraction and review) and
 * inventory (stock items, movements and valuation).
 *
 * Each module has a **provenance tag**, written wherever a row records which
 * module produced it: `audit_logs.app_slug` (through each audit trigger's
 * argument), `outbox_events`, `document_links`, `ai_model_calls`,
 * `onboarding_states` and `integration_drive_files.result_app`.
 *
 * The tag values are the pre-Phase-33 app slugs, and they are **frozen**.
 * `audit_logs` is append-only, so its history cannot be rewritten; the audit
 * triggers pass the tag as a literal argument; and one CHECK constraint lists
 * two of them. Renaming the tags would split every one of those columns into
 * old and new spellings of the same thing. They are internal identifiers and
 * never shown to a user; the client maps them to section names.
 */
export const MODULE_TAGS = {
  accounting: 'ledger-core',
  capture: 'ap-flow',
  inventory: 'stock',
} as const;

export type ModuleTag = (typeof MODULE_TAGS)[keyof typeof MODULE_TAGS];

/** The tag for rows written by platform code (auth, organizations, webhooks). */
export const PLATFORM_TAG = 'platform';

const TAG_VALUES: readonly string[] = Object.values(MODULE_TAGS);

/** Narrows an unknown string (a query or body field) to a module tag. */
export function isModuleTag(value: string): value is ModuleTag {
  return TAG_VALUES.includes(value);
}
