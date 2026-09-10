/**
 * AP-Flow (Phase 10) — capture & extraction. This file mirrors
 * `types/ledger-core.ts`'s FSM-table shape: one transition table in code,
 * a matching CHECK constraint in the migration.
 */

export const AP_FLOW_DOCUMENT_STATUSES = ['PENDING', 'PROCESSING', 'EXTRACTED', 'FAILED'] as const;
export type ApFlowDocumentStatus = (typeof AP_FLOW_DOCUMENT_STATUSES)[number];

export function isApFlowDocumentStatus(value: string): value is ApFlowDocumentStatus {
  return (AP_FLOW_DOCUMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * PENDING -> PROCESSING -> EXTRACTED | FAILED, with two re-entry edges.
 * Nothing here is terminal, deliberately: Phase 10 posts nothing, so
 * re-running extraction destroys no financial fact. Phase 11 adds the
 * states that ARE terminal, because they post.
 */
export const AP_FLOW_DOCUMENT_TRANSITIONS = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['EXTRACTED', 'FAILED'],
  EXTRACTED: ['PENDING'],
  FAILED: ['PENDING'],
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
}

export interface ApFlowDocumentDetail extends ApFlowDocumentRecord {
  pages: ApFlowPage[];
  extraction: ApFlowExtraction | null;
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
