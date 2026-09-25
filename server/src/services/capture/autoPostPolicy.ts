import type { CaptureAutoPostBlocker, CaptureMappingSource, CaptureSettings } from '../../types/capture.js';

/**
 * Capture's auto-post gate (Phase 19) — pure, no database, no network.
 * Every gate is evaluated (not short-circuited) except the disabled switch,
 * so a reviewer reading `autoPostBlockers` sees the complete picture in one
 * read rather than fixing one problem only to discover the next.
 */

export interface AutoPostCandidateLineItem {
  amountCents: number;
  accountId: string | null;
  mappingSource: CaptureMappingSource;
  mappingConfidence: number | null;
}

export interface AutoPostCandidate {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  baseCurrency: string;
  totalCents: number | null;
  arithmeticOk: boolean;
  fieldConfidence: Record<string, number>;
  lineItems: AutoPostCandidateLineItem[];
}

/** [snake_case field_confidence key, camelCase name for the message]. */
const CONFIDENCE_FIELDS: readonly [string, string][] = [
  ['vendor_name', 'vendorName'],
  ['invoice_number', 'invoiceNumber'],
  ['invoice_date', 'invoiceDate'],
  ['total', 'total'],
];

export function evaluateAutoPost(candidate: AutoPostCandidate, settings: CaptureSettings): CaptureAutoPostBlocker[] {
  if (!settings.autoPostEnabled) {
    return [{ code: 'AUTO_POST_DISABLED', message: 'Auto-posting is turned off for this organization' }];
  }

  const blockers: CaptureAutoPostBlocker[] = [];

  if (!candidate.arithmeticOk) {
    blockers.push({ code: 'ARITHMETIC_MISMATCH', message: 'Extraction totals do not reconcile' });
  }
  if (candidate.vendorName === null || candidate.vendorName.trim() === '') {
    blockers.push({ code: 'MISSING_VENDOR_NAME', message: 'No vendor name was extracted' });
  }
  if (candidate.invoiceNumber === null || candidate.invoiceNumber.trim() === '') {
    blockers.push({ code: 'MISSING_INVOICE_NUMBER', message: 'No invoice number was extracted' });
  }
  if (candidate.invoiceDate === null) {
    blockers.push({ code: 'MISSING_INVOICE_DATE', message: 'No invoice date was extracted' });
  }
  if (candidate.totalCents === null || candidate.totalCents <= 0) {
    blockers.push({ code: 'NON_POSITIVE_TOTAL', message: 'The total is missing or not positive' });
  }
  if (candidate.lineItems.length === 0) {
    blockers.push({ code: 'NO_LINE_ITEMS', message: 'No line items were extracted' });
  }

  const unmappedCount = candidate.lineItems.filter((item) => item.accountId === null).length;
  if (unmappedCount > 0) {
    blockers.push({ code: 'UNMAPPED_LINE', message: `${String(unmappedCount)} line item(s) have no account` });
  }

  if (candidate.lineItems.some((item) => item.amountCents < 0)) {
    blockers.push({ code: 'NEGATIVE_LINE_AMOUNT', message: 'A line item has a negative amount' });
  }

  const lowConfidenceFields = CONFIDENCE_FIELDS.filter(
    ([snake]) => (candidate.fieldConfidence[snake] ?? 0) < settings.autoPostMinConfidence,
  ).map(([snake]) => snake);
  if (lowConfidenceFields.length > 0) {
    blockers.push({
      code: 'LOW_FIELD_CONFIDENCE',
      message: `Low extraction confidence on: ${lowConfidenceFields.join(', ')}`,
    });
  }

  const lowMappingCount = candidate.lineItems.filter(
    (item) =>
      (item.mappingSource === 'CHART' || item.mappingSource === 'MODEL') &&
      (item.mappingConfidence ?? 0) < settings.autoPostMinConfidence,
  ).length;
  if (lowMappingCount > 0) {
    blockers.push({
      code: 'LOW_MAPPING_CONFIDENCE',
      message: `${String(lowMappingCount)} line item(s) were mapped below the confidence threshold`,
    });
  }

  if (settings.autoPostMaxTotalCents !== null) {
    const documentCurrency = candidate.currency ?? candidate.baseCurrency;
    if (documentCurrency !== candidate.baseCurrency) {
      blockers.push({
        code: 'FOREIGN_CURRENCY_WITH_LIMIT',
        message: 'An amount limit is set and this document is not in the base currency',
      });
    } else if (candidate.totalCents !== null && candidate.totalCents > settings.autoPostMaxTotalCents) {
      blockers.push({ code: 'ABOVE_AMOUNT_LIMIT', message: 'The total is above the auto-post limit' });
    }
  }

  return blockers;
}
