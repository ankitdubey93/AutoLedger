import { auTaxCode } from '../config/taxPacks/au.js';

/**
 * The GST calculation worksheet. Pure: events in, labels out, integer cents.
 *
 * G labels include GST. 1A and 1B come from the actual tax on the events, not
 * from G9 and G20: the ATO's accounts method, and the one that ties to the GL.
 * G9 and G20 (divide by 11) are kept as a record and a cross-check; they differ
 * from 1A and 1B by rounding, or where a rate other than 10% is involved.
 */

export interface WorksheetEvent {
  taxCode: string;
  netCents: number;
  taxCents: number;
  /** A note against a document before this period: an adjustment, not this period's sales or purchases. */
  priorPeriod: boolean;
}

export interface WorksheetAdjustment {
  label: 'G7' | 'G18';
  grossCents: number;
  taxCents: number;
}

export type BasLabels = Record<string, number>;

export const SIMPLER_LABELS = ['G1', '1A', '1B'] as const;
export const FULL_LABELS = ['G1', 'G2', 'G3', 'G10', 'G11', '1A', '1B'] as const;
export const WORKSHEET_LABELS = [
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9',
  'G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'G20',
] as const;

export function divideBy11(cents: number): number {
  return Math.sign(cents) * Math.round(Math.abs(cents) / 11);
}

/** The labels an event's gross amount appears at. Empty for a code off the BAS. */
export function labelsForEvent(taxCode: string, priorPeriod: boolean): string[] {
  const code = auTaxCode(taxCode);
  if (code === undefined || !code.reported) return [];
  if (priorPeriod) return [code.direction === 'SALES' ? 'G7' : 'G18'];
  if (code.direction === 'SALES') return code.worksheetLabel === null ? ['G1'] : ['G1', code.worksheetLabel];
  const base = code.capital ? 'G10' : 'G11';
  return code.worksheetLabel === null ? [base] : [base, code.worksheetLabel];
}

export function computeWorksheet(events: readonly WorksheetEvent[], adjustments: readonly WorksheetAdjustment[]): BasLabels {
  const l: BasLabels = {};
  for (const label of [...WORKSHEET_LABELS, '1A', '1B']) l[label] = 0;
  const add = (label: string, cents: number) => {
    l[label] = (l[label] ?? 0) + cents;
  };

  for (const e of events) {
    const code = auTaxCode(e.taxCode);
    if (code === undefined || !code.reported) continue;
    for (const label of labelsForEvent(e.taxCode, e.priorPeriod)) add(label, e.netCents + e.taxCents);
    add(code.direction === 'SALES' ? '1A' : '1B', e.taxCents);
  }
  for (const a of adjustments) {
    add(a.label, a.grossCents);
    add(a.label === 'G7' ? '1A' : '1B', a.taxCents);
  }

  const v = (label: string): number => l[label] ?? 0;
  l.G5 = v('G2') + v('G3') + v('G4');
  l.G6 = v('G1') - v('G5');
  l.G8 = v('G6') + v('G7');
  l.G9 = divideBy11(v('G8'));
  l.G12 = v('G10') + v('G11');
  l.G16 = v('G13') + v('G14') + v('G15');
  l.G17 = v('G12') - v('G16');
  l.G19 = v('G17') + v('G18');
  l.G20 = divideBy11(v('G19'));
  return l;
}

/** BAS amounts are reported in whole dollars, with cents dropped. */
export function wholeDollars(cents: number): number {
  return Math.trunc(cents / 100);
}

export interface BasSummary {
  /** In whole dollars, as reported. Positive means payable to the ATO. */
  gstOnSales: number;
  gstOnPurchases: number;
  paygWithheld: number;
  paygInstalment: number;
  netPayable: number;
}

export function basSummary(labels: BasLabels, w2Cents: number, instalmentCents: number): BasSummary {
  const gstOnSales = wholeDollars(labels['1A'] ?? 0);
  const gstOnPurchases = wholeDollars(labels['1B'] ?? 0);
  const paygWithheld = wholeDollars(w2Cents);
  const paygInstalment = wholeDollars(instalmentCents);
  return {
    gstOnSales,
    gstOnPurchases,
    paygWithheld,
    paygInstalment,
    netPayable: gstOnSales + paygWithheld + paygInstalment - gstOnPurchases,
  };
}
