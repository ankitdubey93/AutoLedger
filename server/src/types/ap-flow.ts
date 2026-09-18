import type { AiModelCall } from './aiUsage.js';

/**
 * AP-Flow (Phase 10) — capture & extraction. This file mirrors
 * `types/ledger-core.ts`'s FSM-table shape: one transition table in code,
 * a matching CHECK constraint in the migration.
 */

export const AP_FLOW_DOCUMENT_STATUSES = ['PENDING', 'PROCESSING', 'EXTRACTED', 'FAILED', 'POSTED', 'DUPLICATE'] as const;
export type ApFlowDocumentStatus = (typeof AP_FLOW_DOCUMENT_STATUSES)[number];

export function isApFlowDocumentStatus(value: string): value is ApFlowDocumentStatus {
  return (AP_FLOW_DOCUMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * PENDING -> PROCESSING -> EXTRACTED | FAILED, with two re-entry edges, and
 * now EXTRACTED -> POSTED. POSTED is this table's first terminal state: its
 * outbound edge list is empty. Phase 10's comment here used to say "nothing
 * here is terminal... Phase 11 adds the states that ARE terminal, because
 * they post" — this is that phase. A posted document is corrected by
 * reversing its journal entry in LedgerCore, never by re-extracting or
 * editing this row; re-extraction after posting is impossible by
 * construction (POSTED has no outbound edge to PENDING), and the database's
 * own trg_ap_flow_documents_posted_guard trigger (migration 032) refuses any
 * UPDATE once status = 'POSTED' regardless of what this table says.
 *
 * DUPLICATE is a second legal BIRTH state, alongside PENDING — `captureFile`
 * sets it directly on INSERT when the uploaded bytes already match an
 * existing document for this org, never via an UPDATE, so it has no inbound
 * edge in this table. Its one outbound edge, DUPLICATE -> PENDING, is
 * deliberately identical in shape to FAILED -> PENDING: a human decided the
 * flagged capture is legitimate after all, and "process it anyway" is
 * `requestReextraction` re-entering the ordinary pipeline — no separate
 * endpoint or transition needed for the "push it through" action.
 */
export const AP_FLOW_DOCUMENT_TRANSITIONS = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['EXTRACTED', 'FAILED'],
  EXTRACTED: ['PENDING', 'POSTED'],
  FAILED: ['PENDING'],
  POSTED: [],
  DUPLICATE: ['PENDING'],
} as const satisfies Record<ApFlowDocumentStatus, readonly ApFlowDocumentStatus[]>;

export function canTransitionApFlowDocument(
  from: ApFlowDocumentStatus,
  to: ApFlowDocumentStatus,
): boolean {
  return (AP_FLOW_DOCUMENT_TRANSITIONS[from] as readonly ApFlowDocumentStatus[]).includes(to);
}

export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  box: BoundingBox;
  confidence: number;
}

export interface OcrPageResult {
  width: number;
  height: number;
  text: string;
  words: OcrWord[];
}

export type PiiKind = 'CARD_NUMBER' | 'PAN' | 'AADHAAR' | 'GSTIN' | 'SSN' | 'PERSON_NAME';

export interface RedactedRegion {
  kind: PiiKind;
  box: BoundingBox;
}

export interface ApFlowLineItem {
  description: string;
  amountCents: number;
}

/**
 * How a line item's account was chosen, cheapest and most explainable
 * first: the organization's own posting history for this vendor, then a
 * name/description match against the chart, then the model as a last
 * resort. 'MANUAL' means a reviewer overrode whatever tier suggested.
 * 'NONE' means nothing has suggested an account yet.
 */
export const AP_FLOW_MAPPING_SOURCES = ['HISTORY', 'CHART', 'MODEL', 'MANUAL', 'NONE'] as const;
export type ApFlowMappingSource = (typeof AP_FLOW_MAPPING_SOURCES)[number];

export function isApFlowMappingSource(value: string): value is ApFlowMappingSource {
  return (AP_FLOW_MAPPING_SOURCES as readonly string[]).includes(value);
}

export interface ApFlowLineItemRecord {
  id: string;
  lineIndex: number;
  description: string;
  amountCents: number;
  accountId: string | null;
  /** Filled by calling accountService, never by joining accounts (rule 16). */
  accountCode: string | null;
  accountName: string | null;
  suggestedAccountId: string | null;
  mappingSource: ApFlowMappingSource;
  mappingConfidence: number | null;
}

/** One row in GET /ap-flow/review-queue, lowest confidence first. */
export interface ApFlowReviewQueueEntry {
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
  /** Phase 19. */
  autoPostBlockers: ApFlowAutoPostBlocker[];
}

export interface ApFlowExtraction {
  id: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // 'YYYY-MM-DD'
  /** Phase 19. 'YYYY-MM-DD'. */
  dueDate: string | null;
  currency: string | null;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  lineItems: ApFlowLineItem[];
  fieldConfidence: Record<string, number>;
  arithmeticOk: boolean;
  validationErrors: string[];
  model: string;
  createdAt: string;
}

/**
 * `ocrText` is deliberately absent — it is stored (ap_flow_pages.ocr_text)
 * but never returned by the API. It is the *un*redacted local text; sending
 * it back to the client would undo the redaction.
 */
export interface ApFlowPage {
  id: string;
  pageNumber: number;
  widthPx: number;
  heightPx: number;
  redactedSha256: string;
  redactedRegions: RedactedRegion[];
}

export interface ApFlowDocumentRecord {
  id: string;
  documentId: string;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  status: ApFlowDocumentStatus;
  pageCount: number | null;
  failureReason: string | null;
  processedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  /** Phase 11. Null until POSTED. No REFERENCES to journal_entries — rule 16. */
  journalEntryId: string | null;
  /** Phase 11. The vault document's sha256 at the moment this was posted. */
  postedSha256: string | null;
  postedAt: string | null;
  /** Phase 19. The LedgerCore bill this document posted as. No REFERENCES — rule 16. */
  billId: string | null;
  /** Phase 19. True when auto-post — not a human — approved this posting. */
  autoPosted: boolean;
  /** Phase 19. Why an EXTRACTED document has not auto-posted. Empty once POSTED. */
  autoPostBlockers: ApFlowAutoPostBlocker[];
  /** Non-null only when status is DUPLICATE — the earlier document this capture's bytes match. */
  duplicateOfId: string | null;
  /** The matched document's own original filename, for "duplicate of <name>" without a second round trip. Null unless duplicateOfId is set. */
  duplicateOfFilename: string | null;
}

export interface ApFlowDocumentDetail extends ApFlowDocumentRecord {
  pages: ApFlowPage[];
  extraction: ApFlowExtraction | null;
  lineItems: ApFlowLineItemRecord[];
  /** Phase 19.1. Every metered model call this document caused, newest first. */
  modelCalls: AiModelCall[];
}

/**
 * GET /ap-flow/documents filters, read with utils/queryParam.ts's readers —
 * the established pattern for list-endpoint query strings, not a zod schema.
 */
export interface ApFlowDocumentListFilters {
  status: ApFlowDocumentStatus | null;
  page: number;
  limit: number;
}

// ---------------------------------------------------------- auto-post (19)

/**
 * Every reason a clean-looking extraction did NOT auto-post. `evaluateAutoPost`
 * (autoPostPolicy.ts) checks every gate rather than stopping at the first
 * failure — except AUTO_POST_DISABLED, which is exclusive — so a reviewer
 * sees the complete picture in one read.
 */
export const AP_FLOW_AUTO_POST_BLOCKER_CODES = [
  'AUTO_POST_DISABLED',
  'ARITHMETIC_MISMATCH',
  'MISSING_VENDOR_NAME',
  'MISSING_INVOICE_NUMBER',
  'MISSING_INVOICE_DATE',
  'NON_POSITIVE_TOTAL',
  'NO_LINE_ITEMS',
  'UNMAPPED_LINE',
  'NEGATIVE_LINE_AMOUNT',
  'LOW_FIELD_CONFIDENCE',
  'LOW_MAPPING_CONFIDENCE',
  'ABOVE_AMOUNT_LIMIT',
  'FOREIGN_CURRENCY_WITH_LIMIT',
  'POSTING_REJECTED',
] as const;
export type ApFlowAutoPostBlockerCode = (typeof AP_FLOW_AUTO_POST_BLOCKER_CODES)[number];

export interface ApFlowAutoPostBlocker {
  code: ApFlowAutoPostBlockerCode;
  message: string;
}

export interface ApFlowSettings {
  autoPostEnabled: boolean;
  /** 0.5-1, 3 decimal places. */
  autoPostMinConfidence: number;
  autoPostMaxTotalCents: number | null;
  /** null when no settings row has ever been saved — the defaults are in force. */
  updatedAt: string | null;
}

export const AP_FLOW_AUTO_POST_DEFAULTS: ApFlowSettings = {
  autoPostEnabled: false,
  autoPostMinConfidence: 0.9,
  autoPostMaxTotalCents: null,
  updatedAt: null,
};

// Drive intake's types moved to `types/integrations.ts` in Phase 19.3 — the
// integration is platform-level now, not AP-Flow's, because a folder's purpose
// routes its files to whichever app owns that purpose (guardrails rule 16).
