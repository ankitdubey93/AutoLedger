import { WALKTHROUGH_DATASET } from './walkthroughDataset.js';

/**
 * The vendor/customer CSVs the walkthrough scenario imports through the
 * Phase 24 customer/vendor migration importer, instead of typing each one
 * into the New Vendor / New Customer form by hand — the same "generate the
 * exact bytes once, import them for real in the replay test" pattern
 * `walkthroughStatements.ts`'s `statement1`/`statement2`/`statement3` use
 * for the bank statements. `generateWalkthrough.ts` writes this content to
 * `walkthrough/vendors.csv` / `walkthrough/customers.csv` (and embeds it in
 * `02-vendors.md` / `03-customers.md` for reading); `walkthrough.test.ts`
 * imports the same two functions so the end-to-end replay uploads the exact
 * bytes that ship in the folder.
 *
 * Column headers match `client/src/Pages/ledger-core/importTemplates.ts`
 * exactly. `Notes` is left blank for every row — the dataset carries no
 * notes field, and a fabricated value would be a lie the answer key never
 * asked for.
 */

/** RFC 4180 field escaping — quote a field that contains a comma, quote or newline; double any embedded quote. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}

export function vendorsCsv(): string {
  const header = csvRow(['Name', 'Email', 'Phone', 'Billing Address', 'Tax Number', 'Payment Terms', 'Notes']);
  const rows = WALKTHROUGH_DATASET.vendors.map((v) =>
    csvRow([v.name, v.email, v.phone, v.address, v.taxNumber, 'Due on receipt', '']),
  );
  return [header, ...rows].join('\n') + '\n';
}

export function customersCsv(): string {
  const header = csvRow(['Name', 'Email', 'Phone', 'Billing Address', 'Tax Number', 'Notes']);
  const rows = WALKTHROUGH_DATASET.customers.map((c) => csvRow([c.name, c.email, c.phone, c.address, '', '']));
  return [header, ...rows].join('\n') + '\n';
}
