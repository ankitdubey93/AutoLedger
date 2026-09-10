import type { AllowedUploadMimeType } from '../config/constants.js';

/**
 * The Document Vault (Phase 9.5) — platform-layer, unprefixed, mirroring
 * `types/onboarding.ts`: the vault spans every app, not just LedgerCore
 * (guardrails rule 16).
 */

/**
 * Which entity kinds each app may attach a document to.
 *
 * The platform knowing this map is not a rule-16 violation: it is a
 * registry, exactly like config/apps.ts, and nothing here reads an app's
 * tables. Without it, entity_type fills with typos and the vault stops
 * being queryable. An app adding an attachable entity adds a string here.
 */
export const DOCUMENT_ENTITY_TYPES_BY_APP = {
  'ledger-core': ['invoice', 'bill', 'journal_entry', 'payment', 'customer', 'vendor'],
  'ap-flow': ['ap_flow_document'],
} as const satisfies Record<string, readonly string[]>;

export type DocumentEntityApp = keyof typeof DOCUMENT_ENTITY_TYPES_BY_APP;
export type DocumentEntityType =
  (typeof DOCUMENT_ENTITY_TYPES_BY_APP)[DocumentEntityApp][number];

/** True when this app declares this entity type as attachable. */
export function isDocumentEntityType(appSlug: string, entityType: string): boolean {
  if (!(appSlug in DOCUMENT_ENTITY_TYPES_BY_APP)) return false;
  const entityTypes = DOCUMENT_ENTITY_TYPES_BY_APP[appSlug as DocumentEntityApp] as readonly string[];
  return entityTypes.includes(entityType);
}

export interface DocumentRecord {
  id: string;
  sha256: string;
  // `byteSize` is a number here even though Postgres stores it as BIGINT and
  // `pg` returns BIGINT as a string — the service converts with
  // Number(row.byte_size), which is exact for any value under 2^53 and
  // therefore for any file under MAX_UPLOAD_BYTES.
  byteSize: number;
  mimeType: AllowedUploadMimeType;
  originalFilename: string;
  uploadedBy: string;
  uploadedByName: string | null;
  createdAt: string;
  linkCount: number;
}

export interface DocumentLink {
  id: string;
  documentId: string;
  appSlug: string;
  entityType: string;
  entityId: string;
  createdBy: string;
  createdAt: string;
}

export interface DocumentWithLinks extends DocumentRecord {
  links: DocumentLink[];
}

export interface AttachDocumentInput {
  appSlug: string;
  entityType: string;
  entityId: string;
}

/**
 * GET /documents filters, read by the controller with utils/queryParam.ts's
 * readers — the codebase's established pattern for list-endpoint query
 * strings (see journalController.list), not a zod schema. zod's parseBody
 * is reserved for JSON request bodies here.
 */
export interface DocumentListFilters {
  appSlug: string | null;
  entityType: string | null;
  entityId: string | null;
  page: number;
  limit: number;
}
