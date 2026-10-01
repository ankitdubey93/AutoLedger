import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import { cents, scaleCents } from '../../utils/money.js';
import type { DateFormat } from '../../utils/dateParse.js';
import { isSupportedCurrency } from '../../config/currencies.js';
import type { ImportPreviewOptions, Item, MigrationCommitPreview, MigrationImportKind } from '../../types/accounting.js';
import { dataRowParseErrors } from './importRowParsers.js';
import { importOptionsOnClient, loadDataRowsOnClient } from './importRowStore.js';
import { periodStatusOnClient } from './fiscalPeriodService.js';
import { accountCodeError, loadAccountsByCodeOnClient } from './importAccountLookup.js';
import { BILL_COLUMNS, INVOICE_COLUMNS } from './importDocumentColumns.js';
import * as itemService from './itemService.js';
import * as invoiceService from './invoiceService.js';
import * as billService from './billService.js';
import * as fxRateService from './fxRateService.js';
import * as documentStockService from '../inventory/documentStockService.js';

/**
 * The one place the rules for importing invoices and bills live (Phase 36d).
 * Validation, preview and commit all call `resolveDocumentsOnClient`, so a
 * document that previews clean is exactly the document that commits. Every
 * lookup is org-scoped (rule 1), parameterized (rule 4) and runs on the
 * caller's client (rule 5); money is integer cents (rule 3). Stock locations
 * are read only through documentStockService (rule 16).
 */

export type DocumentSide = 'SALES' | 'PURCHASES';

export interface ResolvedDocLine {
  rowId: string;
  rowNumber: number;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  accountId: string;
  taxRateBp: number;
  itemId: string | null;
  stockLocationId: string | null;
  netCents: number;
  taxCents: number;
}

export interface ResolvedDocument {
  groupKey: string | null;
  label: string;
  rowIds: string[];
  firstRow: number;
  lastRow: number;
  contactId: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  paymentTermsCode: string | null;
  currencyCode: string;
  notes: string | null;
  lines: ResolvedDocLine[];
  totalCents: number;
}

type Values = Readonly<Record<string, string | number | null>>;

interface DocRow {
  id: string;
  rowNumber: number;
  values: Values;
  raw: Readonly<Record<string, string>>;
  groupKey: string | null;
}

const CONTACT_TABLES = { SALES: 'customers', PURCHASES: 'vendors' } as const satisfies Record<DocumentSide, string>;

function text(values: Values, key: string): string | null {
  const v = values[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(values: Values, key: string): number | null {
  const v = values[key];
  return typeof v === 'number' ? v : null;
}

function rawText(row: DocRow, key: string): string {
  return (row.raw[key] ?? '').trim();
}

function uniq(list: (string | null)[]): string[] {
  return [...new Set(list.filter((v): v is string => v !== null))];
}

interface ContactRef {
  id: string;
  name: string;
  email: string | null;
}

/** Rows of the same document, in file order; a row with a null key is its own document. */
function groupRows(rows: readonly DocRow[]): DocRow[][] {
  const byKey = new Map<string, DocRow[]>();
  const out: DocRow[][] = [];
  for (const row of rows) {
    if (row.groupKey === null) {
      out.push([row]);
      continue;
    }
    let group = byKey.get(row.groupKey);
    if (group === undefined) {
      group = [];
      byKey.set(row.groupKey, group);
      out.push(group);
    }
    group.push(row);
  }
  return out;
}

export async function resolveDocumentsOnClient(
  client: PoolClient,
  orgId: string,
  side: DocumentSide,
  rows: readonly {
    id: string;
    rowNumber: number;
    values: Values;
    raw: Readonly<Record<string, string>>;
    groupKey: string | null;
  }[],
  opts: { dateFormat: DateFormat; conversionMode: boolean },
): Promise<{ docs: ResolvedDocument[]; rowErrors: Map<string, string[]>; booksStartDate: string | null; baseCurrency: string }> {
  const sales = side === 'SALES';
  const columns = sales ? INVOICE_COLUMNS : BILL_COLUMNS;
  const columnLabel = (key: string): string => columns.find((c) => c.key === key)?.label ?? key;
  const partyWord = sales ? 'Customer' : 'Vendor';
  const partiesWord = sales ? 'Customers' : 'Vendors';
  const docRows: DocRow[] = rows.map((r) => ({ id: r.id, rowNumber: r.rowNumber, values: r.values, raw: r.raw, groupKey: r.groupKey }));

  // ---- load once -----------------------------------------------------------
  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = (orgRows[0]?.base_currency ?? '').trim();
  const { rows: settingsRows } = await client.query<{ books_start: string | null }>(
    "SELECT to_char(books_start_date, 'YYYY-MM-DD') AS books_start FROM ledger_settings WHERE org_id = $1",
    [orgId],
  );
  const booksStartDate = settingsRows[0]?.books_start ?? null;

  let equityAccountId: string | null = null;
  if (opts.conversionMode) {
    const { rows: eq } = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE org_id = $1 AND code = '3400'",
      [orgId],
    );
    equityAccountId = eq[0]?.id ?? null;
  }

  const contactNames = uniq(docRows.map((r) => text(r.values, 'contactName')?.toLowerCase() ?? null));
  const contactsByName = new Map<string, ContactRef[]>();
  if (contactNames.length > 0) {
    const table = CONTACT_TABLES[side];
    const { rows: contactRows } = await client.query<{ id: string; name: string; email: string | null }>(
      `SELECT id, name, email FROM ${table} WHERE org_id = $1 AND is_active AND LOWER(name) = ANY($2::text[])`,
      [orgId, contactNames],
    );
    for (const c of contactRows) {
      const key = c.name.toLowerCase();
      const list = contactsByName.get(key) ?? [];
      list.push({ id: c.id, name: c.name, email: c.email });
      contactsByName.set(key, list);
    }
  }

  const accounts = await loadAccountsByCodeOnClient(client, orgId, uniq(docRows.map((r) => text(r.values, 'accountCode'))));
  const items = await itemService.findItemDefaultsByCodesOnClient(
    client,
    orgId,
    uniq(docRows.map((r) => text(r.values, 'itemCode'))),
  );

  let stockAccounts = new Map<string, { assetAccountId: string }>();
  let stockAccountsError: string | null = null;
  if (!sales && !opts.conversionMode) {
    const inventoryIds = [...items.values()].filter((i) => i.itemType === 'INVENTORY').map((i) => i.id);
    if (inventoryIds.length > 0) {
      try {
        stockAccounts = await itemService.resolveStockAccountsOnClient(client, orgId, inventoryIds);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        stockAccountsError = err.message;
      }
    }
  }

  const { rows: termRows } = await client.query<{ code: string; name: string }>(
    'SELECT code, name FROM payment_terms WHERE org_id = $1 AND is_active',
    [orgId],
  );
  const termsByCode = new Map<string, string>();
  const termsByName = new Map<string, string>();
  for (const t of termRows) {
    termsByCode.set(t.code.toUpperCase(), t.code);
    termsByName.set(t.name.toLowerCase(), t.code);
  }

  const anyLocation = docRows.some((r) => text(r.values, 'location') !== null);
  const locations = anyLocation
    ? (await documentStockService.loadImportReferencesOnClient(client, orgId, [])).locations
    : new Map<string, { id: string; code: string; isActive: boolean }>();

  // ---- per-row rules -------------------------------------------------------
  const rowErrors = new Map<string, string[]>();
  const lineByRow = new Map<string, ResolvedDocLine>();
  const contactByRow = new Map<string, string>();

  for (const row of docRows) {
    const errors = dataRowParseErrors(columns, row.raw, opts.dateFormat);
    rowErrors.set(row.id, errors);
    const v = row.values;

    // 1b. required cells (a cell with text that failed to parse already has its own error)
    if (text(v, 'contactName') === null && rawText(row, 'contactName') === '') errors.push(`${partyWord} name is required`);
    if (text(v, 'invoiceDate') === null && rawText(row, 'invoiceDate') === '') errors.push('Date is required');
    if (!sales && text(v, 'invoiceNumber') === null) errors.push("Vendor's invoice number is required");

    // 2. contact
    const contactName = text(v, 'contactName');
    if (contactName !== null) {
      const matches = contactsByName.get(contactName.toLowerCase()) ?? [];
      const email = text(v, 'emailAddress');
      if (matches.length === 0) {
        errors.push(`${partyWord} "${contactName}" not found — import ${partiesWord.toLowerCase()} first (${partiesWord} → Import)`);
      } else if (matches.length === 1) {
        const only = matches[0];
        if (only !== undefined) contactByRow.set(row.id, only.id);
      } else if (email !== null) {
        const hit = matches.find((m) => (m.email ?? '').toLowerCase() === email.toLowerCase());
        if (hit === undefined) errors.push(`${partyWord} "${contactName}" with email ${email} not found`);
        else contactByRow.set(row.id, hit.id);
      } else {
        errors.push(`"${contactName}" matches ${String(matches.length)} ${partiesWord.toLowerCase()} — add EmailAddress to choose one`);
      }
    }

    // 3. item
    const itemCode = text(v, 'itemCode');
    let item: Item | undefined;
    if (itemCode !== null) {
      if (opts.conversionMode) {
        errors.push('Conversion mode imports balances, not products — leave ItemCode blank');
      } else {
        item = items.get(itemCode);
        if (item === undefined) errors.push(`Item "${itemCode}" was not found`);
        else if (!item.isActive) errors.push(`Item "${itemCode}" is inactive`);
        else if (item.itemType === 'FIXED_ASSET') {
          errors.push(`Item "${itemCode}" is a fixed asset and cannot go on ${sales ? 'an invoice' : 'an expense'}`);
        }
      }
    }
    const usable = item !== undefined && item.isActive && item.itemType !== 'FIXED_ASSET' ? item : undefined;

    // 4. defaults
    const description = text(v, 'description') ?? usable?.name ?? null;
    const quantityMilli = num(v, 'quantity') ?? 1000;
    const itemPrice = usable === undefined ? null : sales ? usable.salePriceCents : usable.purchasePriceCents;
    const unitPriceCents = num(v, 'unitAmount') ?? itemPrice;
    const itemTax = usable === undefined ? null : sales ? usable.saleTaxRateBp : usable.purchaseTaxRateBp;
    const taxRateBp = num(v, 'taxRate') ?? itemTax ?? 0;
    let defaultsOk = true;
    if (description === null) {
      errors.push('Description is required (or an ItemCode)');
      defaultsOk = false;
    }
    if (unitPriceCents === null) {
      if (rawText(row, 'unitAmount') === '') {
        errors.push(`Unit price is required (or an ItemCode with a ${sales ? 'sale' : 'purchase'} price)`);
      }
      defaultsOk = false;
    }
    if (quantityMilli <= 0) {
      errors.push('Quantity must be more than zero');
      defaultsOk = false;
    }

    // 5. account
    let accountId: string | null = null;
    const accountCode = text(v, 'accountCode');
    if (opts.conversionMode) {
      if (equityAccountId === null) errors.push('Account 3400 Opening Balance Equity is missing');
      else accountId = equityAccountId;
    } else if (accountCode !== null) {
      const account = accounts.get(accountCode);
      const err = accountCodeError('AccountCode', accountCode, account, sales ? ['Revenue'] : ['Expense', 'Asset']);
      if (err !== null) errors.push(err);
      else accountId = account?.id ?? null;
    } else if (usable !== undefined) {
      if (sales) accountId = usable.revenueAccountId;
      else if (usable.itemType === 'INVENTORY') {
        accountId = stockAccounts.get(usable.id)?.assetAccountId ?? null;
        if (accountId === null && stockAccountsError !== null) errors.push(stockAccountsError);
      } else accountId = usable.expenseAccountId;
      if (accountId === null && !(usable.itemType === 'INVENTORY' && stockAccountsError !== null)) {
        errors.push('Account is required (or an ItemCode with a default account)');
      }
    } else if (itemCode === null) {
      errors.push('Account is required (or an ItemCode with a default account)');
    }

    // 6. conversion-mode tax
    if (opts.conversionMode && taxRateBp > 0) {
      errors.push('Tax must be 0 in conversion mode — import the amount outstanding including tax');
    }

    // 7. location
    let stockLocationId: string | null = null;
    const location = text(v, 'location');
    if (location !== null) {
      if (usable === undefined || usable.itemType !== 'INVENTORY') {
        if (itemCode === null || usable !== undefined) errors.push('Location applies only to inventory products');
      } else {
        const hit = locations.get(location.toUpperCase()) ?? locations.get(location.toLowerCase());
        if (hit === undefined) errors.push(`Stock location "${location}" was not found`);
        else stockLocationId = hit.id;
      }
    }

    // 8. currency
    const currency = text(v, 'currency');
    if (currency !== null && !isSupportedCurrency(currency.toUpperCase())) {
      errors.push(`Currency "${currency}" is not supported`);
    }

    if (defaultsOk && description !== null && unitPriceCents !== null && accountId !== null) {
      // Same arithmetic as computeLineTotals in invoiceService.ts / billService.ts (not exported there):
      // tax per line, never on the subtotal.
      const netCents = scaleCents(cents(unitPriceCents), quantityMilli, 1000);
      const taxCents = scaleCents(netCents, taxRateBp, 10000);
      lineByRow.set(row.id, {
        rowId: row.id,
        rowNumber: row.rowNumber,
        description,
        quantityMilli,
        unitPriceCents,
        accountId,
        taxRateBp,
        itemId: usable?.id ?? null,
        stockLocationId,
        netCents,
        taxCents,
      });
    }
  }

  // ---- group rules ---------------------------------------------------------
  const groups = groupRows(docRows);
  const existingPairs: { vendorId: string; reference: string }[] = [];
  const existingNumbers: string[] = [];
  for (const group of groups) {
    const head = group[0];
    if (head === undefined) continue;
    const number = text(head.values, 'invoiceNumber');
    if (number === null) continue;
    if (sales) existingNumbers.push(number);
    else {
      const vendorId = contactByRow.get(head.id);
      if (vendorId !== undefined) existingPairs.push({ vendorId, reference: number });
    }
  }
  const existingInvoiceNumbers = sales && existingNumbers.length > 0
    ? await invoiceService.findExistingInvoiceNumbersOnClient(client, orgId, existingNumbers)
    : new Set<string>();
  const existingBills = !sales && existingPairs.length > 0
    ? await billService.findExistingBillReferencesOnClient(client, orgId, existingPairs)
    : new Set<string>();

  const fxCache = new Map<string, string | null>();
  const docs: ResolvedDocument[] = [];

  for (const group of groups) {
    const head = group[0];
    const last = group[group.length - 1];
    if (head === undefined || last === undefined) continue;

    const number = text(head.values, 'invoiceNumber');
    const contactName = text(head.values, 'contactName') ?? rawText(head, 'contactName');
    const label = sales
      ? number !== null ? `invoice ${number}` : `invoice on row ${String(head.rowNumber)}`
      : `expense ${number ?? rawText(head, 'invoiceNumber')} from ${contactName}`;

    // header agreement
    for (const row of group.slice(1)) {
      const errs = rowErrors.get(row.id);
      if (errs === undefined) continue;
      for (const key of ['contactName', 'emailAddress', 'invoiceDate', 'dueDate', 'paymentTerms', 'currency', 'notes']) {
        const a = rawText(row, key);
        const b = rawText(head, key);
        const same = key === 'contactName' ? a.toLowerCase() === b.toLowerCase() : a === b;
        if (!same) {
          errs.push(`${columnLabel(key)} differs from row ${String(head.rowNumber)} ("${b}") — every line of the ${label} must match`);
        }
      }
    }

    const groupErrors: string[] = [];
    const date = text(head.values, 'invoiceDate');
    const dueDate = text(head.values, 'dueDate');
    const termText = text(head.values, 'paymentTerms');
    let paymentTermsCode: string | null = null;

    // due date
    if (dueDate !== null) {
      if (date !== null && dueDate < date) groupErrors.push('Due date cannot be before the invoice date');
    } else if (termText !== null) {
      const code = termsByCode.get(termText.toUpperCase()) ?? termsByName.get(termText.toLowerCase());
      if (code === undefined) groupErrors.push(`Payment term "${termText}" was not found`);
      else paymentTermsCode = code;
    } else if (rawText(head, 'dueDate') === '') {
      groupErrors.push('Enter a DueDate or PaymentTerms');
    }

    // number
    if (number !== null) {
      if (sales) {
        if (existingInvoiceNumbers.has(number)) groupErrors.push(`Invoice number ${number} already exists`);
      } else {
        const vendorId = contactByRow.get(head.id);
        if (vendorId !== undefined && existingBills.has(`${vendorId}|${number}`)) {
          groupErrors.push(`Expense ${number} from ${contactName} already exists`);
        }
      }
    }

    // conversion mode
    if (opts.conversionMode) {
      if (booksStartDate === null) {
        groupErrors.push('Set your conversion date first (Settings → Conversion balances)');
      } else if (date !== null && date > booksStartDate) {
        groupErrors.push(`In conversion mode the date must be on or before your conversion date (${booksStartDate})`);
      }
    }

    // FX
    const currencyText = text(head.values, 'currency');
    const currencyCode = currencyText === null ? baseCurrency : currencyText.toUpperCase();
    if (currencyCode !== baseCurrency && isSupportedCurrency(currencyCode) && date !== null) {
      const cacheKey = `${currencyCode}|${date}`;
      if (!fxCache.has(cacheKey)) {
        try {
          await fxRateService.requireRateOnClient(client, orgId, currencyCode, baseCurrency, date);
          fxCache.set(cacheKey, null);
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          fxCache.set(
            cacheKey,
            `No ${currencyCode} exchange rate on or before ${date} — add one under Settings → Exchange rates`,
          );
        }
      }
      const fxError = fxCache.get(cacheKey);
      if (fxError !== undefined && fxError !== null) groupErrors.push(fxError);
    }

    for (const row of group) rowErrors.get(row.id)?.push(...groupErrors);

    // a document with ANY row error is omitted
    if (group.some((r) => (rowErrors.get(r.id) ?? []).length > 0)) continue;
    const contactId = contactByRow.get(head.id);
    if (contactId === undefined || date === null) continue;
    const lines: ResolvedDocLine[] = [];
    for (const r of group) {
      const line = lineByRow.get(r.id);
      if (line === undefined) break;
      lines.push(line);
    }
    if (lines.length !== group.length) continue;
    let totalCents = 0;
    for (const l of lines) totalCents += l.netCents + l.taxCents;

    docs.push({
      groupKey: head.groupKey,
      label,
      rowIds: group.map((r) => r.id),
      firstRow: head.rowNumber,
      lastRow: last.rowNumber,
      contactId,
      number,
      date,
      dueDate,
      paymentTermsCode,
      currencyCode,
      notes: text(head.values, 'notes'),
      lines,
      totalCents,
    });
  }

  return { docs, rowErrors, booksStartDate, baseCurrency };
}

/** The import's non-EXCLUDED rows resolved with the import's own options (date format, conversion mode). */
export async function resolveImportOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
  side: DocumentSide,
): Promise<Awaited<ReturnType<typeof resolveDocumentsOnClient>> & { conversionMode: boolean; groupCount: number }> {
  const rows = await loadDataRowsOnClient(client, orgId, importId);
  const options = await importOptionsOnClient(client, orgId, importId);
  const resolved = await resolveDocumentsOnClient(client, orgId, side, rows, options);
  const keys = new Set<string>();
  let groupCount = 0;
  for (const row of rows) {
    if (row.groupKey === null) groupCount += 1;
    else if (!keys.has(row.groupKey)) {
      keys.add(row.groupKey);
      groupCount += 1;
    }
  }
  return { ...resolved, conversionMode: options.conversionMode, groupCount };
}

/** The preview both document kinds share: totals, conversion-date warnings and closed-period blocks. */
export async function previewDocumentsOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
  side: DocumentSide,
  popts: ImportPreviewOptions,
): Promise<MigrationCommitPreview> {
  const { rows: importRows } = await client.query<{ status: string; error_count: number }>(
    'SELECT status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const imp = importRows[0];
  if (imp === undefined) throw new ApiError(404, 'Migration import not found');

  const kind: MigrationImportKind = side === 'SALES' ? 'INVOICES' : 'BILLS';
  const resolved = await resolveImportOnClient(client, orgId, importId, side);
  const { docs, booksStartDate, baseCurrency, conversionMode } = resolved;
  const warnings: string[] = [];
  const revenueWord = side === 'SALES' ? 'revenue' : 'expense';
  let periodBlocked = false;

  if (!conversionMode && booksStartDate !== null) {
    const early = docs.filter((d) => d.date < booksStartDate).length;
    if (early > 0) {
      warnings.push(
        `${String(early)} document(s) are dated before your conversion date (${booksStartDate}). If they are balances carried over from your old system, delete this import and re-stage the file with conversion mode on — otherwise their ${revenueWord} is counted a second time.`,
      );
    }
  }
  if (conversionMode) {
    warnings.push(
      `Conversion mode: every document posts on ${booksStartDate ?? 'your conversion date'} to 3400 Opening Balance Equity, tax-free, keeping its own date and due date for ageing.`,
    );
  }
  if (conversionMode || popts.mode === 'POST') {
    const cache = new Map<string, Awaited<ReturnType<typeof periodStatusOnClient>>>();
    for (const d of docs) {
      const postingDate = conversionMode ? booksStartDate : (popts.postingDate ?? d.date);
      if (postingDate === null) continue;
      if (!cache.has(postingDate)) cache.set(postingDate, await periodStatusOnClient(client, orgId, postingDate));
      const status = cache.get(postingDate);
      if (status === 'CLOSED' || status === 'LOCKED') {
        warnings.push(`${d.label}: the period covering ${postingDate} is ${status} — choose another posting date`);
        periodBlocked = true;
      }
    }
  }

  let lineCount = 0;
  let totalCents = 0;
  for (const d of docs) {
    lineCount += d.lines.length;
    if (d.currencyCode === baseCurrency) totalCents += d.totalCents;
  }

  return {
    kind,
    canCommit: imp.error_count === 0 && imp.status === 'VALIDATED' && !periodBlocked,
    blockingErrorCount: imp.error_count,
    accountsToCreate: 0,
    accountsToMerge: 0,
    totalDebitCents: 0,
    totalCreditCents: 0,
    plugCents: 0,
    plugAccountCode: '',
    entryDate: null,
    partiesToCreate: 0,
    partiesToMerge: 0,
    summary: [
      { label: side === 'SALES' ? 'Invoices' : 'Expenses', value: docs.length, format: 'count' },
      { label: 'Lines', value: lineCount, format: 'count' },
      { label: 'Total (base-currency documents)', value: totalCents, format: 'money' },
    ],
    warnings,
  };
}
