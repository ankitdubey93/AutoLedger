import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  WALKTHROUGH_DATASET,
  allVendors,
  documentLines,
  resolveTokens,
  type DatasetDocument,
  type DatasetNote,
  type DatasetOrder,
} from './walkthroughDataset.js';
import { resolveSettlementLines, type ResolvedSettlementLine } from './walkthroughTiers.js';
import { computeExpectedResults, type ExpectedMonth, type ExpectedStatementRow } from './walkthroughExpected.js';
import {
  WALKTHROUGH_MONTHS,
  parseAnchor,
  defaultAnchor,
  resolveDate,
  lastDayOfWalkthroughMonth,
  monthName,
  shiftIsoDate,
  daysBetweenIso,
  type AnchorMonth,
  type WalkthroughMonth,
} from './walkthroughDates.js';
import { money, statement1, statement2, statement3, statement4, statement5, statement6 } from './walkthroughStatements.js';
import { vendorsCsv, customersCsv } from './walkthroughParties.js';
import { accountsCsv, productsCsv, stockItemsCsv, invoicesCsv, billsCsv, payrollJournalCsv } from './walkthroughCsv.js';
import { parseMoneyText } from '../utils/money.js';

/**
 * `npm run walkthrough [-- --anchor YYYY-MM]` — writes `walkthrough/` at the
 * repo root: source documents an accountant would receive and enter by
 * hand, a vendor and a customer CSV imported through the Phase 24 party
 * importer, three bank statements in three different formats imported
 * through the Phase 6 bank importer, and a computed, service-verified
 * answer key.
 *
 * Deliberately not `fixtures/` and not seeded through the API here — this
 * folder is meant to be worked through by a human in the AutoLedger UI
 * (typing a bill or invoice in by hand, uploading a CSV through the
 * importer screens), and is committed as plain, reviewable files. The same
 * dataset is also replayed through the API by `walkthroughReplay.ts` — by the
 * answer-key test, and by `npm run seed:demo` to build the demo organization.
 */

// process.cwd() === server/ for every npm script, so the repo root is one level up.
const WALKTHROUGH_ROOT = path.resolve(process.cwd(), '..', 'walkthrough');

function outPath(...segments: string[]): string {
  return path.join(WALKTHROUGH_ROOT, ...segments);
}

function write(relativePath: string, content: string): void {
  const full = outPath(relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  console.log(`[walkthrough] wrote ${relativePath}`);
}

function customerName(key: string): string {
  const c = WALKTHROUGH_DATASET.customers.find((x) => x.key === key);
  if (c === undefined) throw new Error(`no customer ${key}`);
  return c.name;
}
function vendorName(key: string): string {
  const v = allVendors().find((x) => x.key === key);
  if (v === undefined) throw new Error(`no vendor ${key}`);
  return v.name;
}
function accountName(code: string): string {
  const extra = WALKTHROUGH_DATASET.extraAccounts.find((a) => a.code === code);
  if (extra !== undefined) return `${extra.code} ${extra.name}`;
  const DEFAULT_NAMES: Record<string, string> = {
    '4100': '4100 Product Revenue',
    '4200': '4200 Service Revenue',
    '4800': '4800 Sales Returns & Allowances',
    '5100': '5100 Direct Materials',
    '5300': '5300 Freight & Duty',
    '6110': '6110 Rent & Utilities',
    '6120': '6120 Software & IT Infrastructure',
    '6200': '6200 Professional Fees',
    '6400': '6400 Marketing & Advertising',
    '6600': '6600 Bank Fees',
    '3100': "3100 Common Stock / Owner's Capital",
    '1110': '1110 Operating Cash',
    '1120': '1120 Accounts Receivable',
    '2100': '2100 Accounts Payable',
    '1140': '1140 Inventory',
    '2120': '2120 Accrued Liabilities',
    '2130': '2130 Customer Deposits',
    '2160': '2160 Payroll Liabilities',
    '5050': '5050 Cost of Sales — Inventory',
    '5200': '5200 Direct Labor',
    '6100': '6100 Salaries & Wages',
  };
  const name = DEFAULT_NAMES[code];
  if (name === undefined) throw new Error(`no display name for account ${code}`);
  return name;
}

/** The bank, export format and file-name suffix of each month's statement. */
const STATEMENT_FORMAT: Record<WalkthroughMonth, string> = {
  1: 'northwind-ISO',
  2: 'meridian-DMY',
  3: 'cascade-MDY',
  4: 'northwind-ISO',
  5: 'northwind-ISO',
  6: 'meridian-DMY',
};

// ------------------------------------------------------------ markdown sheets

function renderVendors(): string {
  return (
    `# Vendors to import\n\n` +
    `All six vendors ship as one CSV, \`vendors.csv\`, imported through the customer/vendor migration importer ` +
    `(Phase 24) rather than typed in one at a time — the same importer a business migrating off another system ` +
    `would use for real. Payment terms: **Due on receipt** for all six.\n\n` +
    `**Accounting → Imports → New import.** Kind: **Vendors**. Upload \`vendors.csv\`, or paste its ` +
    `contents (shown below) into a new file and upload that. It should stage all 6 rows as \`VALID\` and the ` +
    `import should read \`VALIDATED\` — nothing here has a bad row. Preview, then Commit.\n\n` +
    "```csv\n" +
    vendorsCsv() +
    "```\n"
  );
}

function renderCustomers(): string {
  return (
    `# Customers to import\n\n` +
    `All six customers ship as one CSV, \`customers.csv\`, imported the same way as the vendors above.\n\n` +
    `**Accounting → Imports → New import.** Kind: **Customers**. Upload \`customers.csv\`, or paste its ` +
    `contents (shown below) into a new file and upload that. It should stage all 6 rows as \`VALID\` and the ` +
    `import should read \`VALIDATED\`. Preview, then Commit.\n\n` +
    "```csv\n" +
    customersCsv() +
    "```\n"
  );
}

/** Where a document in `04`/`05` actually comes from, when it is not typed in by hand. */
function provenanceLine(doc: DatasetDocument): string | null {
  const guide = doc.month === 5 ? '09-products-orders-and-stock.md' : '10-closing-the-quarter.md';
  switch (doc.entry ?? 'MANUAL') {
    case 'MANUAL':
      return null;
    case 'ORDER':
      return `Not typed in: raised from ${doc.orderRef ?? ''} — see \`${guide}\`.`;
    case 'DEPOSIT':
      return `Not typed in: raised from ${doc.orderRef ?? ''} with **Request deposit** — see \`${guide}\`.`;
    case 'IMPORT':
      return `Not typed in: arrives through \`${doc.ref.startsWith('I') ? 'invoices' : 'bills'}-month-${String(doc.month)}.csv\` — see \`${guide}\`.`;
    case 'RECURRING':
      return `Not typed in: generated by the recurring schedule made from B14 — see \`${guide}\`.`;
  }
}

function renderDocuments(anchor: AnchorMonth, docs: DatasetDocument[], kind: 'invoice' | 'bill'): string {
  // Calendar-order (January-first), indexed by the *absolute* month index
  // computed below — never by an offset from the anchor, which is what
  // produced wrong labels (e.g. anchor June + walkthrough month 1 reading
  // as "November") when a June-first array was walked with a January-first
  // formula.
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthHeading(m: WalkthroughMonth): string {
    const totalMonths = anchor.year * 12 + (anchor.month - 1) + (m - 1);
    const year = Math.floor(totalMonths / 12);
    const monthIndex = totalMonths % 12; // 0 = January .. 11 = December
    return `## Month ${String(m)} — ${monthNames[monthIndex] ?? ''} ${String(year)}`;
  }

  const intro =
    kind === 'invoice'
      ? `# Invoices to raise\n\nRaise each of these against the customer named, in the order shown, then **Issue** it — the matcher only considers an invoice once it is \`ISSUED\`. AutoLedger assigns the invoice number itself from the numbering settings; there is no "their invoice number" field to fill in.\n\n`
      : `# Bills received\n\nEnter each of these against the vendor named, in the order shown, then take it through **Submit for approval → Approve**. The matcher only considers a bill once it is \`POSTED\`.\n\n`;

  let out = intro;
  let currentMonth = 0;
  for (const doc of docs) {
    if (doc.month !== currentMonth) {
      currentMonth = doc.month;
      out += `${monthHeading(doc.month as WalkthroughMonth)}\n\n`;
    }
    const date = resolveDate(anchor, doc.month, doc.day);
    const dueDate =
      doc.dueDate !== undefined
        ? resolveDate(anchor, doc.dueDate.month, doc.dueDate.day)
        : resolveDate(anchor, doc.month, doc.day + doc.dueDays);
    const termDays = daysBetweenIso(date, dueDate);
    const counterparty = kind === 'invoice' ? customerName(doc.counterpartyKey) : vendorName(doc.counterpartyKey);
    const cents = parseMoneyText(doc.total);
    const lines = documentLines(doc);
    const hasItems = lines.some((l) => l.itemCode !== null);
    out += `### ${doc.ref} · ${counterparty}\n\n`;
    const provenance = provenanceLine(doc);
    if (provenance !== null) out += `> ${provenance}\n\n`;
    out += `| | |\n|---|---|\n`;
    if (kind === 'bill') out += `| **Their bill number** | \`${resolveTokens(anchor, doc.vendorReference ?? '')}\`  ← enter as the vendor reference |\n`;
    out += `| **${kind === 'invoice' ? 'Issue date' : 'Bill date'}** | ${date} |\n`;
    out += `| **Terms** | ${termDays === 0 ? 'Due on receipt' : `Net ${String(termDays)} days`} |\n`;
    out += `| **Due date** | ${dueDate} |\n\n`;
    out += hasItems
      ? `| # | Item code | Description | Qty | Unit price | Account |\n|---|---|---|---|---|---|\n`
      : `| # | Description | Qty | Unit price | Account |\n|---|---|---|---|---|\n`;
    lines.forEach((l, i) => {
      const desc = resolveTokens(anchor, l.description);
      const row = hasItems
        ? `| ${String(i + 1)} | ${l.itemCode === null ? '—' : `\`${l.itemCode}\``} | ${desc} | ${l.quantity} | ${money(parseMoneyText(l.unitPrice))} | ${accountName(l.accountCode)} |`
        : `| ${String(i + 1)} | ${desc} | ${l.quantity} | ${money(parseMoneyText(l.unitPrice))} | ${accountName(l.accountCode)} |`;
      out += `${row}\n`;
    });
    out += `\n**Total: ${money(cents)}**\n\n`;
    out +=
      kind === 'invoice'
        ? `> After saving, **Issue** the invoice — the matcher only considers an invoice once it is \`ISSUED\`.\n\n`
        : `> After saving, take this bill through **Submit for approval → Approve**. The matcher only considers a bill once it is \`POSTED\`.\n\n`;
  }
  return out;
}

function tierAction(score: number): string {
  if (score >= 85) return 'Accept the suggestion (auto)';
  return 'Review the suggestion, then Match';
}

function renderBankStatements(anchor: AnchorMonth, resolved: ResolvedSettlementLine[]): string {
  const docByRef = new Map(
    [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].map((d) => [d.ref, d]),
  );
  const expected = computeExpectedResults(anchor);

  let out =
    `# Bank statements\n\n` +
    `Six months, three different banks, three different export formats (Northwind Bank for months 1, 4 and 5, ` +
    `Meridian Bank for months 2 and 6, Cascade Trust for month 3). Import each one against ` +
    `\`1110 Operating Cash\` **only after** that month's bills are approved and invoices are issued — ` +
    `suggestions are generated at import time against documents that are open at that moment.\n\n` +
    `## Statement 1 — Northwind Bank (\`statements/month-1-northwind-ISO.csv\`)\n\n` +
    `Comma-delimited, ISO dates (\`YYYY-MM-DD\`), one signed \`Amount\` column. Every header is a column the ` +
    `importer recognizes automatically — leave the column-map closed, just pick **date format: ISO**.\n\n` +
    `## Statement 2 — Meridian Bank (\`statements/month-2-meridian-DMY.csv\`)\n\n` +
    `Semicolon-delimited, day-first dates (\`DD/MM/YYYY\`), separate \`Debit\`/\`Credit\` columns instead of one ` +
    `signed amount. Auto-detection still works — pick **date format: DMY**.\n\n` +
    `## Statement 3 — Cascade Trust (\`statements/month-3-cascade-MDY.csv\`)\n\n` +
    `Comma-delimited, month-first dates (\`MM/DD/YYYY\`), \`$\` amounts with accounting-style parentheses for a ` +
    `negative. **Auto-detection will fail here** — the headers are \`Posted\`, \`Memo\`, \`Check No\`, \`Net\`, ` +
    `none of which the importer's synonym list recognizes, so it responds \`422 Could not find a date column in ` +
    `the file\`. Open the column map and enter it by hand:\n\n` +
    `| Field | Column |\n|---|---|\n| Date | \`Posted\` |\n| Description | \`Memo\` |\n| Amount | \`Net\` |\n| Reference | \`Check No\` |\n\n` +
    `and pick **date format: MDY**.\n\n` +
    `## Statement 4 — Northwind Bank again (\`statements/month-4-northwind-ISO.csv\`)\n\n` +
    `Statement 1's format — comma-delimited, ISO dates, one signed \`Amount\` column; pick **date format: ISO**. ` +
    `Two deposits and one withdrawal this month are for **less** than the document total: the matcher scores ` +
    `each line against the amount still due *after* credit and debit notes, which is why you issue the notes in ` +
    `\`08-returns-and-adjustments.md\` **before** importing this statement.\n\n` +
    `## Statement 5 — Northwind Bank (\`statements/month-5-northwind-ISO.csv\`)\n\n` +
    `The same format as statement 1 — comma-delimited, ISO dates, one signed \`Amount\` column; pick **date ` +
    `format: ISO**. Import it **after** the two bank rules in \`09-products-orders-and-stock.md\` exist: the ` +
    `service charge and the interest line are then settled on import, and their rows below read ` +
    `"Settled by your bank rule". The deposit line is for the invoice \`D1\` raised from a sales order.\n\n` +
    `## Statement 6 — Meridian Bank (\`statements/month-6-meridian-DMY.csv\`)\n\n` +
    `The same format as statement 2 — semicolon-delimited, day-first dates, separate \`Debit\`/\`Credit\` ` +
    `columns; pick **date format: DMY**. Import it after \`10-closing-the-quarter.md\`'s documents, the payroll ` +
    `journal and the second invoice are in.\n\n---\n\n`;

  for (const m of WALKTHROUGH_MONTHS) {
    const monthLines = resolved.filter((l) => l.month === m).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    const monthNoise = WALKTHROUGH_DATASET.noise
      .filter((n) => n.month === m)
      .map((n) => ({ isoDate: resolveDate(anchor, m, n.day), description: n.description, amountCents: parseMoneyText(n.amount), resolution: n.resolution }));

    out += `## Month ${String(m)}'s lines\n\n`;
    out += `| Date | Memo | Amount | Expected score | What to do |\n|---|---|---|---|---|\n`;

    const rows: { isoDate: string; description: string; amountCents: number; what: string }[] = [];
    for (const l of monthLines) {
      const doc = docByRef.get(l.documentRef);
      const label = doc === undefined ? l.documentRef : `${doc.ref}`;
      const what = l.expectedScore >= 40 ? `${tierAction(l.expectedScore)} — should match ${label}` : 'No suggestion';
      rows.push({ isoDate: l.isoDate, description: l.description, amountCents: l.amountCents, what: `${what} · score ${String(l.expectedScore)}` });
    }
    for (const n of monthNoise) {
      const what =
        n.resolution.kind === 'POST_JOURNAL'
          ? `Post journal → ${accountName(n.resolution.accountCode)}`
          : n.resolution.kind === 'RULE'
            ? 'Settled by your bank rule on import — nothing to do'
            : 'Ignore — no GL entry';
      rows.push({ isoDate: n.isoDate, description: n.description, amountCents: n.amountCents, what });
    }
    rows.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    for (const r of rows) {
      out += `| ${r.isoDate} | ${r.description} | ${money(r.amountCents)} | ${r.what.includes('score') ? r.what.split('score ')[1] ?? '' : '—'} | ${r.what.replace(/ · score \d+/, '')} |\n`;
    }

    const monthResult = expected.find((e) => e.month === m);
    const closingBalance = monthResult?.bankReconciliation.statementBalanceCents ?? 0;
    out +=
      `\nClosing balance to type into the import form: **${money(closingBalance)}**, dated ${monthResult?.asOf ?? ''}.\n\n` +
      `After resolving every line above, **Reports → Bank reconciliation** for \`1110 Operating Cash\` as of ` +
      `\`${monthResult?.asOf ?? ''}\` must show **Difference = 0.00** and **Unmatched = 0**.\n\n---\n\n`;
  }

  return out;
}

function renderMoneyRows(rows: ExpectedStatementRow[]): string {
  return rows.map((r) => `| ${r.code} ${r.name} | ${money(r.amountCents)} |`).join('\n');
}

function renderExpectedResults(expected: ExpectedMonth[]): string {
  let out =
    `# Expected results — the answer key\n\n` +
    `Computed from the same dataset the statements and source documents come from, and verified — in this ` +
    `project's own test suite — against the real AutoLedger reports produced by replaying this exact scenario ` +
    `through the real API. If your numbers disagree with this file, your entries disagree with the scenario, ` +
    `not the other way around.\n\n`;

  for (const m of expected) {
    out += `## Month ${String(m.month)} — as of ${m.asOf}\n\n`;

    out += `### Trial balance\n\n| Account | Debit | Credit |\n|---|---|---|\n`;
    for (const r of m.trialBalance.rows) {
      out += `| ${r.code} ${r.name} | ${r.debitCents > 0 ? money(r.debitCents) : ''} | ${r.creditCents > 0 ? money(r.creditCents) : ''} |\n`;
    }
    out += `| **Total** | **${money(m.trialBalance.totalDebitCents)}** | **${money(m.trialBalance.totalCreditCents)}** |\n\n`;

    out += `### Profit & loss (cumulative from month 1)\n\n| | Amount |\n|---|---|\n`;
    out += `${renderMoneyRows(m.profitAndLoss.revenue)}\n`;
    out += `| **Total revenue** | **${money(m.profitAndLoss.revenueTotalCents)}** |\n`;
    if (m.profitAndLoss.costOfSales.length > 0) {
      out += `${renderMoneyRows(m.profitAndLoss.costOfSales)}\n`;
      out += `| **Total cost of sales** | **${money(m.profitAndLoss.costOfSalesTotalCents)}** |\n`;
    }
    out += `| **Gross profit** | **${money(m.profitAndLoss.grossProfitCents)}** |\n`;
    out += `${renderMoneyRows(m.profitAndLoss.operatingExpenses)}\n`;
    out += `| **Total operating expenses** | **${money(m.profitAndLoss.operatingExpensesTotalCents)}** |\n`;
    out += `| **Net income** | **${money(m.profitAndLoss.netIncomeCents)}** |\n\n`;

    out += `### Balance sheet — as of ${m.asOf}\n\n| | Amount |\n|---|---|\n`;
    out += `${renderMoneyRows(m.balanceSheet.assets)}\n`;
    out += `| **Total assets** | **${money(m.balanceSheet.assetsTotalCents)}** |\n`;
    out += `${renderMoneyRows(m.balanceSheet.liabilities)}\n`;
    out += `| **Total liabilities** | **${money(m.balanceSheet.liabilitiesTotalCents)}** |\n`;
    out += `${renderMoneyRows(m.balanceSheet.equityRows)}\n`;
    out += `| Retained/current earnings (derived) | ${money(m.balanceSheet.cumulativeNetIncomeCents)} |\n`;
    out += `| **Total equity** | **${money(m.balanceSheet.equityTotalCents)}** |\n\n`;
    out += `Assets ${money(m.balanceSheet.assetsTotalCents)} = Liabilities ${money(m.balanceSheet.liabilitiesTotalCents)} + Equity ${money(m.balanceSheet.equityTotalCents)}\n\n`;

    out += `### AR aging\n\n| Bucket | Amount |\n|---|---|\n`;
    for (const b of m.arAging) out += `| ${b.label} | ${money(b.amountCents)} |\n`;
    out += `\n### AP aging\n\n| Bucket | Amount |\n|---|---|\n`;
    for (const b of m.apAging) out += `| ${b.label} | ${money(b.amountCents)} |\n`;

    out += `\n### Bank reconciliation\n\n`;
    out += `| | |\n|---|---|\n`;
    out += `| GL balance | ${money(m.bankReconciliation.glBalanceCents)} |\n`;
    out += `| Statement balance | ${money(m.bankReconciliation.statementBalanceCents)} |\n`;
    out += `| **Difference** | **${money(m.bankReconciliation.differenceCents)}** |\n`;
    out += `| Matched | ${String(m.bankReconciliation.matchedCount)} |\n`;
    out += `| Unmatched | ${String(m.bankReconciliation.unmatchedCount)} |\n`;
    out += `| Ignored | ${String(m.bankReconciliation.ignoredCount)} |\n\n---\n\n`;
  }

  out += `If any figure above differs, see "If a number does not match" in \`README.md\`.\n`;
  return out;
}

function renderSetup(): string {
  return (
    `# Setup\n\n` +
    `1. Register a **fresh** organization — any name, base currency **USD**. Registration seeds the default 47-account chart automatically. Complete the setup wizard that follows (base currency **USD**). On its optional inventory step, choose the **Manufacturing** profile now, or **Skip for now** and set inventory up later, at the start of month 5, under **Settings → Inventory → Industry template** (choose **Manufacturing** there too). Either way, inventory must be set up before month 5's stock items are imported: that profile creates the \`SPR\` (Stores & spares) category the file uses.\n` +
    `2. Add one account, \`4300 Interest Income\`. Either import \`accounts.csv\` (kind **Chart of accounts**), which is one row — \`4300 Interest Income\` — or create it by hand under **Accounting → Chart of accounts** with the table below:\n\n` +
    `   | Field | Value |\n   |---|---|\n   | Code | \`4300\` |\n   | Name | Interest Income |\n   | Type | Revenue |\n   | Parent | \`4000 Revenue\` |\n   | Postable | Yes |\n\n` +
    `3. Do **not** run the opening-balance importer into this organization — the scenario assumes zero opening cash, and an import would add balances this pack's answer key does not account for.\n`
  );
}

function renderTheBusiness(): string {
  return (
    `# Harbor Point Fabrication\n\n` +
    `${WALKTHROUGH_DATASET.businessDescription}\n\n` +
    `**Period:** six consecutive months, entered one at a time — the fourth is about returns and ` +
    `adjustments (credit and debit notes), and the fifth and sixth add stock, orders and deposits, a recurring ` +
    `bill and an accrual, a payroll journal, and closing the periods. **Currency:** USD throughout.\n\n` +
    `**Scope.** Months 1–4 cover the accounts-receivable / accounts-payable / cash cycle — invoicing, billing, ` +
    `and bank reconciliation. Months 5–6 add stock items (moving-average cost of sales), purchase and sales ` +
    `orders with partial invoicing, a customer deposit, bank rules, a recurring rent bill, an accrual that ` +
    `reverses itself, a payroll journal, and period close. It does not include fixed assets or depreciation, ` +
    `foreign currency, a year-end close, or sales tax. One bank account, one currency.\n\n` +
    `## Accounts this scenario touches\n\n` +
    `| Account | Why |\n|---|---|\n` +
    `| 1110 Operating Cash | Every deposit and withdrawal |\n` +
    `| 1120 Accounts Receivable | What customers owe between invoice and payment |\n` +
    `| 1140 Inventory | Stock on hand, valued at moving average (months 5–6) |\n` +
    `| 2100 Accounts Payable | What's owed to vendors between bill approval and payment |\n` +
    `| 2120 Accrued Liabilities | The utilities accrual, reversed the following month (month 5) |\n` +
    `| 2130 Customer Deposits | A deposit received before the order is invoiced (month 5) |\n` +
    `| 2160 Payroll Liabilities | Net pay owed to employees until the bank pays it out (month 6) |\n` +
    `| 3100 Common Stock / Owner's Capital | The founder's opening deposit |\n` +
    `| 4100 Product Revenue, 4200 Service Revenue | The two ways Harbor Point bills customers |\n` +
    `| 4300 Interest Income | Bank interest — the one account added to the default chart; it arrives through \`accounts.csv\` (or by hand), see 01-setup.md |\n` +
    `| 4800 Sales Returns & Allowances | Month 4's credit notes — a contra-revenue account |\n` +
    `| 5050 Cost of Sales — Inventory | What the stock sold to customers cost us (months 5–6) |\n` +
    `| 5100 Direct Materials, 5300 Freight & Duty | Cost of sales |\n` +
    `| 5200 Direct Labor | Shop-floor payroll (month 6) |\n` +
    `| 6100 Salaries & Wages | Office and salaried payroll (month 6) |\n` +
    `| 6110, 6120, 6200, 6400 | Rent, software, professional fees, marketing |\n` +
    `| 6600 Bank Fees | Wire fees and monthly service charges |\n`
  );
}

function renderReadme(): string {
  return (
    `# Walkthrough: Harbor Point Fabrication\n\n` +
    `A complete, six-month accounting scenario for AutoLedger — vendor, customer, product and stock-item CSVs to ` +
    `import, source documents to enter by hand (or raise from quotes and orders), six bank statements to import, ` +
    `credit and debit notes in month 4, stock, a deposit, recurring bills and an accrual in month 5, a month-end ` +
    `close in month 6, and a computed answer key — verified against the real application — to check your work ` +
    `against. A separate, unscored feature tour covers what does not touch the ledger.\n\n` +
    `**Start with \`TUTORIAL.md\`** — it walks the whole thing start to finish with hints. The files below are ` +
    `its reference material, useful to come back to on their own:\n\n` +
    `- \`00-the-business.md\` — who Harbor Point Fabrication is\n` +
    `- \`01-setup.md\` — organization registration, the one account to add (\`4300\`)\n` +
    `- \`02-vendors.md\`, \`03-customers.md\` — the CSV import steps, with the CSV shown inline\n` +
    `- \`04-bills-received.md\`, \`05-invoices-to-raise.md\` — the source documents, in order\n` +
    `- \`06-bank-statements.md\` — what each statement is and the per-line action to take\n` +
    `- \`07-expected-results.md\` — the answer key\n` +
    `- \`08-returns-and-adjustments.md\` — month 4: what credit and debit notes are, when you need one, their ` +
    `journal entries, and the three notes to enter\n` +
    `- \`09-products-orders-and-stock.md\` — month 5: products and stock items, bank rules, purchase order → bill, ` +
    `quote → sales order → deposit → invoice, a recurring bill and a self-reversing accrual\n` +
    `- \`10-closing-the-quarter.md\` — month 6: the generated rent, imported invoices/bills/payroll, applying ` +
    `the deposit, closing a period\n` +
    `- \`11-feature-tour.md\` — an optional, **unscored** tour of features that do not change the answer key\n` +
    `- \`vendors.csv\`, \`customers.csv\`, \`accounts.csv\`, \`products.csv\`, \`stock-items.csv\` — master data to ` +
    `import via **Accounting → Imports**\n` +
    `- \`invoices-month-6.csv\`, \`bills-month-6.csv\`, \`payroll-month-6.csv\` — month 6's document and journal ` +
    `imports\n` +
    `- \`statements/\` — the six CSV files to import via **Banking → Import statement**\n\n` +
    `**Run order:** import all 6 vendors and all 6 customers once, up front, via **Accounting → ` +
    `Imports** in the left sidebar (and \`accounts.csv\`, per \`01-setup.md\`). Then, one month at a time — enter that month's bills (submit + approve), enter that month's ` +
    `invoices (issue), import that month's statement, resolve every line, check the reconciliation report, ` +
    `check that month's figures against \`07-expected-results.md\` — before moving to the next month. In ` +
    `month 4, issue the notes in \`08-returns-and-adjustments.md\` after entering that month's documents and ` +
    `**before** importing its statement. ` +
    `Suggestions are generated at import time against documents that are open right then, so a month's ` +
    `documents must exist before its statement is imported.\n\n` +
    `Months 5 and 6 are different in kind: follow \`09-products-orders-and-stock.md\` for month 5 and ` +
    `\`10-closing-the-quarter.md\` for month 6 — they say what to do in what order (imports, bank rules, ` +
    `orders, a deposit, a schedule), and the document sheets \`04\`/\`05\` then serve as reference. The ` +
    `scenario's dates end in the past on purpose: a recurring schedule only creates occurrences up to today.\n\n` +
    `**Do not hand-edit anything in this folder.** It is generated output — change ` +
    `\`server/src/scripts/walkthroughDataset.ts\` and run \`npm run walkthrough\` again.\n\n` +
    `## If a number does not match\n\n` +
    `1. Check every bill was taken through Submit → Approve, and every invoice through Issue. A document ` +
    `still in DRAFT is invisible to the matcher and won't appear as a suggestion.\n` +
    `2. Check the bank line list for anything still \`UNMATCHED\` — it counts toward the statement total but ` +
    `never moved the GL, which is the single most common way to throw the reconciliation off.\n` +
    `3. Check that no \`IGNORED\` line was also posted as a journal entry (or vice versa) — a line is one or ` +
    `the other, never both, and getting this backwards moves the GL and the statement in opposite directions.\n`
  );
}

function renderTutorial(expected: ExpectedMonth[]): string {
  let out =
    `# Tutorial: run the whole scenario\n\n` +
    `You are Harbor Point Fabrication's bookkeeper for six months. Everything you need to type is in this ` +
    `folder; everything you should end up seeing is in this file, month by month, with a hint at each step ` +
    `that tends to trip people up.\n\n` +
    `Read \`00-the-business.md\` first if you have not already — it is one page and tells you what the company ` +
    `does and which accounts you'll touch.\n\n---\n\n` +
    `## Step 0 — set up the organization\n\n` +
    `Follow \`01-setup.md\`: register a fresh org (base currency USD), complete the setup wizard (its optional ` +
    `inventory step can be done now with the **Manufacturing** profile, or later at the start of month 5), then ` +
    `add one account, \`4300 Interest Income\` — import \`accounts.csv\` or create it by hand. Registration ` +
    `already seeds the other 47 accounts, so this is the only one you add.\n\n` +
    `> **Hint:** if you skip creating 4300 and hit an interest line in the bank statement later, "Post journal" ` +
    `will have no account to offer for it — come back here and add it. (From month 5 the interest line is ` +
    `settled by a bank rule, which needs the account too.)\n\n` +
    `## Step 1 — import the master records\n\n` +
    `Go to **Accounting → Imports → New import**. Kind **Vendors**, upload \`vendors.csv\` (its contents ` +
    `are also shown in \`02-vendors.md\` if you'd rather copy-paste). It stages 6 rows, all \`VALID\`; Preview ` +
    `shows \`6 will be created, 0 will be merged\`; Commit. Repeat with kind **Customers** and \`customers.csv\`. ` +
    `(The **Customers** and **Vendors** pages have an **Import** button that opens the same wizard.) ` +
    `Do this now, before entering any document — every one of the 12 is used at least once across the six ` +
    `months. A thirteenth vendor, Lakeshore Power & Water, is added by hand in month 6.\n\n` +
    `> **Hint:** payment terms for every vendor are "Due on receipt" — there's no net-30 anywhere in this ` +
    `scenario, which keeps every bank line's date close to its document's date.\n\n` +
    `> **Hint:** if a staged row comes back \`INVALID\`, the importer is telling you something is genuinely ` +
    `wrong with that row (a blank name, a malformed email) — these two files are clean, so seeing one means the ` +
    `upload got corrupted somewhere, not that you should force a commit past it.\n\n---\n\n`;

  for (const m of WALKTHROUGH_MONTHS) {
    const monthResult = expected.find((e) => e.month === m);
    out +=
      `## Month ${String(m)}\n\n` +
      (m === 5 || m === 6
        ? `**Enter the documents.** This month's documents are not all typed in the same way — some are raised ` +
          `from orders, imported from files, or generated by a schedule. \`${m === 5 ? '09-products-orders-and-stock.md' : '10-closing-the-quarter.md'}\` ` +
          `walks through them **in the order to do them** (\`04-bills-received.md\` and \`05-invoices-to-raise.md\` ` +
          `list the same documents with their figures and say where each comes from). ` +
          `${m === 5 ? 'Sections 1 to 5 come before the statement; section 6 imports it and locks the first four months.' : 'Sections 1 to 4 come before the statement; 6 and 7 after it.'}\n\n`
        : `**Enter the documents.** From \`04-bills-received.md\` and \`05-invoices-to-raise.md\`, find this ` +
          `month's section and enter every bill and every invoice listed there — bills through Submit → Approve, ` +
          `invoices through Issue.\n\n`) +
      `> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import ` +
      `the statement below — if a bank line comes up with zero suggestions and you expected one, check the ` +
      `document's status first.\n\n` +
      (m === 4
        ? `**Issue the notes.** This is the month about corrections — read \`08-returns-and-adjustments.md\` ` +
          `(what credit and debit notes are, when you need one, and the journal entry each posts), then work ` +
          `through its "Enter these" section in order: CN1, DN1, CN2, then apply CN2 to I16. Checkpoints:\n\n` +
          `- after CN1 → invoice I15 shows amount due **10,200.00**\n` +
          `- after DN1 → expense B12 shows amount due **10,500.00**\n` +
          `- after CN2 → **Customers → Ferrous Works Ltd**'s open items show CN2 as its own line at ` +
          `**−500.00** (unapplied credit) next to I16's 6,200.00, and **Reports → AR aging** still says it ` +
          `reconciles\n` +
          `- after applying CN2 → invoice I16 shows amount due **5,700.00**\n\n` +
          `> **Hint:** issue the notes **before** importing the statement. Suggestions are scored at import time ` +
          `against the amount still due; imported first, the 10,200.00 deposit would be scored against I15's full ` +
          `12,000.00 and come up short on the amount points.\n\n` +
          `> **Hint:** a credit note posts to **4800 Sales Returns & Allowances**, not back to 4100 — change the ` +
          `account on the line copied from the invoice. The debit note stays on 5100, the account the steel was ` +
          `originally expensed to.\n\n`
        : '') +
      `**Import the statement.** From \`06-bank-statements.md\`, import \`statements/month-${String(m)}-` +
      `${STATEMENT_FORMAT[m]}.csv\` against \`1110 Operating ` +
      `Cash\`, using the date format \`06-bank-statements.md\` gives you. Enter the closing balance it names ` +
      `too — it's optional, but it's what lets the import screen tell you immediately if a total is off.\n\n` +
      (m === 3
        ? `> **Hint:** this statement's headers — \`Posted\`, \`Memo\`, \`Check No\`, \`Net\` — won't ` +
          `auto-detect. That's deliberate: open the column map and type in the four mappings \`06-bank-` +
          `statements.md\` gives you.\n\n`
        : '') +
      (m >= 5
        ? `> **Hint:** some lines are already \`MATCHED\` the moment the import finishes — the service charge and the ` +
          `interest, settled by your bank rules. Leave them; only resolve what is still unmatched.\n\n`
        : '') +
      `**Resolve every line.** Work down \`06-bank-statements.md\`'s table for this month. A line at or above ` +
      `85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and ` +
      `match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use ` +
      `**Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to ` +
      `another of the organization's own accounts — it never touches the GL at all.\n\n` +
      `> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites ` +
      `in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal ` +
      `moves the GL and counts it. Using the wrong one is the single most common way this month's Difference ` +
      `comes out non-zero.\n\n` +
      `**Check the reconciliation.** Reports → Bank reconciliation, account \`1110 Operating Cash\`, as of ` +
      `\`${monthResult?.asOf ?? ''}\`. You should see:\n\n` +
      `- Difference: **0.00**\n` +
      `- Unmatched: **0**\n` +
      `- Ignored: **${String(monthResult?.bankReconciliation.ignoredCount ?? 0)}**\n\n` +
      (m === 5 && monthResult !== undefined
        ? `Month 5 checkpoints:\n\n` +
          `- Ignored: **${String(monthResult.bankReconciliation.ignoredCount)}** (cumulative — one transfer to savings per month)\n` +
          `- \`1140 Inventory\` after the first delivery: **${money(balanceCents(monthResult, '1140'))}**\n` +
          `- \`${datasetOrder('SO1').ref}\` billing status: **Partly billed**\n\n`
        : '') +
      (m === 6 && monthResult !== undefined
        ? `Month 6 checkpoints (the hand-checked balances):\n\n` +
          `| | |\n|---|---|\n` +
          ['1140', '2130', '2120', '2160', '1120', '2100']
            .map((code) => `| ${accountName(code)} | ${money(balanceCents(monthResult, code))} |`)
            .join('\n') +
          `\n| ${accountName('5050')} (cumulative) | ${money(monthResult.profitAndLoss.costOfSales.find((r) => r.code === '5050')?.amountCents ?? 0)} |\n\n`
        : '') +
      `**Check the answer key.** Open \`07-expected-results.md\`'s "Month ${String(m)}" section and compare, ` +
      `figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, and AR/AP aging. The ` +
      `headline numbers for this month:\n\n` +
      `| | |\n|---|---|\n` +
      `| Net income (cumulative) | ${money(monthResult?.profitAndLoss.netIncomeCents ?? 0)} |\n` +
      `| Total assets | ${money(monthResult?.balanceSheet.assetsTotalCents ?? 0)} |\n` +
      `| Cash | ${money(monthResult?.bankReconciliation.glBalanceCents ?? 0)} |\n` +
      (m === 1
        ? `| Accounts receivable | ${money(monthResult?.balanceSheet.assets.find((r) => r.code === '1120')?.amountCents ?? 0)} — this is Pinnacle Robotics' partial payment, the one open item this whole pack carries |\n`
        : `| Accounts receivable | ${money(monthResult?.balanceSheet.assets.find((r) => r.code === '1120')?.amountCents ?? 0)} |\n`) +
      `\n${m === 1 ? '> **Hint:** do not move on to month 2 until Difference is 0.00 — every later month assumes month 1 reconciled cleanly.\n\n' : ''}` +
      `---\n\n`;
  }

  out +=
    `## You're done\n\n` +
    `Six months entered, six statements reconciled, six months of financial statements that tie back to ` +
    `a source document for every dollar — including three corrections made the way an auditor ` +
    `expects them, by separate documents that leave the originals untouched, stock bought and sold at moving ` +
    `average, a deposit that became revenue, and an accrual that cancelled itself. \`11-feature-tour.md\` ` +
    `is an optional extra: it exercises features that do not move the ledger. If you want to see the finished books ` +
    `without typing them, \`npm run seed:demo\` (in \`server/\`) replays this exact scenario through the API into a ` +
    `demo organization — see \`docs/development.md\`.\n`;

  return out;
}

// ----------------------------------------------- month 4: credit & debit notes

/**
 * `08-returns-and-adjustments.md` (Phase 26) — the explainer and entry sheet
 * for month 4's credit and debit notes. Every amount and date comes from
 * `WALKTHROUGH_DATASET.notes`, never retyped here.
 */
function renderAdjustments(anchor: AnchorMonth): string {
  const docByRef = new Map(
    [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].map((d) => [d.ref, d]),
  );

  function journalTable(note: DatasetNote): string {
    const total = money(parseMoneyText(note.total));
    const rows =
      note.kind === 'CREDIT_NOTE'
        ? [`| ${accountName(note.accountCode)} | ${total} | |`, `| 1120 Accounts Receivable | | ${total} |`]
        : [`| 2100 Accounts Payable | ${total} | |`, `| ${accountName(note.accountCode)} | | ${total} |`];
    return `| Account | Debit | Credit |\n|---|---|---|\n${rows.join('\n')}\n`;
  }

  let out =
    `# Month 4 — returns & adjustments (credit notes and debit notes)\n\n` +
    `Months 1–3 only ever *added* documents. Real businesses also have to *correct* them: a customer sends ` +
    `goods back, a supplier overcharges, a job is delivered late and you give a discount after the fact. ` +
    `This month shows the two documents that do that job without touching the original.\n\n` +
    `## What these documents are\n\n` +
    `| Document | Issued by | Sent to | What it does in **our** books | Called elsewhere |\n|---|---|---|---|---|\n` +
    `| **Credit note** | us (the seller) | a customer | Reduces what the customer owes us (AR ↓) | QuickBooks "credit memo", Xero "sales credit note", Zoho "credit note" |\n` +
    `| **Debit note** | us (the buyer) | a vendor | Reduces what we owe the vendor (AP ↓) | QuickBooks "vendor credit", Xero "purchase credit note", Zoho "vendor credit" |\n\n` +
    `The names describe what the document does to the *other party's* account in your books: a credit note ` +
    `**credits** the customer's (receivable) account; a debit note **debits** the vendor's (payable) account. ` +
    `When you send a vendor a debit note, they usually answer with their own credit note — AutoLedger lets ` +
    `you record its number as the *vendor's credit note no.*\n\n` +
    `## When you need one\n\n` +
    `**Credit note** — the customer returned goods; you agreed a price allowance or an after-the-sale discount; ` +
    `goods arrived damaged; part of an invoice should never have been charged.\n\n` +
    `**Debit note** — you returned goods to a vendor; the vendor overcharged you; they delivered less than ` +
    `they billed.\n\n` +
    `**When you don't:**\n\n` +
    `- The whole invoice was wrong and nothing has been paid on it → **void** the invoice and re-issue it.\n` +
    `- The customer will simply never pay → that is a bad-debt write-off, a different document (not built in ` +
    `AutoLedger yet).\n` +
    `- The customer owes you **more** than you invoiced → issue another invoice. (Some tax regimes call a ` +
    `seller's document that *increases* an invoice a "debit note" too — e.g. India's GST. AutoLedger does not ` +
    `build that variant; a supplementary invoice does the same job in the books.)\n\n` +
    `> For background (verify for your jurisdiction): returns and allowances reduce revenue under IFRS 15 / ` +
    `ASC 606; India's CGST Act s.34 and the EU VAT Directive (art. 219) treat a document that amends an invoice ` +
    `as part of the invoice record, which is why it references the original and carries its own number series.\n\n` +
    `## Why a separate document instead of editing or voiding the original\n\n` +
    `- **The original stays intact.** An issued invoice is immutable in AutoLedger (and in any audited set of ` +
    `books); tax records and the customer both hold a copy of it.\n` +
    `- **Partial corrections.** Returning 3 kits out of 20 is not a reason to cancel the other 17.\n` +
    `- **Closed periods stay closed.** The note is dated when the return happens, so last month's reports ` +
    `never change.\n` +
    `- **Its own number series** (\`CN-000001\`, \`DN-000001\`), so auditors can see every correction in order.\n\n` +
    `## What they do to the books\n\n` +
    `Every note posts one journal entry when it is **issued** — the mirror image of the original document:\n\n`;

  for (const note of WALKTHROUGH_DATASET.notes) {
    out += `**${note.ref}** — ${note.lineDescription}\n\n${journalTable(note)}\n`;
  }

  out +=
    `With sales tax (not part of this dataset, for illustration): returning goods worth 1,000.00 plus 10% tax ` +
    `posts DR 4800 Sales Returns & Allowances 1,000.00, DR 2140 Sales Tax Payable 100.00 / CR 1120 Accounts ` +
    `Receivable 1,100.00 — the tax you had collected is given back too.\n\n` +
    `**Applying** a note to an invoice or bill posts **no** journal entry at all. The note already credited ` +
    `1120 and the invoice already debited it, so both are sitting inside the same Accounts Receivable ` +
    `balance; applying one to the other only matches them up on the customer's account.\n\n` +
    `4800 Sales Returns & Allowances is a *Revenue* account with a debit balance — a "contra-revenue" ` +
    `account. On the P&L it shows as a negative line under Revenue, so gross sales and returns stay visible ` +
    `separately. The debit note, by contrast, credits the original expense account (5100) directly: the steel ` +
    `you sent back simply never became a cost.\n\n` +
    `## Rules AutoLedger enforces\n\n` +
    `- A note must reference its original invoice (credit note) or approved bill (debit note), and takes ` +
    `that document's customer/vendor, currency and exchange rate — you never pick them.\n` +
    `- All notes against one document together can never exceed that document's total.\n` +
    `- On **Issue**, the note is applied to its original automatically, up to what is still owed. If the ` +
    `original is already paid, nothing applies and the whole note sits on the party's account as **unapplied ` +
    `credit** — a *negative* open item — until you apply it to another of their open documents.\n` +
    `- The original can't be voided while a note is issued against it; void the note first. Voiding a note ` +
    `reverses its journal entry and re-opens whatever it had been applied to.\n` +
    `- A draft note can be edited or deleted; an issued one can only be voided.\n\n` +
    `## Enter these\n\n` +
    `Enter all of month 4's invoices and bills first (\`04-…\` and \`05-…\`), then these three notes **in this ` +
    `order**, then import month 4's statement. The notes must exist before the statement: the matcher scores ` +
    `each bank line against the amount still due, and two of this month's payments are for the *net* amount.\n\n`;

  for (const note of WALKTHROUGH_DATASET.notes) {
    const original = docByRef.get(note.againstRef);
    const isCredit = note.kind === 'CREDIT_NOTE';
    const party = isCredit ? customerName(note.counterpartyKey) : vendorName(note.counterpartyKey);
    const originalLabel =
      original === undefined
        ? note.againstRef
        : isCredit
          ? `invoice ${note.againstRef} (${original.lineDescription}, ${money(parseMoneyText(original.total))})`
          : `bill ${note.againstRef} (their no. \`${original.vendorReference ?? ''}\`, ${money(parseMoneyText(original.total))})`;
    out +=
      `### ${note.ref} · ${isCredit ? 'Credit note' : 'Debit note'} · ${party}\n\n` +
      `Open ${originalLabel} → **${isCredit ? 'Create credit note' : 'Create debit note'}**.\n\n` +
      `| | |\n|---|---|\n` +
      `| **Date** | ${resolveDate(anchor, note.month, note.day)} |\n` +
      `| **Reason** | ${note.reasonCode} |\n` +
      (note.vendorCreditReference !== null ? `| **Vendor's credit note no.** | \`${note.vendorCreditReference}\` |\n` : '') +
      `\n| # | Description | Qty | Unit price | Account |\n|---|---|---|---|---|\n` +
      `| 1 | ${note.lineDescription} | 1 | ${money(parseMoneyText(note.total))} | ${accountName(note.accountCode)} |\n\n` +
      `Replace the lines copied from the original with this one line, **Save**, then **Issue**.\n\n`;
    for (const allocation of note.allocations) {
      if (allocation.documentRef === note.againstRef) {
        out += `> Issuing applies ${money(parseMoneyText(allocation.amount))} to ${note.againstRef} automatically — nothing more to do.\n\n`;
      } else {
        out +=
          `> ${note.againstRef} was already paid in full, so issuing applies **nothing** — the whole ` +
          `${money(parseMoneyText(note.total))} becomes unapplied credit on ${party}'s account. Then, on the note, ` +
          `**Apply credit** → ${allocation.documentRef}, amount ${money(parseMoneyText(allocation.amount))}, date ` +
          `${resolveDate(anchor, note.month, allocation.day)}.\n\n`;
      }
    }
  }

  out +=
    `## What to check\n\n` +
    `| After | Where | You should see |\n|---|---|---|\n` +
    `| CN1 | Invoice I15 | Credits applied 1,800.00 · Amount due **10,200.00** |\n` +
    `| DN1 | Expense B12 | Debits applied 1,500.00 · Amount due **10,500.00** |\n` +
    `| CN2 (before applying) | Customers → Ferrous Works Ltd → open items | Two open items: I16 **6,200.00** and CN2 **−500.00** (unapplied credit) — balance 5,700.00 |\n` +
    `| CN2 (before applying) | Reports → AR aging | Ferrous Works 5,700.00, and "Reconciles" still ✓ |\n` +
    `| CN2 applied | Invoice I16 | Credits applied 500.00 · Amount due **5,700.00** |\n` +
    `| Statement 4 imported | Bank lines | 10,200.00, −10,500.00 and 5,700.00 each suggest I15, B12 and I16 |\n\n` +
    `By month end every one of these is settled, so AR and AP are both **0.00** again — but the P&L now shows ` +
    `**4800 Sales Returns & Allowances −2,300.00** under Revenue, and 5100 Direct Materials is 1,500.00 lower ` +
    `than the steel bill alone.\n`;

  return out;
}

// ------------------------------------------- months 5 and 6: shared helpers

function datasetDocByRef(ref: string): DatasetDocument {
  const doc = [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].find((d) => d.ref === ref);
  if (doc === undefined) throw new Error(`walkthrough: no document ${ref}`);
  return doc;
}

function datasetOrder(ref: string): DatasetOrder {
  const order = WALKTHROUGH_DATASET.orders.find((o) => o.ref === ref);
  if (order === undefined) throw new Error(`walkthrough: no order ${ref}`);
  return order;
}

function datasetStockItem(code: string): (typeof WALKTHROUGH_DATASET.stockItems)[number] {
  const item = WALKTHROUGH_DATASET.stockItems.find((s) => s.code === code);
  if (item === undefined) throw new Error(`walkthrough: no stock item ${code}`);
  return item;
}

/** quantity × unit price in integer cents; the dataset is chosen so this is exact. */
function lineCents(line: { quantity: string; unitPrice: string }): number {
  return Math.round(Number(line.quantity) * parseMoneyText(line.unitPrice));
}

/** What the stock lines among `lines` cost at the item's moving-average cost (one receipt each, so the unit cost). */
function stockCostCents(lines: { itemCode: string | null; quantity: string }[]): number {
  let total = 0;
  for (const l of lines) {
    if (l.itemCode === null) continue;
    const stock = WALKTHROUGH_DATASET.stockItems.find((s) => s.code === l.itemCode);
    if (stock === undefined) continue;
    total += Math.round(Number(l.quantity) * parseMoneyText(stock.unitCost));
  }
  return total;
}

/** A debit/credit posting table; a missing side renders blank. */
function postingTable(rows: { account: string; debitCents?: number; creditCents?: number }[]): string {
  const body = rows
    .map((r) => `| ${r.account} | ${r.debitCents === undefined ? '' : money(r.debitCents)} | ${r.creditCents === undefined ? '' : money(r.creditCents)} |`)
    .join('\n');
  return `| Account | Debit | Credit |\n|---|---|---|\n${body}\n\n`;
}

function expectedMonth(expected: ExpectedMonth[], month: WalkthroughMonth): ExpectedMonth {
  const m = expected.find((e) => e.month === month);
  if (m === undefined) throw new Error(`walkthrough: no expected month ${String(month)}`);
  return m;
}

/** A balance-sheet account's balance in cents (0 when the account has no balance). */
function balanceCents(m: ExpectedMonth, code: string): number {
  return [...m.balanceSheet.assets, ...m.balanceSheet.liabilities].find((r) => r.code === code)?.amountCents ?? 0;
}

function orderLinesTable(lines: DatasetOrder['lines']): string {
  let out = `| # | Item code | Description | Qty | Unit price | Account |\n|---|---|---|---|---|---|\n`;
  lines.forEach((l, i) => {
    out += `| ${String(i + 1)} | \`${l.itemCode ?? ''}\` | ${l.description} | ${l.quantity} | ${money(parseMoneyText(l.unitPrice))} | ${accountName(l.accountCode)} |\n`;
  });
  return `${out}\n`;
}

// --------------------------------- 09: products, orders, stock (months 5)

/**
 * `09-products-orders-and-stock.md` — the explainer and entry sheet for
 * month 5. Every figure is read from the dataset or the computed answer key.
 */
function renderProductsAndOrders(anchor: AnchorMonth): string {
  const expected = computeExpectedResults(anchor);
  const m5 = expectedMonth(expected, 5);
  const po1 = datasetOrder('PO1');
  const so1 = datasetOrder('SO1');
  const b13 = datasetDocByRef('B13');
  const b14 = datasetDocByRef('B14');
  const d1 = datasetDocByRef('D1');
  const i17 = datasetDocByRef('I17');
  const acc1 = WALKTHROUGH_DATASET.journals.find((j) => j.ref === 'ACC1');
  if (acc1 === undefined || acc1.repeat === null) throw new Error('walkthrough: no repeating journal ACC1');

  const mName = monthName(anchor, 5);
  const nextName = monthName(anchor, 6);
  const so1Cents = so1.lines.reduce((sum, l) => sum + lineCents(l), 0);
  const po1Cents = po1.lines.reduce((sum, l) => sum + lineCents(l), 0);
  const d1Cents = parseMoneyText(d1.total);
  const depositPercent = (d1Cents * 100) / so1Cents;
  const i17Cents = parseMoneyText(i17.total);
  const i17Cogs = stockCostCents(documentLines(i17));
  const accrualCents = acc1.lines.reduce((sum, l) => sum + parseMoneyText(l.debit), 0);
  const quoteDate = resolveDate(anchor, so1.month, so1.quoteDay ?? so1.day);
  const quoteValidUntil = shiftIsoDate(quoteDate, 400);
  const items = WALKTHROUGH_DATASET.stockItems;
  const rule = (n: string) => WALKTHROUGH_DATASET.bankRules.find((r) => r.name === n);

  let out =
    `# Month 5 — products, stock, orders and automation\n\n` +
    `## What month 5 is about\n\n` +
    `Months 1–4 sold services and expensed everything. Month 5 gives Harbor Point something to **stock**: ` +
    `${items.map((s) => `${s.name} (\`${s.code}\`)`).join(' and ')}. It buys them on a purchase order, sells them on a ` +
    `quote that becomes a sales order, takes a customer deposit before shipping, invoices the order in two ` +
    `deliveries, and lets AutoLedger do the repetitive bookkeeping for it — a bank rule for the monthly fee and ` +
    `interest, a recurring rent bill, and a utilities accrual that reverses itself.\n\n` +
    `Several steps this month post **nothing**: a purchase order, a quote and a sales order are all promises, not ` +
    `transactions. A bill or an invoice posts; stock and cost of sales follow the document. ` +
    `Work through the sections in order — each one builds on the one before.\n\n`;

  // ---- 2. imports
  out +=
    `## 1. Import the catalogue\n\n` +
    `**Accounting → Imports → New import.** Two files, in this order.\n\n` +
    `**Products & services** — \`products.csv\`: the two services Harbor Point bills by the hour. Kind ` +
    `**Products & services**. Both rows should stage as \`VALID\`; commit reads "Committed: ` +
    `${String(WALKTHROUGH_DATASET.products.length)} created, 0 filled in."\n\n` +
    "```csv\n" + productsCsv() + "```\n\n" +
    `**Set inventory up first.** The stock items below carry the category \`SPR\` (Stores & spares), which is ` +
    `created by the **Manufacturing** industry template. If you did not choose it in the setup wizard, do it ` +
    `now: **Settings → Inventory → Industry template** (the \`/inventory/setup\` page) → **Manufacturing**. ` +
    `The importer refuses a category that does not exist yet.\n\n` +
    `**Inventory items** — \`stock-items.csv\`: kind **Inventory items**. These are Products & Services that are ` +
    `*tracked* — each is created together with its stock record. There is no opening stock (the last four columns ` +
    `are blank): the shelves start empty and the first purchase fills them. Commit reads "Committed: ` +
    `${String(items.length)} items created, opening stock posted for 0."\n\n` +
    "```csv\n" + stockItemsCsv() + "```\n\n" +
    `The asset account (\`1140 Inventory\`) is where the stock sits on the balance sheet; the cost-of-goods-sold ` +
    `account (\`5050 Cost of Sales — Inventory\`) is where it goes when sold. Check them under **Products & ` +
    `inventory → Products & services** — all four codes should be listed. Nothing has posted: importing a ` +
    `catalogue creates records, not journal entries.\n\n`;

  // ---- 3. bank rules
  out +=
    `## 2. Create the bank rules\n\n` +
    `**Banking → Bank rules → New rule.** A bank rule settles a bank line you would otherwise post by hand, ` +
    `using the same "Post journal" path as months 1–4. It is applied automatically as a statement is imported ` +
    `(and on demand with **Apply to unmatched lines**). Two rules:\n\n` +
    `| Name | Priority | Direction | Memo contains | Max amount | Bank account | Post to | Journal description |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of WALKTHROUGH_DATASET.bankRules) {
    out += `| ${r.name} | ${String(r.priority)} | ${r.direction === 'IN' ? 'Money in' : 'Money out'} | \`${r.memoContains}\` | ${r.amountMaxCents === null ? '—' : money(r.amountMaxCents)} | ${accountName(r.bankAccountCode)} | ${accountName(r.targetAccountCode)} | ${r.description} |\n`;
  }
  const feeMax = rule('Monthly bank service charge')?.amountMaxCents ?? null;
  out +=
    `\nCreate them **before** importing statement 5. Two things worth knowing: a rule never overrides a document ` +
    `match — if a line has a document suggestion at or above the auto-match threshold, the suggestion wins; the ` +
    `rule only takes lines that would otherwise stay unmatched. And the *maximum amount*` +
    `${feeMax === null ? '' : ` (${money(feeMax)})`} on the fee rule is a safety ` +
    `limit — a large withdrawal that merely mentions "service charge" is left for a human.\n\n`;

  // ---- 4. PO1 -> B13
  out +=
    `## 3. Buy the stock — ${po1.ref} → ${b13.ref}\n\n` +
    `**Purchases → Purchase orders → New.** Vendor **${vendorName(po1.counterpartyKey)}**, order date ` +
    `${resolveDate(anchor, po1.month, po1.day)}. Pick each line from the item picker (type the code):\n\n` +
    orderLinesTable(po1.lines) +
    `Total ${money(po1Cents)}. **Save**, then **Confirm**. A purchase order is a *commitment*, not a debt: it ` +
    `posts **nothing**. Nothing is owed until the goods are invoiced.\n\n` +
    `When the supplier's invoice arrives, open the order and choose **Create bill**: bill date ` +
    `${resolveDate(anchor, b13.month, b13.day)}, due date ${resolveDate(anchor, b13.month, b13.day + b13.dueDays)}, ` +
    `vendor's invoice no. \`${resolveTokens(anchor, b13.vendorReference ?? '')}\`, all lines at the ordered quantities. ` +
    `Open the new draft expense (**Purchases → Expenses**) and take it through **Submit for approval → Approve**. ` +
    `This is **${b13.ref}** in \`04-bills-received.md\`.\n\n` +
    `Approving posts the bill — and, because both lines are stock items, it also **receives the stock**:\n\n` +
    postingTable([
      { account: accountName('1140'), debitCents: parseMoneyText(b13.total) },
      { account: accountName('2100'), creditCents: parseMoneyText(b13.total) },
    ]) +
    `The debit goes to \`1140 Inventory\` (an asset), not to an expense: buying stock is swapping cash for ` +
    `something you still own. Look under **Products & inventory → Stock movements** — one receipt per line, at ` +
    `its purchase cost.\n\n`;

  // ---- 5. QU1 -> SO1 -> D1 -> I17
  const stockLines = documentLines(i17);
  out +=
    `## 4. Sell the stock — ${so1.quoteRef ?? 'QU1'} → ${so1.ref} → ${d1.ref} → ${i17.ref}\n\n` +
    `**Sales → Quotes → New.** Customer **${customerName(so1.counterpartyKey)}**, quote date ${quoteDate}, ` +
    `**Valid until ${quoteValidUntil}**, title "Caster and fitting supply with installation". Lines:\n\n` +
    orderLinesTable(so1.lines) +
    `Total ${money(so1Cents)}. Leave "Deposit on acceptance" **blank** — this tutorial raises the deposit from the ` +
    `order instead (a deposit set on the quote would be dated today and locked against edits).\n\n` +
    `> **Hint:** *Valid until* is deliberately far in the future (a year and a bit). A quote's validity is ` +
    `checked against **today's real date**, not the date you typed as the quote date — and this scenario's ` +
    `dates are in the past. A normal 30-day quote would already have expired and could not be accepted.\n\n` +
    `Save, then **Send** → choose **Mark as sent — I'll print or send it myself** (nobody is being emailed here; ` +
    `the feature tour covers the email path). Then **Record acceptance**: accepted by \`Morgan Reyes\`. Then ` +
    `**Convert to…** → **Create a sales order**. A quote posts nothing, and neither does the order it becomes: ` +
    `**no revenue is recognised until the invoice** (IFRS 15 / ASC 606 — there is no contract performance to ` +
    `record until goods ship or work is done). The order is **${so1.ref}**.\n\n` +
    `### The deposit — ${d1.ref}\n\n` +
    `Open ${so1.ref} → **Request deposit** → basis: **${String(depositPercent)}%** of the order, document date ` +
    `${resolveDate(anchor, d1.month, d1.day)}, due date ${resolveDate(anchor, d1.month, d1.day + d1.dueDays)}. It ` +
    `creates a draft deposit invoice for **${money(d1Cents)}**; **Issue** it. Posting:\n\n` +
    postingTable([
      { account: accountName('1120'), debitCents: d1Cents },
      { account: accountName('2130'), creditCents: d1Cents },
    ]) +
    `The credit is to a **liability**, \`2130 Customer Deposits\`, not to revenue. Money (or a right to it) has ` +
    `arrived before Harbor Point has delivered anything, so it owes the customer either the goods or the money ` +
    `back — IFRS 15 calls this a *contract liability*. It leaves the balance sheet only when the order is ` +
    `invoiced and the deposit is applied against that invoice (month 6); the revenue itself is recognised on ` +
    `the invoice.\n\n` +
    `### The first delivery — ${i17.ref}\n\n` +
    `Open ${so1.ref} → **Create invoice**. Bill only part of the order: ` +
    `${stockLines.map((l) => `${l.itemCode ?? ''} **${l.quantity}**`).join(', ')}, and set the ` +
    `${so1.lines.filter((l) => !stockLines.some((s) => s.itemCode === l.itemCode)).map((l) => l.itemCode ?? '').join(', ')} line to **0** ` +
    `(it is billed with the second delivery). Document date ${resolveDate(anchor, i17.month, i17.day)}, due date ` +
    `${resolveDate(anchor, i17.month, i17.day + i17.dueDays)}. Then open the draft invoice and **Issue** it. This is ` +
    `**${i17.ref}** in \`05-invoices-to-raise.md\`. Issuing posts **two** things at once:\n\n` +
    `*The sale:*\n\n` +
    postingTable([
      { account: accountName('1120'), debitCents: i17Cents },
      { account: accountName('4100'), creditCents: i17Cents },
    ]) +
    `*The cost of what was sold — at moving average:*\n\n` +
    postingTable([
      { account: accountName('5050'), debitCents: i17Cogs },
      { account: accountName('1140'), creditCents: i17Cogs },
    ]) +
    `**Moving-average cost** means each item carries one running unit cost: after every purchase it is ` +
    `recalculated as (value of stock on hand) ÷ (quantity on hand), and a sale takes stock out at whatever that ` +
    `average is *at that moment* without changing it. Here each item was bought once, so its average is simply its ` +
    `purchase price (${items.map((s) => `${s.code} ${money(parseMoneyText(s.unitCost))}`).join(', ')}) — ` +
    `${stockLines.map((l) => `${l.quantity} × ${money(parseMoneyText(datasetStockItem(l.itemCode ?? '').unitCost))}`).join(' + ')} = ` +
    `${money(i17Cogs)}. The point of the second entry is the **matching principle**: the ${money(i17Cogs)} was an ` +
    `asset on the day it was bought; it becomes an expense on the day the revenue it earned is recognised, ` +
    `in the same period, so gross profit is not distorted.\n\n`;

  // ---- 6. B14 recurring + accrual
  const rentStart = resolveDate(anchor, 6, 1);
  out +=
    `## 5. Let AutoLedger repeat itself\n\n` +
    `### Rent — ${b14.ref}, made recurring\n\n` +
    `Enter ${b14.ref} like any bill from \`04-bills-received.md\`: **${vendorName(b14.counterpartyKey)}**, ` +
    `${resolveDate(anchor, b14.month, b14.day)}, due the same day, vendor reference ` +
    `\`${resolveTokens(anchor, b14.vendorReference ?? '')}\`, one line "${b14.lineDescription}" ` +
    `${money(parseMoneyText(b14.total))} to ${accountName(b14.accountCode)}. Note \`[Month]\` in the description: ` +
    `type it literally. A placeholder is replaced with the **document's month** when the bill is approved, so this ` +
    `one reads "Shop rent — ${mName}" and next month's copy will read "Shop rent — ${nextName}". Submit and approve ` +
    `${b14.ref}, then on its page choose **Make recurring**:\n\n` +
    `| Field | Value |\n|---|---|\n| Name | Shop rent |\n| Frequency | Monthly |\n| Every | 1 |\n| Start date | ${rentStart} |\n| End date | ${rentStart} |\n| Mode | Draft |\n\n` +
    `The end date equals the start date so the schedule makes exactly **one** more bill — month 6's rent — and ` +
    `stops. Mode **Draft** means each occurrence is created for you to approve, not posted by itself. Month 6 ` +
    `picks the draft up (\`10-closing-the-quarter.md\`).\n\n` +
    `> **Hint:** a schedule's occurrences are created by a background job that runs every 15 minutes, for dates up ` +
    `to today. Because this scenario's dates are in the past, the worker (if it is running) may create month 6's ` +
    `rent draft within minutes of your saving the schedule. That is fine — it is the same draft **Run now** ` +
    `would create; month 6 just opens it from the schedule's run list.\n\n` +
    `### Utilities — an accrual that reverses itself\n\n` +
    `Harbor Point's electricity and water for ${mName} will not be invoiced until early ${nextName}. Left alone, ` +
    `${mName}'s profit would be overstated and ${nextName}'s understated. Accrual accounting records the cost in ` +
    `the month it was **incurred**, so on the last working days of ${mName} you book an *estimate* — and cancel it ` +
    `the day after, so the real invoice does not count the cost twice.\n\n` +
    `**Accounting → Manual journals → Repeating tab → New repeating journal:**\n\n` +
    `| Field | Value |\n|---|---|\n| Name | Utilities accrual |\n| Narration | ${acc1.narration} |\n| First date | ${resolveDate(anchor, acc1.month, acc1.day)} |\n| Repeats | Monthly, every 1 |\n| End date | ${resolveDate(anchor, acc1.repeat.endMonth, acc1.repeat.endDay)} |\n| Reverse on the 1st of the next month | **ticked** |\n\n` +
    `| # | Account | Description | Debit | Credit |\n|---|---|---|---|---|\n` +
    acc1.lines.map((l, i) => `| ${String(i + 1)} | ${accountName(l.accountCode)} | ${l.description ?? ''} | ${parseMoneyText(l.debit) > 0 ? money(parseMoneyText(l.debit)) : ''} | ${parseMoneyText(l.credit) > 0 ? money(parseMoneyText(l.credit)) : ''} |`).join('\n') +
    `\n\nSave it, then open it under **Accounting → Recurring** and press **Run now**. Both occurrences are in the ` +
    `past, so both are created, each with its automatic reversal:\n\n` +
    `| Date | What | Debit | Credit |\n|---|---|---|---|\n` +
    `| ${resolveDate(anchor, acc1.month, acc1.day)} | Accrue ${mName}'s utilities | ${accountName('6110')} ${money(accrualCents)} | ${accountName('2120')} ${money(accrualCents)} |\n` +
    `| ${resolveDate(anchor, 6, 1)} | Reverse it | ${accountName('2120')} ${money(accrualCents)} | ${accountName('6110')} ${money(accrualCents)} |\n` +
    `| ${resolveDate(anchor, acc1.repeat.endMonth, acc1.repeat.endDay)} | Accrue ${nextName}'s utilities | ${accountName('6110')} ${money(accrualCents)} | ${accountName('2120')} ${money(accrualCents)} |\n` +
    `| ${resolveDate(anchor, 7, 1)} | Reverse that one | ${accountName('2120')} ${money(accrualCents)} | ${accountName('6110')} ${money(accrualCents)} |\n\n` +
    `Only the first row belongs to month 5. The next two land in month 6 (don't worry that they appear already — ` +
    `reports "as of" the end of month 5 ignore them), and the last is dated after the scenario ends, so ` +
    `\`2120 Accrued Liabilities\` closes month 6 still holding ${money(accrualCents)}: ${nextName}'s estimate. In ` +
    `month 6 the supplier's real ${mName} bill arrives and is expensed again; the reversal cancels it out, so ` +
    `${mName}'s cost is counted once, in ${mName}.\n\n` +
    `> The estimate is a manual journal, which is why it works: AutoLedger refuses manual postings to the ` +
    `receivable, payable, inventory, bank and credit-card accounts, but \`2120 Accrued Liabilities\` is an ordinary ` +
    `liability account.\n\n`;

  // ---- 7. statement + periods
  const closes = WALKTHROUGH_DATASET.periodCloses.find((c) => c.afterMonth === 5);
  out +=
    `## 6. Import statement 5 and lock the first four months\n\n` +
    `Now import \`statements/month-5-northwind-ISO.csv\` as in the tutorial (\`06-bank-statements.md\` lists every ` +
    `line). The service-charge and interest lines will already be **MATCHED** — your rules settled them on ` +
    `import; there is nothing to click. Resolve the rest as before.\n\n` +
    (closes === undefined
      ? ''
      : `Once ${mName} reconciles, **lock the books behind you**: **Accounting → Fiscal periods → Generate periods ` +
        `for this fiscal year** (if your six months cross a fiscal-year boundary, generate for both years), ` +
        `then **Close** the periods for ${closes.closeMonths.map((m) => monthName(anchor, m)).join(', ')}. A closed ` +
        `period refuses new postings; it can be reopened, so closing is a safety catch rather than a lock. Month 6 ` +
        `shows what the refusal looks like.\n\n`) +
    `## What to check\n\n` +
    `| After | Where | You should see |\n|---|---|---|\n`;
  const cast = po1.lines[0];
  const hfk = po1.lines[1];
  const soldQty = (code: string) => stockLines.filter((l) => l.itemCode === code).reduce((s, l) => s + Number(l.quantity), 0);
  if (cast === undefined || hfk === undefined) throw new Error('walkthrough: PO1 needs two lines');
  out +=
    `| ${b13.ref} approved | Products & inventory → Stock on hand | ${cast.itemCode ?? ''} **${cast.quantity}**, ${hfk.itemCode ?? ''} **${hfk.quantity}** |\n` +
    `| ${i17.ref} issued | Products & inventory → Stock on hand | ${cast.itemCode ?? ''} **${String(Number(cast.quantity) - soldQty(cast.itemCode ?? ''))}**, ${hfk.itemCode ?? ''} **${String(Number(hfk.quantity) - soldQty(hfk.itemCode ?? ''))}** |\n` +
    `| ${i17.ref} issued | Products & inventory → Valuation | Subledger and \`1140 Inventory\` both **${money(balanceCents(m5, '1140'))}**, ties out |\n` +
    `| ${d1.ref} issued | Reports → Trial balance (as of ${m5.asOf}) | \`2130 Customer Deposits\` **${money(balanceCents(m5, '2130'))}** credit |\n` +
    `| ${acc1.ref} run | Reports → Trial balance (as of ${m5.asOf}) | \`2120 Accrued Liabilities\` **${money(balanceCents(m5, '2120'))}** credit |\n` +
    `| ${i17.ref} issued | Sales → Sales orders → ${so1.ref} | Billing: **Partly billed** |\n` +
    `| Statement 5 resolved | Banking → Reconciliation | Difference **${money(m5.bankReconciliation.differenceCents)}**, Unmatched **${String(m5.bankReconciliation.unmatchedCount)}**, Ignored **${String(m5.bankReconciliation.ignoredCount)}** |\n\n` +
    `Then compare \`07-expected-results.md\` → Month 5. When it ties, continue with \`10-closing-the-quarter.md\`.\n`;
  return out;
}

// ------------------------------------- 10: closing the quarter (month 6)

/**
 * `10-closing-the-quarter.md` — month 6's explainer and entry sheet. Figures
 * come from the dataset or from `expected` (the computed answer key).
 */
function renderClosingTheQuarter(anchor: AnchorMonth, expected: ExpectedMonth[]): string {
  const m6 = expectedMonth(expected, 6);
  const mName = monthName(anchor, 6);
  const prevName = monthName(anchor, 5);
  const lakeshore = WALKTHROUGH_DATASET.extraVendors[0];
  if (lakeshore === undefined) throw new Error('walkthrough: no extra vendor');
  const b14 = datasetDocByRef('B14');
  const b15 = datasetDocByRef('B15');
  const i19 = datasetDocByRef('I19');
  const i20 = datasetDocByRef('I20');
  const d1 = datasetDocByRef('D1');
  const so1 = datasetOrder('SO1');
  const payroll = WALKTHROUGH_DATASET.journals.find((j) => j.ref === 'PR-M6');
  const application = WALKTHROUGH_DATASET.depositApplications.find((a) => a.documentRef === 'I20');
  if (payroll === undefined || application === undefined) throw new Error('walkthrough: month 6 data missing');
  const netPay = WALKTHROUGH_DATASET.noise.find((n) => n.month === 6 && n.description === 'PAYROLL NET PAY');
  if (netPay === undefined) throw new Error('walkthrough: no payroll net pay line');

  const i20Lines = documentLines(i20);
  const i20Cents = parseMoneyText(i20.total);
  const i20Cogs = stockCostCents(i20Lines);
  const revenueByAccount = new Map<string, number>();
  for (const l of i20Lines) revenueByAccount.set(l.accountCode, (revenueByAccount.get(l.accountCode) ?? 0) + lineCents(l));
  const appliedCents = parseMoneyText(application.amount);
  const i20Date = resolveDate(anchor, i20.month, i20.day);
  const i20Due = i20.dueDate === undefined ? i20Date : resolveDate(anchor, i20.dueDate.month, i20.dueDate.day);
  const payrollCredit = payroll.lines.reduce((sum, l) => sum + parseMoneyText(l.credit), 0);
  const netPayCents = Math.abs(parseMoneyText(netPay.amount));
  const lastDay = lastDayOfWalkthroughMonth(anchor, 6);
  const kestrel = customerName(i20.counterpartyKey);
  const closes = WALKTHROUGH_DATASET.periodCloses.find((c) => c.afterMonth === 6);

  let out =
    `# Month 6 — closing the quarter\n\n` +
    `## What month 6 is about\n\n` +
    `The last month finishes what month 5 started and then **closes the books**: the recurring rent arrives as a ` +
    `draft, the rest of ${prevName}'s order is invoiced with the customer's deposit applied, a new vendor is ` +
    `added by form, two files of bills and invoices and a payroll journal are *imported* instead of typed, and ` +
    `${prevName} is locked.\n\n`;

  // 1. vendor
  out +=
    `## 1. A new vendor, by hand\n\n` +
    `**Purchases → Vendors → New vendor.** ${lakeshore.name} is not in \`vendors.csv\` — it is the one party you ` +
    `add with the form, the way you would for a supplier who turns up mid-year:\n\n` +
    `| Field | Value |\n|---|---|\n| Name | ${lakeshore.name} |\n| Email | ${lakeshore.email} |\n| Phone | ${lakeshore.phone} |\n| Billing address | ${lakeshore.address} |\n| Tax number | ${lakeshore.taxNumber} |\n\n` +
    `Leave payment terms and notes blank — the bills below carry explicit due dates. The vendor must exist ` +
    `**before** the bill import in section 3: an import matches its *ContactName* column against existing ` +
    `vendors by name.\n\n`;

  // 2. rent
  out +=
    `## 2. Approve the generated rent — ${b15.ref}\n\n` +
    `**Accounting → Recurring → Shop rent.** The schedule made in month 5 is due now. If the worker has not already ` +
    `created the draft, press **Run now** — it creates exactly one bill, dated ${resolveDate(anchor, b15.month, b15.day)}. ` +
    `Open it from the schedule's run list (or **Purchases → Expenses**) and check three things:\n\n` +
    `- the line reads "${b14.lineDescription}" — the placeholder is still there, because a draft keeps the text as ` +
    `written;\n` +
    `- the amount is ${money(parseMoneyText(b15.total))} to ${accountName(b15.accountCode)}, due the same day;\n` +
    `- its vendor reference carries the run date (the schedule adds it to ${b14.ref}'s reference so the two bills ` +
    `cannot clash). Replace it with \`${resolveTokens(anchor, b15.vendorReference ?? '')}\`, the number on the landlord's ` +
    `${mName} invoice — it is a draft, so it is editable.\n\n` +
    `**Submit for approval → Approve.** Now open the posted bill: the line reads **"Shop rent — ${mName}"**. ` +
    `\`[Month]\` was replaced with the month of the *document date* at the moment of approval — which is why a ` +
    `recurring bill can be written once and read correctly every month. Nothing is replaced in a draft, and ` +
    `nothing placeholder-shaped can reach a posted document.\n\n`;

  // 3. imports
  const importedInvoices = WALKTHROUGH_DATASET.invoices.filter((d) => d.month === 6 && d.entry === 'IMPORT');
  const importedBills = WALKTHROUGH_DATASET.bills.filter((d) => d.month === 6 && d.entry === 'IMPORT');
  out +=
    `## 3. Import the documents — and the payroll journal\n\n` +
    `Three more imports through **Accounting → Imports → New import**. The two document imports offer a choice ` +
    `on the preview screen: **Import as drafts** or **Import and post**. Choose **Import and post** with ` +
    `**Each document's own date** — the files arrive as finished, dated documents, exactly like the ones you typed ` +
    `in months 1–5. (To review before anything posts, import as drafts instead and issue ` +
    `them yourself.)\n\n` +
    `### Invoices — \`invoices-month-6.csv\` (kind **Invoices**)\n\n` +
    `Creates and issues ${importedInvoices.map((d) => d.ref).join(' and ')}. Only the item code, description and ` +
    `quantity are given: the **unit price and revenue account come from the Products & services record** ` +
    `(\`SVC-DES\` ${money(parseMoneyText(WALKTHROUGH_DATASET.products.find((p) => p.code === 'SVC-DES')?.salePrice ?? '0'))}, ` +
    `\`SVC-FAB\` ${money(parseMoneyText(WALKTHROUGH_DATASET.products.find((p) => p.code === 'SVC-FAB')?.salePrice ?? '0'))}, ` +
    `both to 4200). That is the practical reason to import products first.\n\n` +
    "```csv\n" + invoicesCsv(anchor, 6) + "```\n\n" +
    `Expect ${importedInvoices.map((d) => `${d.ref} ${money(parseMoneyText(d.total))}`).join(' and ')}.\n\n` +
    `### Expenses — \`bills-month-6.csv\` (kind **Expenses (bills)**)\n\n` +
    `Creates and approves ${importedBills.map((d) => d.ref).join(', ')}. Unlike the invoices these carry their own ` +
    `unit amount and account, because a supplier's bill has no catalogue price behind it. Text in an imported ` +
    `document is taken **literally** — the file already says "${mName}" where the typed bills said ` +
    `\`[Month]\`; a placeholder in an imported file would not be replaced.\n\n` +
    "```csv\n" + billsCsv(anchor, 6) + "```\n\n" +
    `### Payroll — \`payroll-month-6.csv\` (kind **Journal entries**)\n\n` +
    `Three rows with the same journal number are **one** entry; it posts immediately and cannot be edited ` +
    `(correct it with a reversal, as always):\n\n` +
    "```csv\n" + payrollJournalCsv(anchor) + "```\n\n" +
    postingTable([
      ...payroll.lines
        .filter((l) => parseMoneyText(l.debit) > 0)
        .map((l) => ({ account: accountName(l.accountCode), debitCents: parseMoneyText(l.debit) })),
      ...payroll.lines
        .filter((l) => parseMoneyText(l.credit) > 0)
        .map((l) => ({ account: accountName(l.accountCode), creditCents: parseMoneyText(l.credit) })),
    ]) +
    `The wages are expensed (shop-floor labour to cost of sales, the rest to operating expenses) and the whole ` +
    `${money(payrollCredit)} is owed — to employees and, for the part withheld from their pay, to tax authorities — ` +
    `until it is paid. When the bank line for net pay arrives (section 5) it clears only ` +
    `${money(netPayCents)} of that liability; the remaining **${money(payrollCredit - netPayCents)}** stays in ` +
    `\`2160 Payroll Liabilities\` until it is remitted. (A simplification: real payroll also has employer-side ` +
    `taxes and benefits, which are out of scope here.)\n\n`;

  // 4. I20
  out +=
    `## 4. Invoice the rest of the order — ${i20.ref}, with the deposit applied\n\n` +
    `Open **Sales → Sales orders → ${so1.ref}**: billing reads **Partly billed**. **Create invoice** — leave ` +
    `every quantity at what remains (${i20Lines.map((l) => `${l.itemCode ?? ''} ${l.quantity}`).join(', ')}), ` +
    `document date ${i20Date}, due date **${i20Due}** (${String(daysBetweenIso(i20Date, i20Due))} days). Open the draft and ` +
    `**Issue** it. Because ${kestrel} has an open deposit, the dialog **offers it**: choose ${d1.ref} and apply ` +
    `**${money(appliedCents)}**, then confirm. (If you issued without applying it, the invoice page has an ` +
    `**Apply deposit** button.)\n\n` +
    `Issuing posts the sale and the cost of the stock sold, exactly as for ${datasetDocByRef('I17').ref}:\n\n` +
    postingTable([
      { account: accountName('1120'), debitCents: i20Cents },
      ...[...revenueByAccount.entries()].map(([code, cents]) => ({ account: accountName(code), creditCents: cents })),
    ]) +
    postingTable([
      { account: accountName('5050'), debitCents: i20Cogs },
      { account: accountName('1140'), creditCents: i20Cogs },
    ]) +
    `Applying the deposit posts one more entry — the liability is settled against the receivable:\n\n` +
    postingTable([
      { account: accountName('2130'), debitCents: appliedCents },
      { account: accountName('1120'), creditCents: appliedCents },
    ]) +
    `This is where the deposit *stops being a liability*: revenue is recognised on the invoice, for the full ` +
    `${money(i20Cents)} above, and the ${money(appliedCents)} the customer already paid now settles that much ` +
    `of it. \`2130 Customer Deposits\` returns to zero, and the invoice shows amount due ` +
    `**${money(i20Cents - appliedCents)}**. This invoice stays open: it is not paid inside the scenario, and it ` +
    `is not yet due (${i20Due}), so it sits in the **Current** aging bucket.\n\n` +
    `> **Hint:** the stock was already costed at the moving average when ${datasetDocByRef('I17').ref} was issued ` +
    `and nothing was bought since, so ${i20.ref}'s cost of sales is the same unit costs again.\n\n`;

  // 5. statement 6
  out +=
    `## 5. Import statement 6\n\n` +
    `\`statements/month-6-meridian-DMY.csv\` (date format **DMY**) — see \`06-bank-statements.md\` for every line. ` +
    `The fee and interest lines are settled by your month 5 bank rules on import. The net-pay line, ` +
    `\`${netPay.description}\` ${money(parseMoneyText(netPay.amount))}, has no document behind it: **Post journal → ` +
    `${accountName('2160')}**, which clears the net pay against the liability the payroll journal created. ` +
    `${i19.ref} (${customerName(i19.counterpartyKey)}) is paid through a card processor and shows as ` +
    `\`${i19.anonMemo ?? ''}\`: the memo carries no customer name, so the matcher can only suggest on the ` +
    `amount (${money(parseMoneyText(i19.total))}) — check it, then match it yourself.\n\n`;

  // 6. checks
  const ar = balanceCents(m6, '1120');
  out +=
    `## 6. Check your work\n\n` +
    `**Inventory.** *Products & inventory → Valuation*, as of ${lastDay}: the stock subledger and ` +
    `\`1140 Inventory\` both read **${money(balanceCents(m6, '1140'))}**, the page says they tie out. Two ` +
    `different records — what the warehouse says it holds and what the ledger says it is worth — agreeing is ` +
    `the whole point of perpetual inventory.\n\n` +
    `**The customer.** *Sales → Statements → ${kestrel}* → **Outstanding**, as at ${lastDay}: **${money(ar)}**, ` +
    `which is ${i20.ref} (${money(i20Cents)}) less the applied deposit (${money(appliedCents)}).\n\n` +
    `**The numbers the answer key insists on:**\n\n` +
    `| Account / report | At ${lastDay} |\n|---|---|\n` +
    `| ${accountName('1140')} | ${money(balanceCents(m6, '1140'))} |\n` +
    `| ${accountName('2130')} | ${money(balanceCents(m6, '2130'))} |\n` +
    `| ${accountName('2120')} | ${money(balanceCents(m6, '2120'))} |\n` +
    `| ${accountName('2160')} | ${money(balanceCents(m6, '2160'))} |\n` +
    `| ${accountName('1120')} (all of it ${i20.ref}) | ${money(ar)} |\n` +
    `| ${accountName('2100')} | ${money(balanceCents(m6, '2100'))} |\n` +
    `| ${accountName('5050')} (cumulative) | ${money(m6.profitAndLoss.costOfSales.find((r) => r.code === '5050')?.amountCents ?? 0)} |\n\n` +
    `Compare the rest with \`07-expected-results.md\` → Month 6.\n\n`;

  // 7. close
  const closeMonths = closes === undefined ? [] : closes.closeMonths.map((m) => monthName(anchor, m));
  const testDate = resolveDate(anchor, 5, 15);
  out +=
    `## 7. Close ${closeMonths.join(', ')} and try to break it\n\n` +
    `**Accounting → Fiscal periods → Close** on the ${closeMonths.join(', ')} period${closeMonths.length === 1 ? '' : 's'}. ` +
    `Now try to post something into it: **Accounting → Manual journals → New**, dated ${testDate}, any two ` +
    `balanced lines, **Post**. AutoLedger refuses — the period is closed. (The Reports are now stable too: a ` +
    `late entry can no longer change a month you have already reported.) Nothing should be saved; if a draft ` +
    `is left behind, delete it. Closing is reversible — **Reopen** exists — whereas a *locked* period is not; this scenario ` +
    `only closes.\n\n` +
    `That is the quarter: six months, every ledger figure agreeing with \`07-expected-results.md\`.\n`;
  return out;
}

// ---------------------------------------------------- 11: the feature tour

/**
 * `11-feature-tour.md` — an unscored tour of features that do not move the
 * ledger. Hand-written prose (no scenario figures live here except the few
 * read from the dataset); each nav path exists in `client/.../layout/nav.ts`
 * or the Settings hub.
 */
function renderFeatureTour(): string {
  const kestrel = customerName('kestrel-logistics');
  const b18 = datasetDocByRef('B18');
  const supplier = vendorName(b18.counterpartyKey);
  return (
    `# Feature tour (optional, unscored)\n\n` +
    `Do this **after month 6**. Nothing here changes \`07-expected-results.md\` — **except** where a step is ` +
    `flagged **⚠ changes the answer key**; those you either skip, undo, or do in the second organization from ` +
    `section 11. Each section says what to do, what you should see, and — where it needs something outside the ` +
    `app — what it needs. Sections marked *optional* need credentials or services you may not have.\n\n` +
    `The sidebar groups are named as they appear in the app: Overview, Sales, Purchases, Products & inventory, ` +
    `Banking, Accounting, Reports, Workspace. **Settings** (bottom of the sidebar) is a hub of cards; its card ` +
    `names are used below.\n\n---\n\n` +
    `## 1. Organization profile and logo\n\n` +
    `**Do this:** **Settings → Organization → Profile**. Fill in the postal address and tax numbers and upload a ` +
    `logo (any small PNG or JPEG).\n\n` +
    `**You should see:** the details on the page after saving, and — in section 2 — the logo and address on the ` +
    `invoice preview. The logo is stored in the Document Vault (**Workspace → Documents**).\n\n` +
    `## 2. The invoice template\n\n` +
    `**Do this:** **Settings → Sales → Invoice template**. Switch between **Classic**, **Modern** and ` +
    `**Compact**; change the document title, font, density, accent colour, bank details and footer notes; try \`[Month]\` in the footer notes — placeholders in template text are filled as a document renders.\n\n` +
    `**You should see:** a live preview beside the form that is the *same component* your real invoices print ` +
    `with. Open any invoice (**Sales → Invoices**, e.g. one for ${kestrel}) and compare. Layouts are a fixed set of ` +
    `three — there is no free-form template editor.\n\n` +
    `## 3. Payment terms\n\n` +
    `**Do this:** **Settings → Sales → Payment terms**. Add a term whose rule is **Day of month … of the ` +
    `following month** with day **20** ("20th of next month"). Then **Settings → Accounting → Financial** and ` +
    `choose it under **Default terms — sales** (or bills).\n\n` +
    `**You should see:** a new draft invoice (**Sales → Invoices → New**) start with that term and compute the ` +
    `due date for you — an invoice dated the 10th falls due the 20th of the *next* month. ` +
    `**⚠ changes the answer key** only if you create and issue documents afterwards; a draft you never issue ` +
    `changes nothing. Setting the default back afterwards is tidy.\n\n` +
    `## 4. Quotes: settings, emails, PDF, public acceptance *(optional)*\n\n` +
    `**Needs:** Mailpit, a local inbox. From the repo root \`docker compose --profile mail up -d mailpit\`, put ` +
    `\`MAIL_TRANSPORT=mailpit\` in \`server/.env\`, restart the server **and the worker** (the worker sends), then ` +
    `open http://localhost:8025.\n\n` +
    `**Do this:** **Settings → Sales → Invoicing**: set the quote prefix, default validity and default terms. ` +
    `**Settings → Sales → Quote emails**: edit the template. Create a quote (**Sales → Quotes → New**) for ` +
    `${kestrel} with *your* email address, **Send → Email a review link**, then **Download PDF** from the quote ` +
    `page.\n\n` +
    `**You should see:** the email in Mailpit; open its link in a private window — the public \`/quote/…\` ` +
    `page, no sign-in — type a name, tick the terms, **Accept**. Back in the app the quote shows the acceptance ` +
    `with the time, IP and a content hash. With **Invoicing → require an emailed code** ticked, accepting also ` +
    `asks for a 6-digit code mailed to the recipient. (That proves control of an email address — it is not a ` +
    `qualified electronic signature.) A quote never posts; **⚠ converting it does create a draft** — delete it.\n\n` +
    `## 5. A purchase quote becomes a bill\n\n` +
    `**Do this:** **Purchases → Purchase quotes → New** for any vendor with one line; **Send → Mark as sent**, ` +
    `**Record acceptance**, then **Convert to expense**.\n\n` +
    `**You should see:** a *draft* expense in **Purchases → Expenses** — and nothing in the trial balance. ` +
    `**⚠ changes the answer key if you approve it. Delete the draft afterwards.**\n\n` +
    `## 6. Customer statements\n\n` +
    `**Do this:** **Sales → Statements**. Open ${kestrel}: switch between **Outstanding** and **Activity**, ` +
    `pick an "as at" date. Back on the list, tick several customers and use **Print** (bulk print) and **Email**. ` +
    `Edit the layout under **Settings → Sales → Statement template** and the email wording under **Settings → ` +
    `Sales → Statement emails**.\n\n` +
    `**You should see:** Outstanding equals the customer's ledger balance on that date. With Mailpit running, the ` +
    `email carries a **Review and pay** link to a public \`/statement/…\` page. *Optional:* with Stripe **test** ` +
    `keys in \`server/.env\` (\`STRIPE_SECRET_KEY\`, \`STRIPE_PUBLISHABLE_KEY\`; the server refuses live keys ` +
    `outside production) that page offers card payment — use Stripe's test card 4242 4242 4242 4242. ` +
    `**⚠ a completed payment records a receipt and changes the answer key.** Stop at the form.\n\n` +
    `## 7. Attachments\n\n` +
    `**Do this:** upload a PDF or image under **Workspace → Documents**. Open the expense for ${supplier} (` +
    `${b18.ref}, **Purchases → Expenses**) and, in its **Attachments** panel, attach it from the Vault. While ` +
    `*drafting* a new bill or invoice you can attach files before it is saved.\n\n` +
    `**You should see:** the file listed on the document, downloadable, with the Vault page showing where it is ` +
    `used. Attaching changes no figure — it is a link, and posted documents stay immutable.\n\n` +
    `## 8. Credits offered on approval\n\n` +
    `**Do this:** you have already met it — issuing month 6's last invoice offered the customer's deposit. The ` +
    `same dialog appears when you **Approve** a bill and the vendor has an open debit note or prepayment. To ` +
    `see the purchase side without touching this organization, use the second organization from section 11: ` +
    `approve and pay a bill, issue a debit note against it (the whole note becomes unapplied credit because the ` +
    `bill is already paid), then approve a second bill for the same vendor.\n\n` +
    `**You should see:** the dialog listing the credit with an amount to apply; applying it happens in the same ` +
    `step as approval and reduces the new bill's amount due.\n\n` +
    `## 9. Members, invitations and roles\n\n` +
    `**Do this:** **Settings → Organization → Members & invitations → Invite someone**: an email address and a ` +
    `role. The invitation is a **copyable link** (and, with Mailpit, an email). Then **Settings → Organization ` +
    `→ Roles & permissions → New role**: build a read-only role from the \`… view\` permissions only. Invite a ` +
    `second email with that role, open the link in a private window and sign in (or register) **as that exact ` +
    `email** — accepting needs both the link and the matching signed-in email.\n\n` +
    `**You should see:** the invitee's sidebar shrink to the pages their role can view, and the server refuse ` +
    `anything else. Back as owner, change the invitee's role on the Members page — it applies on their next ` +
    `request, no re-login. An organization can never be left without an owner.\n\n` +
    `## 10. Email settings, notifications and sessions\n\n` +
    `**Do this:** **Settings → Organization → Email**: the sender name and reply-to for mail the app sends. Then ` +
    `the user menu (top right) → **Account settings**: the **Notifications** tab (a bill awaiting approval, an ` +
    `invitation accepted), **Sessions** (every device you are signed in on; sign out the others), **Password**.\n\n` +
    `**You should see:** preferences saved per user, not per organization; sessions listed with the current one ` +
    `marked.\n\n` +
    `## 11. A second organization\n\n` +
    `**Do this:** the organization name in the top bar → **Add organization**. It has its own setup wizard and ` +
    `its own chart of accounts. Switch between the two from the same menu; **Account settings → Organizations** ` +
    `lists them and lets you leave one.\n\n` +
    `**You should see:** complete separation — different data, different members, different numbering. This is ` +
    `the same tenant boundary every query in the server is filtered by. Use this organization for anything flagged ` +
    `**⚠** above.\n\n` +
    `## 12. Bill inbox and email-in *(optional)*\n\n` +
    `**Needs:** a vision-model key — \`ANTHROPIC_API_KEY\`, or \`CAPTURE_AI_PROVIDER=gemini\` plus ` +
    `\`GEMINI_API_KEY\` — in \`server/.env\`. Email-in additionally needs \`INBOUND_MAIL=brevo\` and a Brevo ` +
    `inbound domain (see \`docs/development.md\`); without it that card says so.\n\n` +
    `**Do this:** **Purchases → Bill inbox**: upload a photo or PDF of a supplier bill. **Purchases → Review ` +
    `queue** shows what needs a human. **Settings → Bill inbox** has auto-post and the email-in address; **AI ` +
    `usage** shows tokens and cost per call.\n\n` +
    `**You should see:** a draft expense with the extracted fields; faces and ID numbers are masked in the page ` +
    `image *before* anything leaves your machine. **⚠ posting it changes the answer key** — leave it unposted ` +
    `or use the second organization. Uploading the same file twice lands a visible duplicate that is not ` +
    `re-extracted until you confirm.\n\n` +
    `## 13. Inventory: labels, QR lookup, movements\n\n` +
    `**Do this:** **Products & inventory → Stock movements** (the receipts and sales from months 5–6, with cost) ` +
    `and **Stock on hand** (open an item for its history). **Labels**: pick an item and print its QR label. ` +
    `**Lookup**: paste the QR's text, or scan it with a keyboard-wedge scanner.\n\n` +
    `**You should see:** a label whose QR contains only a route and an id — nothing business-identifying — and ` +
    `Lookup resolving it to the item.\n\n` +
    `## 14. Reports, theme and the command palette\n\n` +
    `**Do this:** **Reports → General journal** lists every posting from every source (invoices, bills, bank ` +
    `lines, imports, the accrual) — the ledger as a journal; open any row to its source document. Use the theme ` +
    `button in the top bar (light / dark / system). Press **⌘K** (Ctrl+K elsewhere) and type "trial".\n\n` +
    `**You should see:** the journal reconcile to the trial balance, the theme switch without a flash, and the ` +
    `palette jump straight to any page you have permission for.\n`
  );
}

// ------------------------------------------------------------------ main

function main(): void {
  const args = process.argv.slice(2);
  const anchorIndex = args.indexOf('--anchor');
  const anchor: AnchorMonth = anchorIndex === -1 ? defaultAnchor() : parseAnchor(args[anchorIndex + 1] ?? '');

  const resolved = resolveSettlementLines(anchor);
  const expected = computeExpectedResults(anchor);

  write('README.md', renderReadme());
  write('TUTORIAL.md', renderTutorial(expected));
  write('00-the-business.md', renderTheBusiness());
  write('01-setup.md', renderSetup());
  write('02-vendors.md', renderVendors());
  write('03-customers.md', renderCustomers());
  write('vendors.csv', vendorsCsv());
  write('customers.csv', customersCsv());
  write('04-bills-received.md', renderDocuments(anchor, WALKTHROUGH_DATASET.bills, 'bill'));
  write('05-invoices-to-raise.md', renderDocuments(anchor, WALKTHROUGH_DATASET.invoices, 'invoice'));
  write('06-bank-statements.md', renderBankStatements(anchor, resolved));
  write('07-expected-results.md', renderExpectedResults(expected));
  write('08-returns-and-adjustments.md', renderAdjustments(anchor));
  write('09-products-orders-and-stock.md', renderProductsAndOrders(anchor));
  write('10-closing-the-quarter.md', renderClosingTheQuarter(anchor, expected));
  write('11-feature-tour.md', renderFeatureTour());
  write('accounts.csv', accountsCsv());
  write('products.csv', productsCsv());
  write('stock-items.csv', stockItemsCsv());
  write('invoices-month-6.csv', invoicesCsv(anchor, 6));
  write('bills-month-6.csv', billsCsv(anchor, 6));
  write('payroll-month-6.csv', payrollJournalCsv(anchor));
  write('statements/month-1-northwind-ISO.csv', statement1(anchor, resolved));
  write('statements/month-2-meridian-DMY.csv', statement2(anchor, resolved));
  write('statements/month-3-cascade-MDY.csv', statement3(anchor, resolved));
  write('statements/month-4-northwind-ISO.csv', statement4(anchor, resolved));
  write('statements/month-5-northwind-ISO.csv', statement5(anchor, resolved));
  write('statements/month-6-meridian-DMY.csv', statement6(anchor, resolved));

  console.log(`[walkthrough] done — anchor ${String(anchor.year)}-${String(anchor.month).padStart(2, '0')}, ${String(lastDayOfWalkthroughMonth(anchor, 6))} last day`);
}

main();
