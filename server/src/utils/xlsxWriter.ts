import type { ReportCell, ReportTable } from '../types/reportTable.js';
import { bpToFraction, centsToDecimal, isoToExcelSerial, milliToDecimal } from './reportCellText.js';
import { buildZip } from './zipWriter.js';

/**
 * Phase 45 — a hand-rolled .xlsx (SpreadsheetML in a ZIP). Six parts, inline strings
 * (no sharedStrings part), nine fixed cell styles. Money cells carry the integer-cent
 * value as exact decimal text (`1234.56`), never a float computed here.
 */

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// cellXfs indexes — keep in step with STYLES_XML below.
const S_TEXT = 0;
const S_TEXT_BOLD = 1;
const S_MONEY = 2;
const S_MONEY_BOLD = 3;
const S_DATE = 4;
const S_PERCENT = 5;
const S_PERCENT_BOLD = 6;
const S_QTY = 7;
const S_QTY_BOLD = 8;

// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escapeXml(value: string): string {
  return value
    .replace(ILLEGAL_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnLetters(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function sheetName(title: string): string {
  const cleaned = title.replace(/[\\/?*[\]:]/g, '').trim().slice(0, 31);
  return cleaned === '' ? 'Report' : cleaned;
}

const CONTENT_TYPES_XML =
  `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_RELS_XML =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL_TYPE}/styles" Target="styles.xml"/>` +
  '</Relationships>';

const STYLES_XML =
  `${XML_HEADER}<styleSheet xmlns="${NS_MAIN}">` +
  '<numFmts count="2">' +
  '<numFmt numFmtId="164" formatCode="#,##0.00;-#,##0.00"/>' +
  '<numFmt numFmtId="165" formatCode="#,##0.###"/>' +
  '</numFmts>' +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '</fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="9">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="10" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function textCell(ref: string, style: number, value: string): string {
  return `<c r="${ref}" t="inlineStr" s="${String(style)}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function numberCell(ref: string, style: number, value: string): string {
  return `<c r="${ref}" s="${String(style)}"><v>${value}</v></c>`;
}

function renderCell(ref: string, cell: ReportCell, bold: boolean, prefix: string): string {
  switch (cell.kind) {
    case 'text':
      return textCell(ref, bold ? S_TEXT_BOLD : S_TEXT, prefix + cell.value);
    case 'money':
      return numberCell(ref, bold ? S_MONEY_BOLD : S_MONEY, centsToDecimal(cell.cents));
    case 'quantity':
      return numberCell(ref, bold ? S_QTY_BOLD : S_QTY, milliToDecimal(cell.milli));
    case 'percent':
      return cell.bp === null ? '' : numberCell(ref, bold ? S_PERCENT_BOLD : S_PERCENT, bpToFraction(cell.bp));
    case 'date':
      return numberCell(ref, S_DATE, String(isoToExcelSerial(cell.iso)));
    case 'empty':
      return '';
  }
}

function row(rowNumber: number, cells: string): string {
  return cells === '' ? '' : `<row r="${String(rowNumber)}">${cells}</row>`;
}

export function buildXlsx(table: ReportTable): Buffer {
  const rows: string[] = [];
  rows.push(row(1, textCell('A1', S_TEXT_BOLD, table.title)));
  rows.push(row(2, textCell('A2', S_TEXT, table.subtitle)));
  rows.push(
    row(
      4,
      table.columns.map((c, i) => textCell(`${columnLetters(i)}4`, S_TEXT_BOLD, c.label)).join(''),
    ),
  );

  let r = 5;
  for (const tableRow of table.rows) {
    const bold = tableRow.style !== 'detail';
    const cells = table.columns
      .map((col, i) => {
        const cell = tableRow.cells[col.key];
        if (cell === undefined) return '';
        const prefix = i === 0 ? '  '.repeat(tableRow.indent) : '';
        return renderCell(`${columnLetters(i)}${String(r)}`, cell, bold, prefix);
      })
      .join('');
    rows.push(row(r, cells));
    r += 1;
  }

  if (table.footnotes.length > 0) {
    r += 1;
    for (const note of table.footnotes) {
      rows.push(row(r, textCell(`A${String(r)}`, S_TEXT, note)));
      r += 1;
    }
  }

  const cols = table.columns
    .map((c, i) => `<col min="${String(i + 1)}" max="${String(i + 1)}" width="${String(c.widthChars + 2)}" customWidth="1"/>`)
    .join('');

  const sheetXml =
    `${XML_HEADER}<worksheet xmlns="${NS_MAIN}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>';

  const workbookXml =
    `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets><sheet name="${escapeXml(sheetName(table.title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  return buildZip([
    { path: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8') },
    { path: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf8') },
    { path: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { path: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS_XML, 'utf8') },
    { path: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { path: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ]);
}
