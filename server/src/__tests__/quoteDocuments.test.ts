import { describe, expect, it } from 'vitest';
import { computeLineTotals, sumDocumentTotals } from '../utils/documentTotals.js';
import { renderEmail } from '../services/mail/templates.js';
import { canTransitionQuote, effectiveQuoteStatus, QUOTE_STATUSES } from '../types/accounting.js';

/**
 * Phase 41 — the pure pieces of quotes: the shared document totals every
 * priced document now uses, the quote FSM helpers, and the two quote emails
 * (escaping included). No database.
 */

describe('documentTotals', () => {
  it('computes tax per line, then sums — never on the subtotal', () => {
    // 3 × 0.33 at 10% = 0.99 net, 0.099 → 0.10 tax; a second line at 0%.
    const totals = computeLineTotals([
      { unitPriceCents: 33, quantityMilli: 3000, taxRateBp: 1000 },
      { unitPriceCents: 1000, quantityMilli: 1500, taxRateBp: 0 },
    ]);
    expect(totals.map((t) => [t.netCents, t.taxCents])).toEqual([
      [99, 10],
      [1500, 0],
    ]);
    expect(sumDocumentTotals(totals)).toEqual({ subtotalCents: 1599, taxCents: 10, totalCents: 1609 });
  });

  it('keeps the input line attached to its totals', () => {
    const line = { unitPriceCents: 100, quantityMilli: 1000, taxRateBp: 0, description: 'x' };
    expect(computeLineTotals([line])[0]?.input).toBe(line);
  });
});

describe('quote FSM helpers', () => {
  it('a draft only ever becomes SENT, and terminal statuses go nowhere', () => {
    for (const to of QUOTE_STATUSES) expect(canTransitionQuote('DRAFT', to)).toBe(to === 'SENT');
    for (const from of ['DECLINED', 'EXPIRED', 'VOID', 'SUPERSEDED'] as const) {
      for (const to of QUOTE_STATUSES) expect(canTransitionQuote(from, to)).toBe(false);
    }
  });

  it('a sent quote reads EXPIRED only after its valid-until day has passed', () => {
    expect(effectiveQuoteStatus('SENT', '2026-10-10', '2026-10-10')).toBe('SENT');
    expect(effectiveQuoteStatus('SENT', '2026-10-10', '2026-10-11')).toBe('EXPIRED');
    expect(effectiveQuoteStatus('ACCEPTED', '2026-10-10', '2026-12-01')).toBe('ACCEPTED');
  });
});

describe('quote emails', () => {
  it('quote_sent words a sales quote as a quote and escapes every value', () => {
    const email = renderEmail(
      'quote_sent',
      {
        organizationName: '<b>Org</b>',
        direction: 'SALES',
        quoteNumber: 'QU-000001',
        revision: 2,
        title: 'Fit-out',
        total: 'INR 230.00',
        validUntil: '2026-11-09',
        message: 'Hi <script>alert(1)</script>',
      },
      'https://app.example/quote/tok',
    );
    expect(email.subject).toBe('Quote QU-000001 (revision 2) from <b>Org</b>');
    expect(email.html).toContain('&lt;b&gt;Org&lt;/b&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('Review and accept');
    expect(email.text).toContain('https://app.example/quote/tok');
  });

  it('quote_sent words a purchase quote as a price confirmation', () => {
    const email = renderEmail(
      'quote_sent',
      { organizationName: 'Org', direction: 'PURCHASE', quoteNumber: 'PQ-000004', revision: 1, total: 'INR 1.00', validUntil: '2026-11-09' },
      'https://app.example/quote/tok',
    );
    expect(email.subject).toBe('Price confirmation request PQ-000004 from Org');
    expect(email.html).toContain('Review and confirm');
  });

  it('quote_responded names the signer on acceptance and the reason on decline', () => {
    const accepted = renderEmail(
      'quote_responded',
      { organizationName: 'Org', partyName: 'Acme', quoteNumber: 'QU-1', response: 'ACCEPTED', signerName: 'Jane', url: 'https://x' },
      null,
    );
    expect(accepted.subject).toBe('Quote QU-1 accepted — Acme');
    expect(accepted.text).toContain('signed by Jane');
    const declined = renderEmail(
      'quote_responded',
      { organizationName: 'Org', partyName: 'Acme', quoteNumber: 'QU-1', response: 'DECLINED', declineReason: 'Too dear', url: 'https://x' },
      null,
    );
    expect(declined.text).toContain('Reason given: Too dear');
  });
});
