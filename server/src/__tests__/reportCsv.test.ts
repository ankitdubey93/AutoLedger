import { describe, expect, it } from 'vitest';
import type { ReportCell, ReportTable } from '../types/reportTable.js';
import { buildReportCsv } from '../utils/reportCsv.js';

/** Unit tier — no database. */

function table(cells: Record<string, ReportCell>, indent = 0): ReportTable {
  return {
    title: 'T',
    subtitle: 's',
    columns: [
      { key: 'name', label: 'Name', align: 'left', widthChars: 20 },
      { key: 'amount', label: 'Amount', align: 'right', widthChars: 14 },
    ],
    rows: [{ style: 'detail', indent, cells }],
    footnotes: ['never in csv'],
    filenameStem: 't',
  };
}

const text = (value: string): ReportCell => ({ kind: 'text', value });

describe('buildReportCsv', () => {
  it('starts with a BOM and uses CRLF', () => {
    const out = buildReportCsv(table({ name: text('x') }));
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toBe('﻿Name,Amount\r\nx,\r\n');
  });

  it('quotes commas and quotes', () => {
    expect(buildReportCsv(table({ name: text('a,"b"') }))).toContain('"a,""b"""');
  });

  it('guards formula injection', () => {
    expect(buildReportCsv(table({ name: text('=SUM(A1)') }))).toContain("'=SUM(A1)");
    expect(buildReportCsv(table({ name: text('-x') }))).toContain("'-x");
    expect(buildReportCsv(table({ name: text('x'), amount: { kind: 'money', cents: -500 } }))).toContain('x,-5.00');
  });

  it('indents the first column', () => {
    expect(buildReportCsv(table({ name: text('Sales') }, 2))).toContain('    Sales');
  });

  it('percent and null percent', () => {
    expect(buildReportCsv(table({ name: text('x'), amount: { kind: 'percent', bp: 1250 } }))).toContain('x,12.50%');
    expect(buildReportCsv(table({ name: text('x'), amount: { kind: 'percent', bp: null } }))).toContain('x,\r\n');
  });
});
