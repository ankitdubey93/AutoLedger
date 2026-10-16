import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import {
  ACCOUNT_TRANSACTIONS_LINE_CAP,
  isAccountType,
  isDebitBalanceType,
  sourceTypeLabel,
  type AccountTransactionGrouping,
  type AccountTransactionGroup,
  type AccountTransactionLine,
  type AccountTransactionsOptions,
  type AccountTransactionsReport,
  type AccountType,
} from '../../types/accounting.js';

/**
 * Phase 45 — account transactions: every posted ledger line across one, several
 * or all postable accounts, grouped and optionally summarised.
 *
 * Every query is scoped by `org_id` (guardrails rule 1), parameterized (rule 4);
 * the only interpolated SQL fragments are the constants below. Money is read as
 * `::text` and parsed to integer cents (rule 3).
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Frozen map: the only source of a summary query's GROUP BY expression (rule 4). */
const SUMMARY_GROUP_EXPRESSIONS = {
  account: 'l.account_id::text',
  month: "to_char(e.entry_date, 'YYYY-MM')",
  sourceType: 'e.source_type',
  contact: "COALESCE(at.contact_type || ':' || at.contact_id::text, 'none')",
  none: "'all'",
} as const satisfies Record<AccountTransactionGrouping, string>;

const ATTRIBUTION_CTE = `
WITH attribution AS (
  SELECT i.journal_entry_id AS entry_id, 'CUSTOMER'::text AS contact_type, i.customer_id AS contact_id, i.invoice_number AS reference
    FROM invoices i WHERE i.org_id = $1 AND i.journal_entry_id IS NOT NULL
  UNION ALL SELECT i.void_journal_entry_id, 'CUSTOMER', i.customer_id, i.invoice_number
    FROM invoices i WHERE i.org_id = $1 AND i.void_journal_entry_id IS NOT NULL
  UNION ALL SELECT b.journal_entry_id, 'VENDOR', b.vendor_id, b.vendor_reference
    FROM bills b WHERE b.org_id = $1 AND b.journal_entry_id IS NOT NULL
  UNION ALL SELECT b.void_journal_entry_id, 'VENDOR', b.vendor_id, b.vendor_reference
    FROM bills b WHERE b.org_id = $1 AND b.void_journal_entry_id IS NOT NULL
  UNION ALL SELECT n.journal_entry_id, 'CUSTOMER', n.customer_id, n.credit_note_number
    FROM credit_notes n WHERE n.org_id = $1 AND n.journal_entry_id IS NOT NULL
  UNION ALL SELECT n.void_journal_entry_id, 'CUSTOMER', n.customer_id, n.credit_note_number
    FROM credit_notes n WHERE n.org_id = $1 AND n.void_journal_entry_id IS NOT NULL
  UNION ALL SELECT n.journal_entry_id, 'VENDOR', n.vendor_id, n.debit_note_number
    FROM debit_notes n WHERE n.org_id = $1 AND n.journal_entry_id IS NOT NULL
  UNION ALL SELECT n.void_journal_entry_id, 'VENDOR', n.vendor_id, n.debit_note_number
    FROM debit_notes n WHERE n.org_id = $1 AND n.void_journal_entry_id IS NOT NULL
  UNION ALL SELECT p.journal_entry_id,
                   CASE WHEN p.customer_id IS NOT NULL THEN 'CUSTOMER' WHEN p.vendor_id IS NOT NULL THEN 'VENDOR' END,
                   COALESCE(p.customer_id, p.vendor_id), p.reference
    FROM payments p WHERE p.org_id = $1 AND p.journal_entry_id IS NOT NULL
  UNION ALL SELECT p.void_journal_entry_id,
                   CASE WHEN p.customer_id IS NOT NULL THEN 'CUSTOMER' WHEN p.vendor_id IS NOT NULL THEN 'VENDOR' END,
                   COALESCE(p.customer_id, p.vendor_id), p.reference
    FROM payments p WHERE p.org_id = $1 AND p.void_journal_entry_id IS NOT NULL
)`;

const FROM_LINES = `
FROM ledger_lines l
JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id`;

const SHARED_WHERE = `
WHERE l.org_id = $1
  AND ($2::uuid[] IS NULL OR l.account_id = ANY($2::uuid[]))
  AND e.entry_date >= $3::date AND e.entry_date <= $4::date
  AND ($5::text[] IS NULL OR e.source_type = ANY($5::text[]))`;

const ATTRIBUTION_JOINS = `
LEFT JOIN attribution at ON at.entry_id = e.id
LEFT JOIN customers c ON at.contact_type = 'CUSTOMER' AND c.id = at.contact_id AND c.org_id = $1
LEFT JOIN vendors v ON at.contact_type = 'VENDOR' AND v.id = at.contact_id AND v.org_id = $1`;

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  is_postable: boolean;
}

interface DetailRow {
  line_id: string;
  entry_id: string;
  entry_date: string;
  source_type: string;
  source_id: string | null;
  reference: string | null;
  contact_type: 'CUSTOMER' | 'VENDOR' | null;
  contact_id: string | null;
  contact_name: string | null;
  description: string | null;
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit_cents: string;
  credit_cents: string;
  currency_code: string;
  native_debit_cents: string;
  native_credit_cents: string;
  fx_rate: string;
  created_by_name: string | null;
  running_signed: string;
}

interface SummaryRow {
  group_key: string;
  account_id: string | null;
  account_code: string;
  account_name: string;
  account_type: string;
  contact_name: string | null;
  source_type: string;
  debit_cents: string;
  credit_cents: string;
  net_cents: string;
  line_count: string;
}

interface OpeningRow {
  account_id: string;
  debit_cents: string;
  credit_cents: string;
}

function toType(raw: string): AccountType {
  if (!isAccountType(raw)) throw new Error(`Unexpected account type ${raw}`);
  return raw;
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  const name = MONTH_NAMES[Number(month) - 1];
  return `${name ?? key} ${year ?? ''}`.trim();
}

interface GroupDraft {
  key: string;
  label: string;
  sortCode: string;
  accountType: AccountType | null;
  debitCents: number;
  creditCents: number;
  netCents: number;
  lineCount: number;
  lines: AccountTransactionLine[];
}

function compareGroups(groupBy: AccountTransactionGrouping, a: GroupDraft, b: GroupDraft): number {
  switch (groupBy) {
    case 'account':
      return a.sortCode < b.sortCode ? -1 : a.sortCode > b.sortCode ? 1 : 0;
    case 'month':
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    case 'contact':
      if (a.key === 'none' && b.key !== 'none') return 1;
      if (b.key === 'none' && a.key !== 'none') return -1;
      return a.label.localeCompare(b.label);
    case 'sourceType':
      return a.label.localeCompare(b.label);
    case 'none':
      return 0;
  }
}

export async function accountTransactions(
  orgId: string,
  options: AccountTransactionsOptions,
): Promise<AccountTransactionsReport> {
  // 1. Validate.
  if (options.from > options.to) {
    throw new ApiError(422, 'from must not be after to');
  }

  // 2. Accounts.
  const requested = new Map<string, AccountRow>();
  if (options.accountIds !== null) {
    const { rows } = await pool.query<AccountRow>(
      `SELECT id, code, name, type, is_postable
         FROM accounts
        WHERE org_id = $1
          AND id = ANY($2::uuid[])`,
      [orgId, options.accountIds],
    );
    if (rows.length < new Set(options.accountIds).size) {
      throw new ApiError(404, 'Account not found');
    }
    for (const row of rows) {
      if (!row.is_postable) {
        throw new ApiError(
          422,
          `Account ${row.code} is a header account and has no transactions of its own`,
        );
      }
      requested.set(row.id, row);
    }
  }

  const params = [orgId, options.accountIds, options.from, options.to, options.sourceTypes];
  const withOpening = options.groupBy === 'account' && options.sourceTypes === null;

  // 6. Opening balances (before the window), per account.
  const openingByAccount = new Map<string, { debit: number; credit: number }>();
  if (withOpening) {
    const { rows } = await pool.query<OpeningRow>(
      `SELECT l.account_id,
              COALESCE(SUM(l.base_debit_cents), 0)::text  AS debit_cents,
              COALESCE(SUM(l.base_credit_cents), 0)::text AS credit_cents
         FROM ledger_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
        WHERE l.org_id = $1
          AND ($2::uuid[] IS NULL OR l.account_id = ANY($2::uuid[]))
          AND e.entry_date < $3::date
        GROUP BY l.account_id`,
      [orgId, options.accountIds, options.from],
    );
    for (const row of rows) {
      openingByAccount.set(row.account_id, {
        debit: parseCents(row.debit_cents),
        credit: parseCents(row.credit_cents),
      });
    }
  }

  const drafts = new Map<string, GroupDraft>();

  if (options.mode === 'detail') {
    // 5. Detail mode — cap first, then the lines.
    const { rows: countRows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n ${FROM_LINES} ${SHARED_WHERE}`,
      params,
    );
    const total = Number(countRows[0]?.n ?? '0');
    if (total > ACCOUNT_TRANSACTIONS_LINE_CAP) {
      throw new ApiError(
        422,
        `Too many lines (${total}) — narrow the date range or use summary mode`,
      );
    }

    const { rows } = await pool.query<DetailRow>(
      `${ATTRIBUTION_CTE}
       SELECT l.id AS line_id,
              e.id AS entry_id,
              e.entry_date,
              e.source_type,
              e.source_id,
              at.reference,
              at.contact_type,
              at.contact_id,
              COALESCE(c.name, v.name) AS contact_name,
              COALESCE(l.description, e.description) AS description,
              a.id AS account_id,
              a.code AS account_code,
              a.name AS account_name,
              a.type AS account_type,
              l.base_debit_cents::text AS debit_cents,
              l.base_credit_cents::text AS credit_cents,
              l.currency_code,
              l.debit_cents::text AS native_debit_cents,
              l.credit_cents::text AS native_credit_cents,
              l.fx_rate::text AS fx_rate,
              u.name AS created_by_name,
              (SUM(l.base_debit_cents - l.base_credit_cents)
                 OVER (PARTITION BY l.account_id
                       ORDER BY e.entry_date, l.created_at, l.id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::text AS running_signed
         ${FROM_LINES}
         JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
         ${ATTRIBUTION_JOINS}
         LEFT JOIN users u ON u.id = e.created_by
         ${SHARED_WHERE}
        ORDER BY a.code, e.entry_date, l.created_at, l.id`,
      params,
    );

    for (const row of rows) {
      const type = toType(row.account_type);
      const direction = isDebitBalanceType(type) ? 1 : -1;
      const debit = parseCents(row.debit_cents);
      const credit = parseCents(row.credit_cents);
      let runningBalanceCents: number | null = null;
      if (withOpening) {
        const opening = openingByAccount.get(row.account_id);
        const openingNet = opening ? direction * (opening.debit - opening.credit) : 0;
        runningBalanceCents = openingNet + direction * parseCents(row.running_signed);
      }
      const line: AccountTransactionLine = {
        lineId: row.line_id,
        entryId: row.entry_id,
        entryDate: row.entry_date,
        sourceType: row.source_type,
        sourceId: row.source_id,
        sourceLabel: sourceTypeLabel(row.source_type),
        reference: row.reference,
        contactType: row.contact_type,
        contactId: row.contact_id,
        contactName: row.contact_name,
        description: row.description,
        accountId: row.account_id,
        accountCode: row.account_code,
        accountName: row.account_name,
        debitCents: debit,
        creditCents: credit,
        netCents: direction * (debit - credit),
        runningBalanceCents,
        currencyCode: row.currency_code,
        nativeDebitCents: parseCents(row.native_debit_cents),
        nativeCreditCents: parseCents(row.native_credit_cents),
        fxRate: row.fx_rate,
        createdByName: row.created_by_name,
      };

      // 7. Grouping.
      let key: string;
      let label: string;
      let sortCode = '';
      switch (options.groupBy) {
        case 'account':
          key = line.accountId;
          label = `${line.accountCode} ${line.accountName}`;
          sortCode = line.accountCode;
          break;
        case 'month':
          key = line.entryDate.slice(0, 7);
          label = monthLabel(key);
          break;
        case 'sourceType':
          key = line.sourceType;
          label = line.sourceLabel;
          break;
        case 'contact':
          if (line.contactType !== null && line.contactId !== null) {
            key = `${line.contactType}:${line.contactId}`;
            label = line.contactName ?? 'No contact';
          } else {
            key = 'none';
            label = 'No contact';
          }
          break;
        case 'none':
          key = 'all';
          label = 'All transactions';
          break;
      }
      let draft = drafts.get(key);
      if (!draft) {
        draft = {
          key,
          label,
          sortCode,
          accountType: options.groupBy === 'account' ? type : null,
          debitCents: 0,
          creditCents: 0,
          netCents: 0,
          lineCount: 0,
          lines: [],
        };
        drafts.set(key, draft);
      }
      draft.lines.push(line);
      draft.debitCents += debit;
      draft.creditCents += credit;
      draft.netCents += line.netCents;
      draft.lineCount += 1;
    }
  } else {
    // 8. Summary mode — the group expression comes only from the frozen map.
    const expression = SUMMARY_GROUP_EXPRESSIONS[options.groupBy];
    const { rows } = await pool.query<SummaryRow>(
      `${ATTRIBUTION_CTE}
       SELECT ${expression} AS group_key,
              MIN(a.id::text) AS account_id,
              MIN(a.code) AS account_code,
              MIN(a.name) AS account_name,
              MIN(a.type) AS account_type,
              MIN(COALESCE(c.name, v.name)) AS contact_name,
              MIN(e.source_type) AS source_type,
              SUM(l.base_debit_cents)::text AS debit_cents,
              SUM(l.base_credit_cents)::text AS credit_cents,
              SUM(CASE WHEN a.type IN ('Asset','Expense')
                       THEN l.base_debit_cents - l.base_credit_cents
                       ELSE l.base_credit_cents - l.base_debit_cents END)::text AS net_cents,
              count(*)::text AS line_count
         ${FROM_LINES}
         JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
         ${ATTRIBUTION_JOINS}
         ${SHARED_WHERE}
        GROUP BY group_key`,
      params,
    );
    for (const row of rows) {
      let label: string;
      let sortCode = '';
      switch (options.groupBy) {
        case 'account':
          label = `${row.account_code} ${row.account_name}`;
          sortCode = row.account_code;
          break;
        case 'month':
          label = monthLabel(row.group_key);
          break;
        case 'sourceType':
          label = sourceTypeLabel(row.source_type);
          break;
        case 'contact':
          label = row.group_key === 'none' ? 'No contact' : (row.contact_name ?? 'No contact');
          break;
        case 'none':
          label = 'All transactions';
          break;
      }
      drafts.set(row.group_key, {
        key: row.group_key,
        label,
        sortCode,
        accountType: options.groupBy === 'account' ? toType(row.account_type) : null,
        debitCents: parseCents(row.debit_cents),
        creditCents: parseCents(row.credit_cents),
        netCents: parseCents(row.net_cents),
        lineCount: Number(row.line_count),
        lines: [],
      });
    }
  }

  // An explicitly requested account with an opening balance but no lines in the
  // window still gets a group.
  if (withOpening && options.accountIds !== null) {
    for (const account of requested.values()) {
      if (drafts.has(account.id) || !openingByAccount.has(account.id)) continue;
      drafts.set(account.id, {
        key: account.id,
        label: `${account.code} ${account.name}`,
        sortCode: account.code,
        accountType: toType(account.type),
        debitCents: 0,
        creditCents: 0,
        netCents: 0,
        lineCount: 0,
        lines: [],
      });
    }
  }

  const groups: AccountTransactionGroup[] = [...drafts.values()]
    .sort((a, b) => compareGroups(options.groupBy, a, b))
    .map((draft) => {
      let openingBalanceCents: number | null = null;
      let closingBalanceCents: number | null = null;
      if (withOpening && draft.accountType !== null) {
        const direction = isDebitBalanceType(draft.accountType) ? 1 : -1;
        const opening = openingByAccount.get(draft.key);
        openingBalanceCents = opening ? direction * (opening.debit - opening.credit) : 0;
        closingBalanceCents = openingBalanceCents + draft.netCents;
      }
      return {
        key: draft.key,
        label: draft.label,
        openingBalanceCents,
        debitCents: draft.debitCents,
        creditCents: draft.creditCents,
        netCents: draft.netCents,
        closingBalanceCents,
        lineCount: draft.lineCount,
        lines: draft.lines,
      };
    });

  // 9. Totals.
  let totalDebitCents = 0;
  let totalCreditCents = 0;
  let lineCount = 0;
  for (const group of groups) {
    totalDebitCents += group.debitCents;
    totalCreditCents += group.creditCents;
    lineCount += group.lineCount;
  }

  return { ...options, groups, totalDebitCents, totalCreditCents, lineCount };
}
