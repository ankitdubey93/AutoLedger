import type { ReportCell, ReportTable } from '../types/reportTable.js';
import { bpToPercentText, centsToDecimal, milliToDecimal } from './reportCellText.js';

/**
 * Phase 45 — a report as CSV, for importing into a spreadsheet: a UTF-8 BOM, one header
 * row, one line per report row, CRLF line ends. No title, subtitle or footnotes.
 * A text cell that starts with a formula trigger is prefixed with an apostrophe so a
 * spreadsheet never evaluates it (CSV injection); numbers are not text and are left alone.
 */

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

function quote(value: string): string {
  const needs =
    /[,"\r\n]/.test(value) || value.startsWith(' ') || value.endsWith(' ');
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

function cellText(cell: ReportCell | undefined, prefix: string): string {
  if (cell === undefined) return '';
  switch (cell.kind) {
    case 'text': {
      const value = prefix + cell.value;
      const first = value.charAt(0);
      return FORMULA_TRIGGERS.has(first) ? `'${value}` : value;
    }
    case 'money':
      return centsToDecimal(cell.cents);
    case 'quantity':
      return milliToDecimal(cell.milli);
    case 'percent':
      return bpToPercentText(cell.bp);
    case 'date':
      return cell.iso;
    case 'empty':
      return '';
  }
}

export function buildReportCsv(table: ReportTable): string {
  const lines: string[] = [table.columns.map((c) => quote(c.label)).join(',')];
  for (const row of table.rows) {
    lines.push(
      table.columns
        .map((col, i) => quote(cellText(row.cells[col.key], i === 0 ? '  '.repeat(row.indent) : '')))
        .join(','),
    );
  }
  return `﻿${lines.map((l) => `${l}\r\n`).join('')}`;
}
