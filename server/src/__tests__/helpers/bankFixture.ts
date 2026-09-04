import type { loginAgent } from './factories.js';

/**
 * A deterministic 100-line bank statement fixture for proving the
 * confidence-matching engine has no false auto-reconciles (docs/ledger-core.md
 * § C acceptance criterion). No `Math.random`, no `Date.now` — every value
 * is derived from the loop index.
 *
 * Unlike the plan's originally sketched signature (a pure, synchronous
 * `csv`-and-index-map builder), this creates 40 real ISSUED invoices via the
 * API first — a bank line's "true match" is only meaningful against a real
 * invoice id, and invoice numbers are server-allocated (gapless numbering),
 * not predictable ahead of time. The correlation key is each true-match
 * line's `description` (unique per invoice, since it embeds the invoice's
 * server-assigned number) rather than a positional index, because the
 * database does not guarantee bank lines come back from a query in CSV
 * upload order.
 *
 * 40 lines are exact matches (same amount, same date, invoice number in the
 * memo) — every one of these must score >= AUTO_MATCH_THRESHOLD. 30 are
 * near-misses against a real invoice (half off by one cent, half dated 10
 * days away with no reference in the memo) — these must never reach the
 * threshold. 30 are pure noise (unrelated withdrawals, negative amounts, so
 * they are never even scored against an invoice at all).
 */

type Agent = Awaited<ReturnType<typeof loginAgent>>;

export interface HundredLineFixture {
  csv: string;
  /** True-match line description -> the invoice id it truly belongs to. */
  trueMatchByDescription: Map<string, string>;
}

const BASE_DATE = '2026-06-01';

function isoPlusDays(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number);
  const t = Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days);
  return new Date(t).toISOString().slice(0, 10);
}

export async function buildHundredLineStatement(
  agent: Agent,
  customerId: string,
  revenueAccountId: string,
): Promise<HundredLineFixture> {
  interface SeededInvoice {
    id: string;
    invoiceNumber: string;
    amountCents: number;
    issueDate: string;
  }

  const invoices: SeededInvoice[] = [];

  for (let i = 0; i < 40; i++) {
    const amountCents = 10000 + i * 137;
    const issueDate = isoPlusDays(BASE_DATE, i % 25);
    const created = await agent.post('/api/v1/ledger-core/invoices').send({
      customerId,
      issueDate,
      dueDate: isoPlusDays(issueDate, 30),
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Consulting',
          quantityMilli: 1000,
          unitPriceCents: amountCents,
          revenueAccountId,
          taxRateBp: 0,
        },
      ],
    });
    const invoiceId = created.body.invoice.id as string;
    const issued = await agent.post(`/api/v1/ledger-core/invoices/${invoiceId}/issue`).send({});
    const invoiceNumber = issued.body.invoice.invoiceNumber as string;
    invoices.push({ id: invoiceId, invoiceNumber, amountCents, issueDate });
  }

  const trueMatchByDescription = new Map<string, string>();
  const lines: string[] = [];

  // 40 exact matches.
  for (const inv of invoices) {
    const description = `PAYMENT RECEIVED ${inv.invoiceNumber}`;
    lines.push([inv.issueDate, description, (inv.amountCents / 100).toFixed(2)].join(','));
    trueMatchByDescription.set(description, inv.id);
  }

  // 15 near-misses: amount off by one cent, same date, reference in the memo.
  for (let i = 0; i < 15; i++) {
    const inv = invoices[i];
    if (inv === undefined) throw new Error('fixture: missing invoice');
    const description = `PMT ${inv.invoiceNumber}`;
    const amount = ((inv.amountCents + 1) / 100).toFixed(2);
    lines.push([inv.issueDate, description, amount].join(','));
  }

  // 15 near-misses: correct amount, date 10 days off, no reference in the memo.
  for (let i = 15; i < 30; i++) {
    const inv = invoices[i];
    if (inv === undefined) throw new Error('fixture: missing invoice');
    const description = `Faster payment ${String(i)}`;
    const amount = (inv.amountCents / 100).toFixed(2);
    const wrongDate = isoPlusDays(inv.issueDate, 10);
    lines.push([wrongDate, description, amount].join(','));
  }

  // 30 pure noise: unrelated withdrawals, negative amounts, never candidates
  // for an invoice match at all (only a positive line is scored against
  // invoices — see bankMatchService.generateSuggestionsOnClient).
  const noiseDescriptions = ['ATM WITHDRAWAL', 'CARD PAYMENT TESCO', 'MONTHLY BANK FEE', 'DIRECT DEBIT INSURANCE'];
  for (let i = 0; i < 30; i++) {
    const description = `${noiseDescriptions[i % noiseDescriptions.length]} ${String(i)}`;
    const amount = (-(1500 + i * 311) / 100).toFixed(2);
    lines.push([isoPlusDays(BASE_DATE, i % 20), description, amount].join(','));
  }

  const csv = ['Date,Description,Amount', ...lines].join('\n');
  return { csv, trueMatchByDescription };
}
