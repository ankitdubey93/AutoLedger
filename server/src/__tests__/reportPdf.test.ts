import { describe, expect, it } from 'vitest';
import type { ReportColumn, ReportRow, ReportTable } from '../types/reportTable.js';
import { renderReportPdf } from '../services/accounting/reportPdfRenderer.js';

/** Unit tier — no database. */

function columns(n: number): ReportColumn[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `c${String(i)}`,
    label: `Col ${String(i)}`,
    align: i === 0 ? ('left' as const) : ('right' as const),
    widthChars: 12,
  }));
}

function table(cols: number, rowCount: number): ReportTable {
  const rows: ReportRow[] = Array.from({ length: rowCount }, (_, n) => ({
    style: 'detail',
    indent: 0,
    cells: { c0: { kind: 'text', value: `Row ${String(n + 1)}` }, c1: { kind: 'money', cents: 123456 + n } },
  }));
  return { title: 'Trial balance', subtitle: 'Org Alpha · USD', columns: columns(cols), rows, footnotes: ['Debits equal credits.'], filenameStem: 'tb' };
}

/** pdfkit writes text as hex strings inside TJ arrays; decode them back (as quotePdf.test does). */
function visibleText(raw: string): string {
  const out: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let line = '';
    for (const h of (m[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)) line += Buffer.from(h[1] ?? '', 'hex').toString('latin1');
    out.push(line);
  }
  return out.join('\n');
}

async function raw(t: ReportTable): Promise<string> {
  return (await renderReportPdf(t, { compress: false })).toString('latin1');
}

describe('renderReportPdf', () => {
  it('starts with %PDF-', async () => {
    const buf = await renderReportPdf(table(3, 3));
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('contains the title', async () => {
    const out = visibleText(await raw(table(3, 3)));
    expect(out).toContain('Trial balance');
    expect(out).toContain('1,234.56');
  });

  it('paginates a long table', async () => {
    const out = await raw(table(3, 200));
    expect((out.match(/\/Type \/Page(?![s\w])/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(visibleText(out)).toContain('Page 1 of ');
  });

  it('landscape over six columns', async () => {
    const out = await raw(table(7, 3));
    const m = /\/MediaBox \[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(Number(m?.[2]));
  });
});
