/**
 * AP-Flow (Phase 10) — capture & extraction. This file mirrors
 * `types/ledger-core.ts`'s FSM-table shape: one transition table in code,
 * a matching CHECK constraint in the migration.
 */

export const AP_FLOW_DOCUMENT_STATUSES = ['PENDING', 'PROCESSING', 'EXTRACTED', 'FAILED', 'POSTED'] as const;
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
 */
export const AP_FLOW_DOCUMENT_TRANSITIONS = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['EXTRACTED', 'FAILED'],
  EXTRACTED: ['PENDING', 'POSTED'],
  FAILED: ['PENDING'],
  POSTED: [],
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
}

export interface ApFlowExtraction {
  id: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // 'YYYY-MM-DD'
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
}

export interface ApFlowDocumentDetail extends ApFlowDocumentRecord {
  pages: ApFlowPage[];
  extraction: ApFlowExtraction | null;
  lineItems: ApFlowLineItemRecord[];
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
