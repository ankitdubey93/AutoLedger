import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WALKTHROUGH_DATASET, type DatasetDocument } from './walkthroughDataset.js';
import { resolveSettlementLines, type ResolvedSettlementLine } from './walkthroughTiers.js';
import { computeExpectedResults, type ExpectedMonth, type ExpectedStatementRow } from './walkthroughExpected.js';
import { parseAnchor, defaultAnchor, resolveDate, lastDayOfWalkthroughMonth, type AnchorMonth } from './walkthroughDates.js';
import { money, statement1, statement2, statement3 } from './walkthroughStatements.js';
import { parseMoneyText } from '../utils/money.js';

/**
 * `npm run walkthrough [-- --anchor YYYY-MM]` — writes `walkthrough/` at the
 * repo root: source documents an accountant would receive and enter by
 * hand, three bank statements in three different formats, and a computed,
 * service-verified answer key.
 *
 * Deliberately not `fixtures/` and not seeded through the API here — this
 * folder is meant to be typed in by a human at the LedgerCore UI, and is
 * committed as plain, reviewable files. Contrast `sandbox/`, which is
 * replayed through services by a seeder (see `walkthrough/README.md` and
 * `sandbox/README.md`, which cross-reference each other).
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
  const rows = WALKTHROUGH_DATASET.vendors
    .map(
      (v) =>
        `| ${v.name} | ${v.email} | ${v.phone} | ${v.address} | ${v.taxNumber} | Due on receipt |`,
    )
    .join('\n');
  return (
    `# Vendors to enter\n\n` +
    `Enter each of these as a new vendor before entering any bill. Payment terms: **Due on receipt** for all six.\n\n` +
    `| Name | Email | Phone | Address | Tax number | Terms |\n|---|---|---|---|---|---|\n${rows}\n`
  );
}

function renderCustomers(): string {
  const rows = WALKTHROUGH_DATASET.customers
    .map((c) => `| ${c.name} | ${c.email} | ${c.phone} | ${c.address} |`)
    .join('\n');
  return (
    `# Customers to enter\n\n` +
    `Enter each of these as a new customer before raising any invoice.\n\n` +
    `| Name | Email | Phone | Address |\n|---|---|---|---|\n${rows}\n`
  );
}

function renderDocuments(anchor: AnchorMonth, docs: DatasetDocument[], kind: 'invoice' | 'bill'): string {
  // Calendar-order (January-first), indexed by the *absolute* month index
  // computed below — never by an offset from the anchor, which is what
  // produced wrong labels (e.g. anchor June + walkthrough month 1 reading
  // as "November") when a June-first array was walked with a January-first
  // formula.
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthHeading(m: 1 | 2 | 3): string {
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
      out += `${monthHeading(doc.month as 1 | 2 | 3)}\n\n`;
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
    `Three months, three different banks, three different export formats. Import each one against ` +
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
    `and pick **date format: MDY**.\n\n---\n\n`;

  for (const m of [1, 2, 3] as const) {
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
    `1. Register a **fresh** organization — any name, base currency **USD**. Registration seeds the default 45-account chart automatically.\n` +
    `2. Go to **Accounts** and create one new account:\n\n` +
    `   | Field | Value |\n   |---|---|\n   | Code | \`4300\` |\n   | Name | Interest Income |\n   | Type | Revenue |\n   | Parent | \`4000 Revenue\` |\n   | Postable | Yes |\n\n` +
    `3. Do **not** run the sandbox demo loader or the opening-balance importer into this organization — the scenario assumes zero opening cash, and both of those would add balances this pack's answer key does not account for.\n`
  );
}

function renderTheBusiness(): string {
  return (
    `# Harbor Point Fabrication\n\n` +
    `${WALKTHROUGH_DATASET.businessDescription}\n\n` +
    `**Period:** three consecutive months, entered one at a time. **Currency:** USD throughout.\n\n` +
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
    `| 5100 Direct Materials, 5300 Freight & Duty | Cost of sales |\n` +
    `| 6110, 6120, 6200, 6400 | Rent, software, professional fees, marketing |\n` +
    `| 6600 Bank Fees | Wire fees and monthly service charges |\n`
  );
}

function renderReadme(): string {
  return (
    `# Walkthrough: Harbor Point Fabrication\n\n` +
    `A complete, three-month accounting scenario for LedgerCore — source documents to enter by hand, three ` +
    `bank statements to import, and a computed answer key to check your work against.\n\n` +
    `**Start with \`TUTORIAL.md\`** — it walks the whole thing start to finish with hints. The files below are ` +
    `its reference material, useful to come back to on their own:\n\n` +
    `- \`00-the-business.md\` — who Harbor Point Fabrication is\n` +
    `- \`01-setup.md\` — organization registration, the one account to create by hand\n` +
    `- \`02-vendors.md\`, \`03-customers.md\` — master records to enter\n` +
    `- \`04-bills-received.md\`, \`05-invoices-to-raise.md\` — the source documents, in order\n` +
    `- \`06-bank-statements.md\` — what each statement is and the per-line action to take\n` +
    `- \`07-expected-results.md\` — the answer key\n` +
    `- \`statements/\` — the three CSV files to import\n\n` +
    `**Run order:** enter all 6 vendors and all 6 customers once, up front. Then, one month at a time — enter ` +
    `that month's bills (submit + approve), enter that month's invoices (issue), import that month's statement, ` +
    `resolve every line, check the reconciliation report, check that month's figures against ` +
    `\`07-expected-results.md\` — before moving to the next month. Suggestions are generated at import time ` +
    `against documents that are open right then, so a month's documents must exist before its statement is ` +
    `imported.\n\n` +
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
    `You are Harbor Point Fabrication's bookkeeper for three months. Everything you need to type is in this ` +
    `folder; everything you should end up seeing is in this file, month by month, with a hint at each step ` +
    `that tends to trip people up.\n\n` +
    `Read \`00-the-business.md\` first if you have not already — it is one page and tells you what the company ` +
    `does and which accounts you'll touch.\n\n---\n\n` +
    `## Step 0 — set up the organization\n\n` +
    `Follow \`01-setup.md\`: register a fresh org (base currency USD), then create one account by hand, ` +
    `\`4300 Interest Income\`. Registration already seeds the other 45 accounts, so this is the only one you ` +
    `create yourself.\n\n` +
    `> **Hint:** if you skip creating 4300 and hit an interest line in the bank statement later, "Post journal" ` +
    `will have no account to offer for it — come back here and add it.\n\n` +
    `## Step 1 — enter the master records\n\n` +
    `From \`02-vendors.md\` and \`03-customers.md\`, create all 6 vendors and all 6 customers now, before ` +
    `entering any document. Every one of them is used at least once across the three months.\n\n` +
    `> **Hint:** payment terms for every vendor are "Due on receipt" — there's no net-30 anywhere in this ` +
    `scenario, which keeps every bank line's date close to its document's date.\n\n---\n\n`;

  for (const m of [1, 2, 3] as const) {
    const monthResult = expected.find((e) => e.month === m);
    out +=
      `## Month ${String(m)}\n\n` +
      `**Enter the documents.** From \`04-bills-received.md\` and \`05-invoices-to-raise.md\`, find this ` +
      `month's section and enter every bill and every invoice listed there — bills through Submit → Approve, ` +
      `invoices through Issue.\n\n` +
      `> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import ` +
      `the statement below — if a bank line comes up with zero suggestions and you expected one, check the ` +
      `document's status first.\n\n` +
      `**Import the statement.** From \`06-bank-statements.md\`, import \`statements/month-${String(m)}-` +
      `${m === 1 ? 'northwind-ISO' : m === 2 ? 'meridian-DMY' : 'cascade-MDY'}.csv\` against \`1110 Operating ` +
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
    `Three months entered, three statements reconciled, three months of financial statements that tie back to ` +
    `a hand-typed source document for every dollar. If you want to see the same scenario built a different ` +
    `way, \`sandbox/\` runs a 24-month version of a different business through the seeder instead of by hand — ` +
    `see \`sandbox/README.md\`.\n`;

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
  write('04-bills-received.md', renderDocuments(anchor, WALKTHROUGH_DATASET.bills, 'bill'));
  write('05-invoices-to-raise.md', renderDocuments(anchor, WALKTHROUGH_DATASET.invoices, 'invoice'));
  write('06-bank-statements.md', renderBankStatements(anchor, resolved));
  write('07-expected-results.md', renderExpectedResults(expected));
  write('statements/month-1-northwind-ISO.csv', statement1(anchor, resolved));
  write('statements/month-2-meridian-DMY.csv', statement2(anchor, resolved));
  write('statements/month-3-cascade-MDY.csv', statement3(anchor, resolved));

  console.log(`[walkthrough] done — anchor ${String(anchor.year)}-${String(anchor.month).padStart(2, '0')}, ${String(lastDayOfWalkthroughMonth(anchor, 3))} last day`);
}

main();
