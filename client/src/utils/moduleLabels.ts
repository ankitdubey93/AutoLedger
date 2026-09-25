/**
 * The server tags rows with the module that produced them (audit log,
 * documents, AI usage). The tags are frozen internal identifiers, the
 * pre-Phase-33 app slugs; see server/src/config/modules.ts. People see these
 * section names instead.
 */
export const MODULE_LABELS: Readonly<Record<string, string>> = {
  'ledger-core': 'Accounting',
  'ap-flow': 'Bill inbox',
  stock: 'Inventory',
  platform: 'Platform',
};

export function moduleLabel(tag: string): string {
  return MODULE_LABELS[tag] ?? tag;
}
