import * as organizationService from '../organizationService.js';
import * as accountService from './accountService.js';
import * as customerService from './customerService.js';
import * as vendorService from './vendorService.js';
import * as invoiceService from './invoiceService.js';
import * as billService from './billService.js';
import * as paymentService from './paymentService.js';
import * as fxRateService from './fxRateService.js';
import * as bankImportService from './bankImportService.js';
import * as bankMatchService from './bankMatchService.js';
import * as fiscalPeriodService from './fiscalPeriodService.js';
import * as settingsService from './settingsService.js';
import { ApiError } from '../../utils/apiError.js';
import { parseMoneyText, formatCents, cents } from '../../utils/money.js';
import { loadFixture, addDays } from '../sandbox/sandboxManifest.js';
import type { SandboxSeedContext, SandboxCounts } from '../../types/sandbox.js';
import {
  customersFixtureSchema,
  vendorsFixtureSchema,
  accountsFixtureSchema,
  fxRatesFixtureSchema,
  bankImportFixtureSchema,
  type BankImportFixture,
} from '../../schemas/sandboxSchema.js';

/**
 * Phase 18 — LedgerCore's sandbox seeder.
 *
 * This file imports ONLY services under `services/ledger-core/` plus the two
 * platform services every LedgerCore module already depends on
 * (`organizationService`, and — transitively, inside `settingsService` — the
 * onboarding completer). It contains NO SQL: every write goes through the
 * same service functions the controllers call, so the balance trigger, the
 * posted-row immutability triggers, every FSM and the CDC audit trail all
 * fire for real (guardrails rules 1, 2, 16).
 *
 * Order matters and is NOT arbitrary:
 *   1. settings (completes onboarding, sets the base currency)
 *   2. extra revenue accounts
 *   3. customers, vendors
 *   4. FX rates — BEFORE any invoice, because issueInvoice resolves a rate at
 *      the invoice date and fails without one
 *   5. invoices, bills (posts into open periods — none exist yet, and a date
 *      covered by no period is open, migration 016's own documented rule)
 *   6. payments
 *   7. the bank statement import, built from the payments just created
 *   8. fiscal periods, generated and closed LAST — migration 016 refuses any
 *      posting into a CLOSED or LOCKED period, so periods must not exist
 *      until every posting above has already landed
 *
 * Getting this order wrong fails loudly (a real ApiError from a real
 * service), which is correct — the fix is to reorder this file, never to
 * relax a fixture or bypass a guard.
 */

const ORG_NAME_FALLBACK = 'Sandbox Organization';

async function seedSettings(ctx: SandboxSeedContext, baseCurrency: string): Promise<void> {
  const org = await organizationService.getById(ctx.orgId);
  const accounts = await accountService.listAccounts(ctx.orgId);
  const cashAccount = accounts.find((a) => a.code === '1110');
  if (cashAccount === undefined) {
    throw new Error('sandboxSeed: default chart account 1110 (Operating Cash) not found');
  }

  await settingsService.completeOnboarding(ctx.orgId, {
    organizationName: org.name.trim() === '' ? ORG_NAME_FALLBACK : org.name,
    legalName: null,
    baseCurrency,
    fiscalYearStartMonth: 1,
    fiscalYearStartDay: 1,
    booksStartDate: ctx.monthDate(-23, 1),
    industry: 'Services',
    timezone: 'UTC',
    cashAccountId: cashAccount.id,
  });
}

async function seedAccounts(ctx: SandboxSeedContext): Promise<Map<string, string>> {
  const fixture = await loadFixture('ledger-core/accounts.json', accountsFixtureSchema);
  const byCode = new Map<string, string>();

  const existing = await accountService.listAccounts(ctx.orgId);
  for (const a of existing) byCode.set(a.code, a.id);

  for (const row of fixture.accounts) {
    const parent = byCode.get(row.parentCode);
    if (parent === undefined) {
      throw new Error(`sandboxSeed: parent account ${row.parentCode} not found for ${row.code}`);
    }
    const created = await accountService.createAccount(ctx.orgId, ctx.userId, {
      code: row.code,
      name: row.name,
      type: row.type,
      parentId: parent,
      isPostable: row.isPostable,
      description: null,
    });
    byCode.set(created.code, created.id);
  }

  return byCode;
}

export interface LedgerCoreSeedResult {
  counts: Partial<SandboxCounts>;
  /** Handed to the ap-flow, forecaster, fpa-engine, unitecon and boarddeck seeders. */
  accountsByCode: Map<string, string>;
  customerIdsByKey: Map<string, string>;
  vendorIdsByKey: Map<string, string>;
}

/**
 * Refuses BEFORE anything is written if this organization already carries a
 * previous seed. Without it, the first thing to notice is
 * `accountService.createAccount`'s own `409 Account code already exists` —
 * a leaky internal cause, raised only after `completeOnboarding` has already
 * mutated settings, and one that tells the caller nothing about the real
 * problem. The sentinel is one of the two revenue accounts this seeder adds
 * on top of the default chart (`accounts.json`), so its presence means a
 * prior load got at least that far.
 *
 * The check lives HERE, in LedgerCore's own seeder, rather than in the
 * platform orchestrator: knowing what a seeded LedgerCore looks like is
 * LedgerCore's business, and the orchestrator queries no app's tables
 * (guardrails rule 16).
 */
async function assertNotAlreadySeeded(ctx: SandboxSeedContext): Promise<void> {
  const existing = await accountService.listAccounts(ctx.orgId);
  if (existing.some((a) => a.code === '4300')) {
    throw new ApiError(
      409,
      'This organization already contains sample data. Seeded financial records cannot be removed (posted documents are immutable) — load the dataset into a fresh organization instead.',
    );
  }
}

export async function seedSandbox(
  ctx: SandboxSeedContext,
  baseCurrency: string,
): Promise<LedgerCoreSeedResult> {
  await assertNotAlreadySeeded(ctx);
  await seedSettings(ctx, baseCurrency);
  const accountsByCode = await seedAccounts(ctx);

  // --- FX rates, before any invoice or bill is issued/approved ---
  const rates = await loadFixture('ledger-core/fx-rates.json', fxRatesFixtureSchema);
  for (const r of rates.rates) {
    await fxRateService.upsertRate(ctx.orgId, ctx.userId, {
      fromCode: r.fromCode,
      toCode: r.toCode,
      rateDate: ctx.monthDate(r.monthOffset, 1),
      rate: r.rate,
      source: 'MANUAL',
    });
  }

  // --- customers, then their invoices ---
  const customersFixture = await loadFixture('ledger-core/customers.json', customersFixtureSchema);
  const customerIdsByKey = new Map<string, string>();
  let invoiceCount = 0;

  for (const c of customersFixture.customers) {
    const customer = await customerService.createCustomer(ctx.orgId, ctx.userId, {
      name: c.name,
      email: c.email,
      phone: c.phone,
      billingAddress: c.billingAddress,
      taxNumber: c.taxNumber,
      notes: c.notes,
    });
    customerIdsByKey.set(c.key, customer.id);

    const revenueAccountId = accountsByCode.get(c.revenueAccount);
    if (revenueAccountId === undefined) {
      throw new Error(`sandboxSeed: revenue account ${c.revenueAccount} not found for customer ${c.key}`);
    }

    for (let i = 0; i < c.monthly.length; i++) {
      const monthOffset = c.cohortOffset + i;
      const amountText = c.monthly[i];
      if (amountText === undefined) continue;
      const netCents = parseMoneyText(amountText);
      const issueDate = ctx.monthDate(monthOffset, 5);
      const dueDate = addDays(issueDate, c.paysInDays);

      // Acme's final invoice (monthOffset 0, inside the most recent 4
      // periods that are left OPEN below) is left DRAFT rather than issued,
      // so that open period's close run has a real NO_DRAFT_INVOICES
      // failure to report — the BLOCKED case a demo needs alongside READY.
      const isDraftCandidate = c.key === 'acme' && monthOffset === 0;

      const invoice = await invoiceService.createInvoice(ctx.orgId, ctx.userId, {
        customerId: customer.id,
        issueDate,
        dueDate,
        currencyCode: c.currency === baseCurrency ? undefined : c.currency,
        notes: null,
        paymentTerms: `Net ${String(c.paysInDays)}`,
        lines: [
          {
            description: `${c.name} — monthly services`,
            quantityMilli: 1000,
            unitPriceCents: netCents,
            revenueAccountId,
            taxRateBp: c.taxRateBp,
          },
        ],
      });

      if (!isDraftCandidate) {
        await invoiceService.issueInvoice(ctx.orgId, ctx.userId, invoice.id, issueDate);
      }
      invoiceCount += 1;
    }
  }

  // --- vendors, then their bills ---
  const vendorsFixture = await loadFixture('ledger-core/vendors.json', vendorsFixtureSchema);
  const vendorIdsByKey = new Map<string, string>();
  let billCount = 0;

  for (const v of vendorsFixture.vendors) {
    const vendor = await vendorService.createVendor(ctx.orgId, ctx.userId, {
      name: v.name,
      email: v.email,
      phone: v.phone,
      billingAddress: v.address,
      taxNumber: v.taxNumber,
      paymentTerms: `Net ${String(v.paysInDays)}`,
      notes: v.description,
    });
    vendorIdsByKey.set(v.key, vendor.id);

    const expenseAccountId = accountsByCode.get(v.expenseAccount);
    if (expenseAccountId === undefined) {
      throw new Error(`sandboxSeed: expense account ${v.expenseAccount} not found for vendor ${v.key}`);
    }

    for (let i = 0; i < v.monthly.length; i++) {
      const monthOffset = v.startOffset + i;
      const amountText = v.monthly[i];
      if (amountText === undefined) continue;
      const netCents = parseMoneyText(amountText);
      const billDate = ctx.monthDate(monthOffset, 20);
      const dueDate = addDays(billDate, v.paysInDays);

      const bill = await billService.createBill(ctx.orgId, ctx.userId, {
        vendorId: vendor.id,
        vendorReference: `${v.key.toUpperCase()}-${String(monthOffset).padStart(3, '0')}`,
        billDate,
        dueDate,
        currencyCode: undefined,
        notes: null,
        paymentTerms: `Net ${String(v.paysInDays)}`,
        lines: [
          {
            description: v.description,
            quantityMilli: 1000,
            unitPriceCents: netCents,
            expenseAccountId,
            taxRateBp: v.taxRateBp,
          },
        ],
      });

      const leaveUnapproved =
        v.leaveUnapprovedFromOffset !== null && monthOffset >= v.leaveUnapprovedFromOffset;

      await billService.submitBill(ctx.orgId, bill.id);
      if (!leaveUnapproved) {
        await billService.approveBill(ctx.orgId, ctx.userId, bill.id, billDate);
      }
      billCount += 1;
    }
  }

  // --- payments: settle everything OLDER than the bank-reconciliation
  // window directly (ordinary recorded payments); everything from that
  // window on stays open FOR bank reconciliation to discover below ---
  let paymentCount = 0;
  const cashAccountId = accountsByCode.get('1110');
  if (cashAccountId === undefined) throw new Error('sandboxSeed: 1110 not found');

  const invoices = await invoiceService.listInvoices(ctx.orgId, {
    page: 1,
    limit: 500,
    status: 'ISSUED',
    customerId: null,
    from: null,
    to: null,
    q: null,
    settlement: null,
  });
  let partialSeen = false;
  for (const inv of invoices.invoices) {
    // Leave everything from offset -1 on unpaid — that is exactly the
    // population the bank-reconciliation step below is built to discover
    // and settle through a real match, not a direct payment. Paying it here
    // too would leave nothing open for bankMatchService's candidate query
    // (`amount_due_cents > 0`) to find, which is precisely the bug this
    // comment now records rather than repeats.
    if (inv.issueDate >= ctx.monthDate(-1, 1)) continue;
    if (inv.invoiceNumber === null) continue; // DRAFT — no number allocated, nothing to pay
    // Pay exactly one older invoice partially so the settlement status has
    // all three states represented (paid, partial, outstanding) somewhere
    // in the dataset's history, not only in the reconciliation window.
    const isPartial = !partialSeen && inv.customerNameSnapshot === 'Acme Manufacturing Co';
    if (isPartial) partialSeen = true;
    const amountCents = isPartial ? Math.round(inv.totalCents * 0.6) : inv.totalCents;

    await paymentService.createPayment(ctx.orgId, ctx.userId, {
      direction: 'RECEIVE',
      paymentDate: addDays(inv.issueDate, 14),
      amountCents,
      currencyCode: inv.currencyCode === baseCurrency ? undefined : inv.currencyCode,
      cashAccountId,
      customerId: inv.customerId,
      vendorId: null,
      method: 'ACH',
      reference: inv.invoiceNumber,
      notes: null,
      allocations: [{ invoiceId: inv.id, billId: null, amountCents }],
      entryDate: addDays(inv.issueDate, 14),
    });
    paymentCount += 1;
  }

  const bills = await billService.listBills(ctx.orgId, {
    page: 1,
    limit: 500,
    status: 'POSTED',
    vendorId: null,
    from: null,
    to: null,
    q: null,
    settlement: null,
  });
  for (const bill of bills.bills) {
    if (bill.billDate >= ctx.monthDate(-1, 1)) continue;
    await paymentService.createPayment(ctx.orgId, ctx.userId, {
      direction: 'PAY',
      paymentDate: addDays(bill.billDate, 10),
      amountCents: bill.totalCents,
      currencyCode: undefined,
      cashAccountId,
      customerId: null,
      vendorId: bill.vendorId,
      method: 'ACH',
      reference: bill.vendorReference,
      notes: null,
      allocations: [{ invoiceId: null, billId: bill.id, amountCents: bill.totalCents }],
      entryDate: addDays(bill.billDate, 10),
    });
    paymentCount += 1;
  }

  // --- bank statement import, built from the invoices/bills LEFT OPEN
  // above, and then reconciled for real: bankMatchService's own candidate
  // query only ever considers a document with amount_due_cents > 0
  // (bankMatchService.ts), so a bank line built from an already-settled
  // payment has nothing left to match against — this is what the loops
  // above are careful to avoid. ---
  const bankPolicy = await loadFixture('ledger-core/bank-import.json', bankImportFixtureSchema);
  // Date-bounded to the reconciliation window itself, not just filtered by
  // settlement status: Acme's deliberately-partial older invoice (above)
  // still has amount_due_cents > 0, so "OUTSTANDING" alone would sweep a
  // months-old partial invoice into this month's bank statement alongside
  // the invoices actually meant to be discovered by it.
  const reconciliationFrom = ctx.monthDate(-1, 1);
  const openInvoices = await invoiceService.listInvoices(ctx.orgId, {
    page: 1,
    limit: 500,
    status: null,
    customerId: null,
    from: reconciliationFrom,
    to: null,
    q: null,
    settlement: 'OUTSTANDING',
  });
  const openBills = await billService.listBills(ctx.orgId, {
    page: 1,
    limit: 500,
    status: null,
    vendorId: null,
    from: reconciliationFrom,
    to: null,
    q: null,
    settlement: 'OUTSTANDING',
  });
  const csv = buildBankStatementCsv(ctx, bankPolicy, openInvoices.invoices, openBills.bills);
  const importResult = await bankImportService.importStatement(ctx.orgId, ctx.userId, {
    accountId: cashAccountId,
    fileName: bankPolicy.fileName,
    content: csv,
    dateFormat: bankPolicy.dateFormat,
    columnMap: null,
    closingBalanceCents: null,
    closingBalanceOn: null,
  });

  // Auto-confirm every line whose top suggestion clears the threshold — the
  // real one-click-accept a reviewer would take, executed here so the
  // "exact" mirrored lines actually become payments through the real
  // reconciliation flow rather than staying suggestions forever. Anything
  // below the threshold (the deliberately perturbed lines, plus the pure
  // noise lines with no suggestion at all) is left UNMATCHED for the
  // approval queue.
  const { transactions: importedLines } = await bankMatchService.listTransactions(ctx.orgId, {
    page: 1,
    limit: 500,
    accountId: cashAccountId,
    importId: importResult.import.id,
    status: 'UNMATCHED',
    from: null,
    to: null,
    q: null,
    minScore: null,
  });
  for (const line of importedLines) {
    const top = [...line.suggestions].sort((a, b) => b.score - a.score)[0];
    if (top !== undefined && top.autoMatchable) {
      await bankMatchService.matchTransaction(ctx.orgId, ctx.userId, line.id, {
        suggestionId: top.id,
        invoiceId: null,
        billId: null,
      });
      paymentCount += 1;
    }
  }

  // --- fiscal periods, LAST: generatePeriods works one fiscal year at a
  // time, keyed by a containing date, and always creates the WHOLE fiscal
  // year containing that date — not just the one month asked for. Calling
  // it once per month across a 24-month window that spans 3 calendar years
  // (e.g. Oct 2024..Sep 2026) therefore also creates every OTHER month of
  // each of those 3 fiscal years — Jan..Sep 2024 and Oct..Dec 2026, months
  // with no invoices, bills or payments in them at all. That inflated list
  // must not be sorted-and-sliced directly: "the most recent 4" by array
  // position would then land on empty future months (e.g. Oct-Dec 2026)
  // instead of the dataset's real last 4 months, closing a month that
  // actually holds seeded postings and leaving an empty one open.
  for (let offset = -23; offset <= 0; offset++) {
    await fiscalPeriodService.generatePeriods(ctx.orgId, ctx.userId, ctx.monthDate(offset, 15));
  }
  const allPeriods = await fiscalPeriodService.listPeriods(ctx.orgId, {
    fiscalYearLabel: null,
    status: null,
  });
  const rangeStart = ctx.monthDate(-23, 1);
  const rangeEnd = ctx.monthDate(0, 28);
  // 'YYYY-MM-DD' sorts lexically identically to chronologically, so a plain
  // string comparison is exact here.
  const inRange = allPeriods.filter((p) => p.startsOn >= rangeStart && p.startsOn <= rangeEnd);
  const sorted = [...inRange].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  // Leave the most recent 4 REAL months OPEN — any period generatePeriods
  // created outside the dataset's own range is simply left at its default
  // OPEN status, untouched by this loop. One of the 4 open months already
  // holds the DRAFT invoice and the unmatched bank noise lines, so its close
  // run reports BLOCKED while an earlier, closed month reports READY.
  const toClose = sorted.slice(0, Math.max(0, sorted.length - 4));
  for (const period of toClose) {
    await fiscalPeriodService.closePeriod(ctx.orgId, ctx.userId, period.id);
  }
  const oldest = toClose[0];
  if (oldest !== undefined) {
    await fiscalPeriodService.lockPeriod(ctx.orgId, ctx.userId, oldest.id);
  }

  return {
    counts: {
      customers: customerIdsByKey.size,
      vendors: vendorIdsByKey.size,
      invoices: invoiceCount,
      bills: billCount,
      payments: paymentCount,
      bankLines: importResult.importedCount,
    },
    accountsByCode,
    customerIdsByKey,
    vendorIdsByKey,
  };
}

/**
 * Builds the bank statement CSV from real seeded payments per
 * `bank-import.json`'s policy — never from hard-coded amounts, which could
 * never score against payments computed at seed time. `exactFraction` of
 * payments in the import window are mirrored verbatim (a high match score);
 * the rest have their date shifted and description roughened (a low score,
 * left for the approval queue); `noiseLines` are ordinary bank traffic with
 * no ledger counterpart at all.
 */
/**
 * Builds the statement CSV from invoices/bills LEFT OPEN by the seeder
 * above — never from an already-created payment, which would have nothing
 * left for `bankMatchService`'s own candidate query to find (its own
 * `amount_due_cents > 0` predicate excludes anything already settled). An
 * "exact" line mirrors the real due date and includes the counterparty's
 * name, clearing the auto-match threshold on amount + date + counterparty;
 * a "perturbed" line shifts the date and drops the identifying name,
 * landing below it and leaving a real item for the approval queue.
 */
function buildBankStatementCsv(
  ctx: SandboxSeedContext,
  policy: BankImportFixture,
  openInvoices: readonly { invoiceNumber: string | null; issueDate: string; totalCents: number; customerNameSnapshot: string }[],
  openBills: readonly { vendorReference: string; billDate: string; totalCents: number; vendorNameSnapshot: string }[],
): string {
  const rows: { date: string; description: string; amount: string }[] = [];

  const receipts = openInvoices
    .filter((inv) => inv.invoiceNumber !== null)
    .map((inv) => ({
      date: inv.issueDate,
      reference: inv.invoiceNumber as string,
      counterparty: inv.customerNameSnapshot,
      signedCents: inv.totalCents,
    }));
  const disbursements = openBills.map((bill) => ({
    date: bill.billDate,
    reference: bill.vendorReference,
    counterparty: bill.vendorNameSnapshot,
    signedCents: -bill.totalCents,
  }));
  const relevant = [...receipts, ...disbursements];
  const exactCount = Math.round(relevant.length * policy.matching.exactFraction);

  relevant.forEach((r, i) => {
    const amount = formatCents(cents(r.signedCents));
    if (i < exactCount) {
      rows.push({
        date: r.date,
        description: `${r.signedCents >= 0 ? 'ACH CREDIT' : 'ACH DEBIT'} ${r.counterparty} ${r.reference}`,
        amount,
      });
    } else {
      const shifted = shiftDate(r.date, policy.matching.perturbed.dateShiftDays);
      rows.push({
        date: shifted,
        description: `PAYMENT PROCESSOR REF ${r.reference.slice(-4)}`,
        amount,
      });
    }
  });

  for (let offset = policy.window.fromMonthOffset; offset <= policy.window.toMonthOffset; offset++) {
    rows.push({
      date: ctx.monthDate(offset, 28),
      description: 'MONTHLY SERVICE FEE',
      amount: `-${policy.noiseLines.monthlyBankFee}`,
    });
    rows.push({
      date: ctx.monthDate(offset, 28),
      description: 'INTEREST EARNED',
      amount: policy.noiseLines.monthlyInterest,
    });
  }
  for (const extra of policy.noiseLines.extras) {
    rows.push({
      date: ctx.monthDate(extra.monthOffset, extra.day),
      description: extra.description,
      amount: extra.amount,
    });
  }

  const header = 'Date,Description,Amount';
  const lines = rows.map((r) => `${r.date},"${r.description.replace(/"/g, '""')}",${r.amount}`);
  return [header, ...lines].join('\n');
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
