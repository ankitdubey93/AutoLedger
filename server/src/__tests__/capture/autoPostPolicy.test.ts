import { describe, expect, it } from 'vitest';
import { evaluateAutoPost } from '../../services/capture/autoPostPolicy.js';
import type { AutoPostCandidate } from '../../services/capture/autoPostPolicy.js';
import type { CaptureSettings } from '../../types/capture.js';

/**
 * Pure policy function, no database, no network. Every gate is checked
 * (not short-circuited) except AUTO_POST_DISABLED, which is exclusive.
 */

function clean(): AutoPostCandidate {
  return {
    vendorName: 'Acme',
    invoiceNumber: 'A-1',
    invoiceDate: '2026-08-15',
    currency: 'USD',
    baseCurrency: 'USD',
    totalCents: 10000,
    arithmeticOk: true,
    fieldConfidence: {
      vendor_name: 0.99,
      invoice_number: 0.99,
      invoice_date: 0.99,
      total: 0.99,
    },
    lineItems: [{ amountCents: 10000, accountId: 'acc-1', mappingSource: 'HISTORY', mappingConfidence: 0.65 }],
  };
}

const enabledSettings: CaptureSettings = {
  autoPostEnabled: true,
  autoPostMinConfidence: 0.9,
  autoPostMaxTotalCents: null,
  updatedAt: null,
};

describe('evaluateAutoPost', () => {
  it('disabled returns only AUTO_POST_DISABLED', () => {
    const blockers = evaluateAutoPost(clean(), { ...enabledSettings, autoPostEnabled: false });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.code).toBe('AUTO_POST_DISABLED');
  });

  it('a clean HISTORY-mapped document has no blockers', () => {
    expect(evaluateAutoPost(clean(), enabledSettings)).toEqual([]);
  });

  it('camelCase field_confidence keys are honoured', () => {
    // The policy only reads the snake_case keys the extractor writes; this
    // proves a stray camelCase key does not accidentally satisfy the gate.
    const candidate = clean();
    candidate.fieldConfidence = { vendorName: 0.99, invoiceNumber: 0.99, invoiceDate: 0.99, total: 0.99 };
    const blockers = evaluateAutoPost(candidate, enabledSettings);
    expect(blockers.some((b) => b.code === 'LOW_FIELD_CONFIDENCE')).toBe(true);
  });

  it('a missing confidence key counts as zero', () => {
    const candidate = clean();
    delete candidate.fieldConfidence.total;
    const blockers = evaluateAutoPost(candidate, enabledSettings);
    const blocker = blockers.find((b) => b.code === 'LOW_FIELD_CONFIDENCE');
    expect(blocker?.message).toBe('Low extraction confidence on: total');
  });

  it('MODEL mapping below threshold blocks, HISTORY below threshold does not', () => {
    const candidate = clean();
    candidate.lineItems = [
      { amountCents: 5000, accountId: 'acc-1', mappingSource: 'MODEL', mappingConfidence: 0.8 },
      { amountCents: 5000, accountId: 'acc-2', mappingSource: 'HISTORY', mappingConfidence: 0.65 },
    ];
    const blockers = evaluateAutoPost(candidate, enabledSettings);
    const blocker = blockers.find((b) => b.code === 'LOW_MAPPING_CONFIDENCE');
    expect(blocker?.message).toBe('1 line item(s) were mapped below the confidence threshold');
  });

  it('ABOVE_AMOUNT_LIMIT when the total exceeds the limit', () => {
    const blockers = evaluateAutoPost(clean(), { ...enabledSettings, autoPostMaxTotalCents: 9999 });
    expect(blockers.map((b) => b.code)).toContain('ABOVE_AMOUNT_LIMIT');
  });

  it('FOREIGN_CURRENCY_WITH_LIMIT when a limit is set and the currency differs', () => {
    const candidate = clean();
    candidate.currency = 'EUR';
    const blockers = evaluateAutoPost(candidate, { ...enabledSettings, autoPostMaxTotalCents: 1 });
    expect(blockers.map((b) => b.code)).toContain('FOREIGN_CURRENCY_WITH_LIMIT');
    expect(blockers.map((b) => b.code)).not.toContain('ABOVE_AMOUNT_LIMIT');
  });

  it('every failing gate is reported, not just the first', () => {
    const candidate = clean();
    candidate.vendorName = null;
    candidate.invoiceNumber = null;
    candidate.arithmeticOk = false;
    const blockers = evaluateAutoPost(candidate, enabledSettings);
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain('ARITHMETIC_MISMATCH');
    expect(codes).toContain('MISSING_VENDOR_NAME');
    expect(codes).toContain('MISSING_INVOICE_NUMBER');
  });
});
