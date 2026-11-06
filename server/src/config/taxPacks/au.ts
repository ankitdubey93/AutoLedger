/**
 * The Australian jurisdiction pack (Phase 49). Rules live here as data, in
 * one file, so a change in the law is a reviewable diff to a single place.
 */

/** IANA zones covering every Australian state and territory. */
export const AU_TIME_ZONES = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Hobart',
] as const;

export type AuTimeZone = (typeof AU_TIME_ZONES)[number];

export const AU_BASE_CURRENCY = 'AUD';

export interface AuChartAddition {
  code: string;
  name: string;
  type: 'Asset' | 'Liability';
  parent: string;
}

/**
 * Accounts an Australian business needs that the default chart lacks. New
 * codes only: existing codes are load-bearing for reports and system roles.
 */
export const AU_CHART_ADDITIONS: readonly AuChartAddition[] = [
  { code: '1185', name: 'PAYG Instalments Paid', type: 'Asset', parent: '1100' },
  { code: '2150', name: 'ATO Clearing', type: 'Liability', parent: '2010' },
  { code: '2162', name: 'PAYG Withholding Payable', type: 'Liability', parent: '2010' },
  { code: '2164', name: 'Superannuation Payable', type: 'Liability', parent: '2010' },
];

/**
 * Default-chart names that read wrongly in Australia. Applied only while an
 * account still has `from`, so a name the organization chose is never touched.
 */
export const AU_CHART_RENAMES: readonly { code: string; from: string; to: string }[] = [
  { code: '1180', from: 'GST/VAT Input Credit', to: 'GST Paid' },
  { code: '2140', from: 'GST/VAT Output Payable', to: 'GST Collected' },
  { code: '3100', from: "Common Stock / Owner's Capital", to: "Share Capital / Owner's Capital" },
  { code: '5200', from: 'Direct Labor', to: 'Direct Labour' },
];

export type GstDirection = 'SALES' | 'PURCHASES';

/**
 * How a code feeds the BAS worksheet. A sale is G1 unless excluded; a purchase
 * is G10 or G11 unless excluded. The extra label carves it out for the
 * calculation: G2/G3/G4 on sales, G13/G14/G15 on purchases.
 */
export type GstWorksheetLabel = 'G2' | 'G3' | 'G4' | 'G13' | 'G14' | 'G15';

export interface AuTaxCode {
  code: string;
  label: string;
  direction: GstDirection;
  /** GST rate in basis points. Zero when no GST is charged or claimable. */
  rateBp: number;
  /** False leaves the line off the BAS entirely: wages, drawings, loans, transfers. */
  reported: boolean;
  /** A capital purchase (G10) rather than a non-capital one (G11). */
  capital: boolean;
  worksheetLabel: GstWorksheetLabel | null;
  /** From this date the rate applies. Lines snapshot their rate, so history never moves. */
  effectiveFrom: string;
}

const GST_START = '2000-07-01';
const GST_RATE_BP = 1000;

/**
 * A closed catalogue, not an org-editable table: a BAS mapping a user edited
 * by mistake would misstate a tax return. The DB CHECK in migration 107 holds
 * the same list, so adding a code is a reviewed migration.
 */
export const AU_TAX_CODES: readonly AuTaxCode[] = [
  { code: 'S_GST', label: 'GST on sales (10%)', direction: 'SALES', rateBp: GST_RATE_BP, reported: true, capital: false, worksheetLabel: null, effectiveFrom: GST_START },
  { code: 'S_EXPORT', label: 'GST-free exports', direction: 'SALES', rateBp: 0, reported: true, capital: false, worksheetLabel: 'G2', effectiveFrom: GST_START },
  { code: 'S_FREE', label: 'GST-free sales', direction: 'SALES', rateBp: 0, reported: true, capital: false, worksheetLabel: 'G3', effectiveFrom: GST_START },
  { code: 'S_INPUT_TAXED', label: 'Input-taxed sales', direction: 'SALES', rateBp: 0, reported: true, capital: false, worksheetLabel: 'G4', effectiveFrom: GST_START },
  { code: 'S_EXCLUDED', label: 'BAS excluded (sales)', direction: 'SALES', rateBp: 0, reported: false, capital: false, worksheetLabel: null, effectiveFrom: GST_START },
  { code: 'P_GST', label: 'GST on purchases (10%)', direction: 'PURCHASES', rateBp: GST_RATE_BP, reported: true, capital: false, worksheetLabel: null, effectiveFrom: GST_START },
  { code: 'P_CAP_GST', label: 'GST on capital purchases (10%)', direction: 'PURCHASES', rateBp: GST_RATE_BP, reported: true, capital: true, worksheetLabel: null, effectiveFrom: GST_START },
  { code: 'P_FREE', label: 'GST-free purchases', direction: 'PURCHASES', rateBp: 0, reported: true, capital: false, worksheetLabel: 'G14', effectiveFrom: GST_START },
  { code: 'P_CAP_FREE', label: 'GST-free capital purchases', direction: 'PURCHASES', rateBp: 0, reported: true, capital: true, worksheetLabel: 'G14', effectiveFrom: GST_START },
  { code: 'P_INPUT_TAXED', label: 'Purchases for input-taxed sales (no credit)', direction: 'PURCHASES', rateBp: 0, reported: true, capital: false, worksheetLabel: 'G13', effectiveFrom: GST_START },
  { code: 'P_PRIVATE', label: 'Private or non-deductible (no credit)', direction: 'PURCHASES', rateBp: 0, reported: true, capital: false, worksheetLabel: 'G15', effectiveFrom: GST_START },
  { code: 'P_EXCLUDED', label: 'BAS excluded (purchases)', direction: 'PURCHASES', rateBp: 0, reported: false, capital: false, worksheetLabel: null, effectiveFrom: GST_START },
];

const BY_CODE = new Map(AU_TAX_CODES.map((c) => [c.code, c]));

export function auTaxCode(code: string): AuTaxCode | undefined {
  return BY_CODE.get(code);
}

/** The code a line gets when nothing more specific applies. */
export function auDefaultTaxCode(direction: GstDirection, registered: boolean): string {
  if (!registered) return direction === 'SALES' ? 'S_EXCLUDED' : 'P_EXCLUDED';
  return direction === 'SALES' ? 'S_GST' : 'P_GST';
}
