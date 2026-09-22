import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WALKTHROUGH_DATASET, type DatasetDocument, type DatasetNote } from './walkthroughDataset.js';
import { resolveSettlementLines, type ResolvedSettlementLine } from './walkthroughTiers.js';
import { computeExpectedResults, type ExpectedMonth, type ExpectedStatementRow } from './walkthroughExpected.js';
import { parseAnchor, defaultAnchor, resolveDate, lastDayOfWalkthroughMonth, type AnchorMonth, type WalkthroughMonth } from './walkthroughDates.js';
import { money, statement1, statement2, statement3, statement4 } from './walkthroughStatements.js';
import { vendorsCsv, customersCsv } from './walkthroughParties.js';
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
 * folder is meant to be worked through by a human at the LedgerCore UI
 * (typing a bill or invoice in by hand, uploading a CSV through the
 * importer screens), and is committed as plain, reviewable files. Contrast
 * `sandbox/`, which is replayed through services by a seeder (see
 * `walkthrough/README.md` and `sandbox/README.md`, which cross-reference
 * each other).
 */

// process.cwd() === server/ for every npm script, the same convention
// sandboxManifest.ts's SANDBOX_ROOT relies on.
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
  const v = WALKTHROUGH_DATASET.vendors.find((x) => x.key === key);
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
  };
  const name = DEFAULT_NAMES[code];
  if (name === undefined) throw new Error(`no display name for account ${code}`);
  return name;
}

// ------------------------------------------------------------ markdown sheets

function renderVendors(): string {
  return (
    `# Vendors to import\n\n` +
    `All six vendors ship as one CSV, \`vendors.csv\`, imported through the customer/vendor migration importer ` +
    `(Phase 24) rather than typed in one at a time — the same importer a business migrating off another system ` +
    `would use for real. Payment terms: **Due on receipt** for all six.\n\n` +
    `**Data migration → Imports → New import.** Kind: **Vendors**. Upload \`vendors.csv\`, or paste its ` +
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
    `**Data migration → Imports → New import.** Kind: **Customers**. Upload \`customers.csv\`, or paste its ` +
    `contents (shown below) into a new file and upload that. It should stage all 6 rows as \`VALID\` and the ` +
    `import should read \`VALIDATED\`. Preview, then Commit.\n\n` +
    "```csv\n" +
    customersCsv() +
    "```\n"
  );
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
      ? `# Invoices to raise\n\nRaise each of these against the customer named, in the order shown, then **Issue** it — the matcher only considers an invoice once it is \`ISSUED\`. LedgerCore assigns the invoice number itself from the numbering settings; there is no "their invoice number" field to fill in.\n\n`
      : `# Bills received\n\nEnter each of these against the vendor named, in the order shown, then take it through **Submit for approval → Approve**. The matcher only considers a bill once it is \`POSTED\`.\n\n`;

  let out = intro;
  let currentMonth = 0;
  for (const doc of docs) {
    if (doc.month !== currentMonth) {
      currentMonth = doc.month;
      out += `${monthHeading(doc.month as WalkthroughMonth)}\n\n`;
    }
    const date = resolveDate(anchor, doc.month, doc.day);
    const dueDate = resolveDate(anchor, doc.month, doc.day + doc.dueDays);
    const counterparty = kind === 'invoice' ? customerName(doc.counterpartyKey) : vendorName(doc.counterpartyKey);
    const cents = parseMoneyText(doc.total);
    out += `### ${doc.ref} · ${counterparty}\n\n`;
    out += `| | |\n|---|---|\n`;
    if (kind === 'bill') out += `| **Their bill number** | \`${doc.vendorReference ?? ''}\`  ← enter as the vendor reference |\n`;
    out += `| **${kind === 'invoice' ? 'Issue date' : 'Bill date'}** | ${date} |\n`;
    out += `| **Terms** | Due on receipt |\n`;
    out += `| **Due date** | ${dueDate} |\n\n`;
    out += `| # | Description | Qty | Unit price | Account |\n|---|---|---|---|---|\n`;
    out += `| 1 | ${doc.lineDescription} | 1 | ${money(cents)} | ${accountName(doc.accountCode)} |\n\n`;
    out += `**Total: ${money(cents)}**\n\n`;
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
    `Four months, three different banks, three different export formats. Import each one against ` +
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
    `\`08-returns-and-adjustments.md\` **before** importing this statement.\n\n---\n\n`;

  for (const m of [1, 2, 3, 4] as const) {
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
    `project's own test suite — against the real LedgerCore reports produced by replaying this exact scenario ` +
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
    `1. Register a **fresh** organization — any name, base currency **USD**. Registration seeds the default 45-account chart automatically. On the next screen, choose at least **LedgerCore** and click **Continue**.\n` +
    `2. Go to **Accounts** and create one new account:\n\n` +
    `   | Field | Value |\n   |---|---|\n   | Code | \`4300\` |\n   | Name | Interest Income |\n   | Type | Revenue |\n   | Parent | \`4000 Revenue\` |\n   | Postable | Yes |\n\n` +
    `3. Do **not** run the sandbox demo loader or the opening-balance importer into this organization — the scenario assumes zero opening cash, and both of those would add balances this pack's answer key does not account for.\n`
  );
}

function renderTheBusiness(): string {
  return (
    `# Harbor Point Fabrication\n\n` +
    `${WALKTHROUGH_DATASET.businessDescription}\n\n` +
    `**Period:** four consecutive months, entered one at a time — the fourth is about returns and ` +
    `adjustments (credit and debit notes). **Currency:** USD throughout.\n\n` +
    `**Scope.** This scenario covers the accounts-receivable / accounts-payable / cash cycle — invoicing, ` +
    `billing, and bank reconciliation. It does not include payroll, fixed assets or depreciation, inventory, ` +
    `accruals or prepayments, or a year-end close. One bank account, one currency.\n\n` +
    `## Accounts this scenario touches\n\n` +
    `| Account | Why |\n|---|---|\n` +
    `| 1110 Operating Cash | Every deposit and withdrawal |\n` +
    `| 1120 Accounts Receivable | What customers owe between invoice and payment |\n` +
    `| 2100 Accounts Payable | What's owed to vendors between bill approval and payment |\n` +
    `| 3100 Common Stock / Owner's Capital | The founder's opening deposit |\n` +
    `| 4100 Product Revenue, 4200 Service Revenue | The two ways Harbor Point bills customers |\n` +
    `| 4300 Interest Income | The one account you create by hand — see 01-setup.md |\n` +
    `| 4800 Sales Returns & Allowances | Month 4's credit notes — a contra-revenue account |\n` +
    `| 5100 Direct Materials, 5300 Freight & Duty | Cost of sales |\n` +
    `| 6110, 6120, 6200, 6400 | Rent, software, professional fees, marketing |\n` +
    `| 6600 Bank Fees | Wire fees and monthly service charges |\n`
  );
}

function renderReadme(): string {
  return (
    `# Walkthrough: Harbor Point Fabrication\n\n` +
    `A complete, four-month accounting scenario for LedgerCore — a vendor and a customer CSV to import, source ` +
    `documents to enter by hand, four bank statements to import, credit and debit notes in the fourth month, and ` +
    `a computed answer key to check your work against.\n\n` +
    `**Start with \`TUTORIAL.md\`** — it walks the whole thing start to finish with hints. The files below are ` +
    `its reference material, useful to come back to on their own:\n\n` +
    `- \`00-the-business.md\` — who Harbor Point Fabrication is\n` +
    `- \`01-setup.md\` — organization registration, the one account to create by hand\n` +
    `- \`02-vendors.md\`, \`03-customers.md\` — the CSV import steps, with the CSV shown inline\n` +
    `- \`04-bills-received.md\`, \`05-invoices-to-raise.md\` — the source documents, in order\n` +
    `- \`06-bank-statements.md\` — what each statement is and the per-line action to take\n` +
    `- \`07-expected-results.md\` — the answer key\n` +
    `- \`08-returns-and-adjustments.md\` — month 4: what credit and debit notes are, when you need one, their ` +
    `journal entries, and the three notes to enter\n` +
    `- \`vendors.csv\`, \`customers.csv\` — the two files to import via Data migration → Imports\n` +
    `- \`statements/\` — the four CSV files to import via Bank Imports\n\n` +
    `**Run order:** import all 6 vendors and all 6 customers once, up front, via **Data migration → ` +
    `Imports** in the left sidebar. Then, one month at a time — enter that month's bills (submit + approve), enter that month's ` +
    `invoices (issue), import that month's statement, resolve every line, check the reconciliation report, ` +
    `check that month's figures against \`07-expected-results.md\` — before moving to the next month. In ` +
    `month 4, issue the notes in \`08-returns-and-adjustments.md\` after entering that month's documents and ` +
    `**before** importing its statement. ` +
    `Suggestions are generated at import time against documents that are open right then, so a month's ` +
    `documents must exist before its statement is imported.\n\n` +
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
    `You are Harbor Point Fabrication's bookkeeper for four months. Everything you need to type is in this ` +
    `folder; everything you should end up seeing is in this file, month by month, with a hint at each step ` +
    `that tends to trip people up.\n\n` +
    `Read \`00-the-business.md\` first if you have not already — it is one page and tells you what the company ` +
    `does and which accounts you'll touch.\n\n---\n\n` +
    `## Step 0 — set up the organization\n\n` +
    `Follow \`01-setup.md\`: register a fresh org (base currency USD), choose at least LedgerCore on the app ` +
    `picker that follows, then create one account by hand, ` +
    `\`4300 Interest Income\`. Registration already seeds the other 45 accounts, so this is the only one you ` +
    `create yourself.\n\n` +
    `> **Hint:** if you skip creating 4300 and hit an interest line in the bank statement later, "Post journal" ` +
    `will have no account to offer for it — come back here and add it.\n\n` +
    `## Step 1 — import the master records\n\n` +
    `Go to **Data migration → Imports → New import**. Kind **Vendors**, upload \`vendors.csv\` (its contents ` +
    `are also shown in \`02-vendors.md\` if you'd rather copy-paste). It stages 6 rows, all \`VALID\`; Preview ` +
    `shows \`6 will be created, 0 will be merged\`; Commit. Repeat with kind **Customers** and \`customers.csv\`. ` +
    `Do this now, before entering any document — every one of the 12 is used at least once across the four ` +
    `months.\n\n` +
    `> **Hint:** payment terms for every vendor are "Due on receipt" — there's no net-30 anywhere in this ` +
    `scenario, which keeps every bank line's date close to its document's date.\n\n` +
    `> **Hint:** if a staged row comes back \`INVALID\`, the importer is telling you something is genuinely ` +
    `wrong with that row (a blank name, a malformed email) — these two files are clean, so seeing one means the ` +
    `upload got corrupted somewhere, not that you should force a commit past it.\n\n---\n\n`;

  for (const m of [1, 2, 3, 4] as const) {
    const monthResult = expected.find((e) => e.month === m);
    out +=
      `## Month ${String(m)}\n\n` +
      `**Enter the documents.** From \`04-bills-received.md\` and \`05-invoices-to-raise.md\`, find this ` +
      `month's section and enter every bill and every invoice listed there — bills through Submit → Approve, ` +
      `invoices through Issue.\n\n` +
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
      `${m === 1 || m === 4 ? 'northwind-ISO' : m === 2 ? 'meridian-DMY' : 'cascade-MDY'}.csv\` against \`1110 Operating ` +
      `Cash\`, using the date format \`06-bank-statements.md\` gives you. Enter the closing balance it names ` +
      `too — it's optional, but it's what lets the import screen tell you immediately if a total is off.\n\n` +
      (m === 3
        ? `> **Hint:** this statement's headers — \`Posted\`, \`Memo\`, \`Check No\`, \`Net\` — won't ` +
          `auto-detect. That's deliberate: open the column map and type in the four mappings \`06-bank-` +
          `statements.md\` gives you.\n\n`
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
    `Four months entered, four statements reconciled, four months of financial statements that tie back to ` +
    `a hand-typed source document for every dollar — including three corrections made the way an auditor ` +
    `expects them, by separate documents that leave the originals untouched. If you want to see the same scenario built a different ` +
    `way, \`sandbox/\` runs a 24-month version of a different business through the seeder instead of by hand — ` +
    `see \`sandbox/README.md\`.\n`;

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
    `When you send a vendor a debit note, they usually answer with their own credit note — LedgerCore lets ` +
    `you record its number as the *vendor's credit note no.*\n\n` +
    `## When you need one\n\n` +
    `**Credit note** — the customer returned goods; you agreed a price allowance or an after-the-sale discount; ` +
    `goods arrived damaged; part of an invoice should never have been charged.\n\n` +
    `**Debit note** — you returned goods to a vendor; the vendor overcharged you; they delivered less than ` +
    `they billed.\n\n` +
    `**When you don't:**\n\n` +
    `- The whole invoice was wrong and nothing has been paid on it → **void** the invoice and re-issue it.\n` +
    `- The customer will simply never pay → that is a bad-debt write-off, a different document (not built in ` +
    `LedgerCore yet).\n` +
    `- The customer owes you **more** than you invoiced → issue another invoice. (Some tax regimes call a ` +
    `seller's document that *increases* an invoice a "debit note" too — e.g. India's GST. LedgerCore does not ` +
    `build that variant; a supplementary invoice does the same job in the books.)\n\n` +
    `> For background (verify for your jurisdiction): returns and allowances reduce revenue under IFRS 15 / ` +
    `ASC 606; India's CGST Act s.34 and the EU VAT Directive (art. 219) treat a document that amends an invoice ` +
    `as part of the invoice record, which is why it references the original and carries its own number series.\n\n` +
    `## Why a separate document instead of editing or voiding the original\n\n` +
    `- **The original stays intact.** An issued invoice is immutable in LedgerCore (and in any audited set of ` +
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
    `## Rules LedgerCore enforces\n\n` +
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
  write('statements/month-1-northwind-ISO.csv', statement1(anchor, resolved));
  write('statements/month-2-meridian-DMY.csv', statement2(anchor, resolved));
  write('statements/month-3-cascade-MDY.csv', statement3(anchor, resolved));
  write('statements/month-4-northwind-ISO.csv', statement4(anchor, resolved));

  console.log(`[walkthrough] done — anchor ${String(anchor.year)}-${String(anchor.month).padStart(2, '0')}, ${String(lastDayOfWalkthroughMonth(anchor, 4))} last day`);
}

main();
