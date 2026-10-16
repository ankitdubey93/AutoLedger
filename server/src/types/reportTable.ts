export const REPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

export type ReportCell =
  | { kind: 'text'; value: string }
  | { kind: 'money'; cents: number }
  | { kind: 'quantity'; milli: number }
  | { kind: 'percent'; bp: number | null }
  | { kind: 'date'; iso: string }
  | { kind: 'empty' };

export interface ReportColumn {
  key: string;
  label: string;
  align: 'left' | 'right';
  /** Approximate width in characters; XLSX column width and PDF proportional width. */
  widthChars: number;
}

export type ReportRowStyle = 'heading' | 'detail' | 'subtotal' | 'total';

export interface ReportRow {
  style: ReportRowStyle;
  /** Indent level of the first column's text: 2 spaces per level in CSV/XLSX, 10pt per level in PDF. */
  indent: number;
  /** Keyed by ReportColumn.key; a missing key renders as empty. */
  cells: Record<string, ReportCell>;
}

export interface ReportTable {
  title: string;
  /** e.g. "Org Alpha · 1 Oct 2026 – 31 Oct 2026 · USD" */
  subtitle: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  footnotes: string[];
  /** Lowercase [a-z0-9-] only; the download filename without extension. */
  filenameStem: string;
}

export interface ReportContext {
  organizationName: string;
  baseCurrency: string;
}
