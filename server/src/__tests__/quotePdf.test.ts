import { describe, it, expect } from 'vitest';
import { renderQuotePdf, type QuotePdfInput } from '../services/accounting/quotePdfRenderer.js';

function input(overrides: Partial<QuotePdfInput> = {}): QuotePdfInput {
  return {
    merchantName: 'Org Alpha',
    merchantAddressLines: ['1 Main St', 'Springfield'],
    logo: null,
    direction: 'SALES',
    quoteNumber: 'QU-000012',
    revision: 1,
    partyName: 'Acme Ltd',
    partyAddress: null,
    partyTaxNumber: null,
    partyReference: null,
    quoteDate: '2026-10-10',
    validUntil: '2026-11-09',
    currencyCode: 'USD',
    title: 'Website build',
    notes: null,
    terms: null,
    paymentTerms: null,
    depositPercentBp: null,
    lines: [{ description: 'Design', quantityMilli: 2000, unitPriceCents: 10000, taxRateBp: 1500, netCents: 20000 }],
    subtotalCents: 20000,
    taxCents: 3000,
    totalCents: 23000,
    ...overrides,
  };
}

/**
 * pdfkit writes text as hex strings inside TJ arrays, split at kerning pairs
 * (`[<51> 10 <554f>] TJ`). Decode each array back into its visible string so the
 * assertions read the page content, not the raw bytes.
 */
function visibleText(raw: string): string {
  const out: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let line = '';
    for (const h of (m[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)) line += Buffer.from(h[1] ?? '', 'hex').toString('latin1');
    out.push(line);
  }
  return out.join('\n');
}

async function raw(i: QuotePdfInput): Promise<string> {
  return (await renderQuotePdf(i, { compress: false })).toString('latin1');
}

async function text(i: QuotePdfInput): Promise<string> {
  return visibleText(await raw(i));
}

describe('renderQuotePdf', () => {
  it('starts with %PDF-', async () => {
    const buf = await renderQuotePdf(input());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('contains the quote number and total ("QU-000012", "230.00")', async () => {
    const out = await text(input());
    expect(out).toContain('QU-000012');
    expect(out).toContain('230.00');
  });

  it('a purchase quote is headed PURCHASE QUOTE', async () => {
    expect(await text(input({ direction: 'PURCHASE' }))).toContain('PURCHASE QUOTE');
  });

  it('200 lines produce more than one page ("/Type /Page" count > 1)', async () => {
    const lines = Array.from({ length: 200 }, (_, n) => ({
      description: `Line ${String(n + 1)}`,
      quantityMilli: 1000,
      unitPriceCents: 100,
      taxRateBp: 0,
      netCents: 100,
    }));
    const out = await raw(input({ lines, subtotalCents: 20000, taxCents: 0, totalCents: 20000 }));
    const pages = out.match(/\/Type \/Page(?![s\w])/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it('a draft (null number) renders "DRAFT"', async () => {
    expect(await text(input({ quoteNumber: null }))).toContain('DRAFT');
  });
});
