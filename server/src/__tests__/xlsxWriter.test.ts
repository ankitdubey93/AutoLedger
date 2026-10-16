import { describe, expect, it } from 'vitest';
import type { ReportTable } from '../types/reportTable.js';
import { buildXlsx } from '../utils/xlsxWriter.js';
import { readZip } from './helpers/zipReader.js';

/** Unit tier — no database. */

function fixture(overrides: Partial<ReportTable> = {}): ReportTable {
  return {
    title: 'Profit & loss',
    subtitle: 'Org · USD',
    columns: [
      { key: 'name', label: 'Name', align: 'left', widthChars: 20 },
      { key: 'amount', label: 'Amount', align: 'right', widthChars: 14 },
    ],
    rows: [
      { style: 'heading', indent: 0, cells: { name: { kind: 'text', value: 'Revenue' } } },
      { style: 'detail', indent: 1, cells: { name: { kind: 'text', value: 'Sales' }, amount: { kind: 'money', cents: 123456 } } },
      { style: 'total', indent: 0, cells: { name: { kind: 'text', value: 'Net' }, amount: { kind: 'money', cents: -5000 } } },
    ],
    footnotes: ['Note <1>'],
    filenameStem: 'pl',
    ...overrides,
  };
}

function sheet(table: ReportTable): string {
  return (readZip(buildXlsx(table)).get('xl/worksheets/sheet1.xml') ?? Buffer.alloc(0)).toString('utf8');
}

describe('buildXlsx', () => {
  it('contains the six parts', () => {
    expect([...readZip(buildXlsx(fixture())).keys()].sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ].sort(),
    );
  });

  it('money is numeric', () => {
    const xml = sheet(fixture());
    expect(xml).toContain('<c r="B6" s="2"><v>1234.56</v></c>');
    expect(xml).toContain('<c r="B7" s="3"><v>-50.00</v></c>');
  });

  it('text is inline and escaped', () => {
    const xml = sheet(fixture());
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain('Profit &amp; loss');
    expect(xml).toContain('Note &lt;1&gt;');
  });

  it('freezes the header', () => {
    expect(sheet(fixture())).toContain('ySplit="4"');
  });

  it('sheet name strips forbidden characters', () => {
    const wb = readZip(buildXlsx(fixture({ title: 'A/B:C' }))).get('xl/workbook.xml')?.toString('utf8') ?? '';
    expect(wb).toContain('name="ABC"');
  });

  it('strips control characters', () => {
    const t = fixture({
      rows: [{ style: 'detail', indent: 0, cells: { name: { kind: 'text', value: 'x\u0001y' } } }],
    });
    const xml = sheet(t);
    expect(xml).toContain('>xy<');
    expect(xml).not.toContain('\u0001');
  });
});
