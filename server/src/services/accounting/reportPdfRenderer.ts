import PDFDocument from 'pdfkit';
import type { ReportCell, ReportTable } from '../../types/reportTable.js';
import { bpToPercentText, groupedCents, milliToDecimal } from '../../utils/reportCellText.js';

/**
 * Phase 45 — any ReportTable as a PDF. Pure: bytes in, bytes out, no database. The column
 * header repeats on every page; "Page i of n" footers are drawn after layout (bufferPages).
 * Built-in Helvetica only (WinAnsi), the same limitation as quote PDFs: non-Latin text is
 * not supported. Money arrives as integer cents and is only formatted here.
 */

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const MUTED = '#666666';
const MARGIN = 36;
const ROW_HEIGHT = 14;
const FOOTER_RESERVE = 20;
const INDENT_PT = 10;
const CELL_PAD = 2;

function cellText(cell: ReportCell | undefined): string {
  if (cell === undefined) return '';
  switch (cell.kind) {
    case 'text':
      return cell.value;
    case 'money':
      return groupedCents(cell.cents);
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

export function renderReportPdf(table: ReportTable, options: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: table.columns.length > 6 ? 'landscape' : 'portrait',
      margin: MARGIN,
      bufferPages: true,
      compress: options.compress ?? true,
      info: { Title: table.title, Producer: 'AutoLedger' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    try {
      const left = MARGIN;
      const width = doc.page.width - MARGIN * 2;
      const right = left + width;
      const totalChars = table.columns.reduce((sum, c) => sum + c.widthChars, 0);
      const widths = table.columns.map((c) => (width * c.widthChars) / totalChars);
      const xs: number[] = [];
      let cursor = left;
      for (const w of widths) {
        xs.push(cursor);
        cursor += w;
      }

      doc.font(BOLD).fontSize(14).fillColor('black').text(table.title, left, MARGIN, { width });
      doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(table.subtitle, left, doc.y, { width });
      doc.y += 12;

      const drawHeader = (): void => {
        const y = doc.y;
        doc.font(BOLD).fontSize(8).fillColor('black');
        table.columns.forEach((col, i) => {
          doc.text(col.label, (xs[i] ?? left) + CELL_PAD, y, {
            width: (widths[i] ?? 0) - CELL_PAD * 2,
            align: col.align,
            lineBreak: false,
            ellipsis: true,
          });
        });
        const ruleY = y + ROW_HEIGHT - 2;
        doc.moveTo(left, ruleY).lineTo(right, ruleY).strokeColor('black').lineWidth(0.5).stroke();
        doc.y = y + ROW_HEIGHT;
      };

      const limit = doc.page.height - MARGIN - FOOTER_RESERVE;
      drawHeader();

      for (const row of table.rows) {
        if (doc.y + ROW_HEIGHT > limit) {
          doc.addPage();
          doc.y = MARGIN;
          drawHeader();
        }
        const y = doc.y;
        if (row.style === 'subtotal' || row.style === 'total') {
          doc
            .moveTo(left, y - 1)
            .lineTo(right, y - 1)
            .strokeColor('black')
            .lineWidth(row.style === 'total' ? 1 : 0.5)
            .stroke();
        }
        const bold = row.style !== 'detail';
        doc.font(bold ? BOLD : REGULAR).fontSize(8).fillColor('black');
        table.columns.forEach((col, i) => {
          const indent = i === 0 ? INDENT_PT * row.indent : 0;
          doc.text(cellText(row.cells[col.key]), (xs[i] ?? left) + CELL_PAD + indent, y, {
            width: (widths[i] ?? 0) - CELL_PAD * 2 - indent,
            align: col.align,
            lineBreak: false,
            ellipsis: true,
          });
        });
        doc.y = y + ROW_HEIGHT;
      }

      if (table.footnotes.length > 0) {
        doc.y += 6;
        doc.font(REGULAR).fontSize(8).fillColor(MUTED);
        for (const note of table.footnotes) {
          if (doc.y + ROW_HEIGHT > limit) {
            doc.addPage();
            doc.y = MARGIN;
            doc.font(REGULAR).fontSize(8).fillColor(MUTED);
          }
          doc.text(note, left, doc.y, { width });
        }
      }

      // Footers, once the page count is known. The footer sits inside the bottom margin,
      // where pdfkit would otherwise start a new page, so the margin is zeroed while drawing.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .font(REGULAR)
          .fontSize(7)
          .fillColor(MUTED)
          .text(`Page ${String(i + 1)} of ${String(range.count)}`, left, doc.page.height - MARGIN + 6, {
            width,
            align: 'center',
            lineBreak: false,
          });
        doc.page.margins.bottom = bottom;
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
