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
