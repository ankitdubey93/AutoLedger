import PDFDocument from 'pdfkit';
import { formatMoney } from './statementEmailService.js';
import { money, quantity, rate } from './quotePdfRenderer.js';

/**
 * Phase 48 — an invoice or credit note as a PDF. Pure: bytes in, bytes out, no
 * database. Same layout family as the quote PDF (renderQuotePdf). One layout only:
 * the classic/modern/compact browser templates are not reproduced. Built-in
 * Helvetica (WinAnsi), so non-Latin text is a known limitation. Money is integer
 * cents throughout; the only division is inside the shared display helper `money`.
 */

export interface SalesDocumentPdfInput {
  kind: 'INVOICE' | 'CREDIT_NOTE';
  merchantName: string;
  merchantAddressLines: string[];
  logo: Buffer | null;
  number: string | null; // null renders "DRAFT"
  status: string; // 'VOID' prints "VOID" under the heading
  partyName: string;
  partyAddress: string | null;
  partyTaxNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  relatedNumber: string | null; // credit note: "Against invoice INV-..."
  currencyCode: string;
  paymentTerms: string | null;
  notes: string | null;
  bankDetails: string | null;
  lines: { description: string; quantityMilli: number; unitPriceCents: number; taxRateBp: number; netCents: number; taxCents?: number }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number | null;
  amountDueCents: number | null; // null hides both rows
  /** Phase 49e — an Australian organization's document. Null or absent: the generic layout, exactly as before. */
  gst?: SalesDocumentGst | null;
}

export interface SalesDocumentGst {
  registered: boolean;
  abn: string | null;
  legalName: string | null;
  inclusive: boolean;
  /** A credit note: why the sale was adjusted, which an adjustment note must state. */
  reason?: string | null;
}

/** 2026-09-03 becomes 03/09/2026. */
function auDate(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const MUTED = '#666666';

export function renderSalesDocumentPdf(
  input: SalesDocumentPdfInput,
  options: { compress?: boolean } = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const creditNote = input.kind === 'CREDIT_NOTE';
    const gst = input.gst ?? null;
    // Only a registered seller can issue a tax invoice; anyone else's would mislead the buyer into claiming a credit.
    const heading =
      gst?.registered === true ? (creditNote ? 'ADJUSTMENT NOTE' : 'TAX INVOICE') : creditNote ? 'CREDIT NOTE' : 'INVOICE';
    const showDate = (date: string): string => (gst === null ? date : auDate(date));
    const taxNumberLabel = gst === null ? 'Tax no.' : 'ABN';
    const label = input.number ?? 'DRAFT';
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: options.compress ?? true,
      info: { Title: `${heading} ${label}`, Producer: 'AutoLedger' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    try {
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const width = right - left;

      // Header: merchant (left), heading block (right).
      const top = doc.y;
      let leftY = top;
      if (input.logo !== null) {
        try {
          doc.image(input.logo, left, top, { fit: [120, 48] });
          leftY = top + 54;
        } catch {
          // An unreadable image is skipped, never fatal.
        }
      }
      doc.font(BOLD).fontSize(12).fillColor('black').text(input.merchantName, left, leftY, { width: width / 2 });
      doc.font(REGULAR).fontSize(9).fillColor(MUTED);
      if (gst?.legalName !== null && gst?.legalName !== undefined && gst.legalName !== input.merchantName) {
        doc.text(gst.legalName, left, doc.y, { width: width / 2 });
      }
      if (gst?.abn !== null && gst?.abn !== undefined) doc.text(`ABN ${gst.abn}`, left, doc.y, { width: width / 2 });
      for (const line of input.merchantAddressLines) doc.text(line, left, doc.y, { width: width / 2 });
      const leftEnd = doc.y;

      doc.font(BOLD).fontSize(18).fillColor('black').text(heading, left, top, { width, align: 'right' });
      doc.font(REGULAR).fontSize(10).text(label, left, doc.y, { width, align: 'right' });
      if (input.status === 'VOID') {
        doc.font(BOLD).fontSize(10).fillColor('#b00020').text('VOID', left, doc.y, { width, align: 'right' });
      }
      doc.font(REGULAR).fillColor(MUTED).fontSize(9);
      doc.text(`Date ${showDate(input.issueDate)}`, left, doc.y, { width, align: 'right' });
      if (input.dueDate !== null) doc.text(`Due ${showDate(input.dueDate)}`, left, doc.y, { width, align: 'right' });
      doc.y = Math.max(doc.y, leftEnd) + 16;

      // Party block.
      const partyTop = doc.y;
      doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(creditNote ? 'CREDITED TO' : 'BILL TO', left, partyTop, { width: width / 2 });
      doc.font(BOLD).fontSize(11).fillColor('black').text(input.partyName, left, doc.y, { width: width / 2 });
      doc.font(REGULAR).fontSize(9).fillColor(MUTED);
      if (input.partyAddress !== null) doc.text(input.partyAddress, left, doc.y, { width: width / 2 });
      if (input.partyTaxNumber !== null) doc.text(`${taxNumberLabel} ${input.partyTaxNumber}`, left, doc.y, { width: width / 2 });
      const partyEnd = doc.y;

      doc.y = partyTop;
      doc.font(REGULAR).fontSize(9).fillColor('black');
      if (input.relatedNumber !== null) {
        doc.text(`Against invoice ${input.relatedNumber}`, left, doc.y, { width, align: 'right' });
      }
      if (input.paymentTerms !== null) doc.text(`Payment terms: ${input.paymentTerms}`, left, doc.y, { width, align: 'right' });
      doc.text(`Currency: ${input.currencyCode}`, left, doc.y, { width, align: 'right' });
      doc.y = Math.max(doc.y, partyEnd) + 16;

      // Lines table.
      const colQty = left + width * 0.5;
      const colPrice = left + width * 0.62;
      const colTax = left + width * 0.78;
      const colAmt = left + width * 0.86;
      const descWidth = width * 0.48;
      const numW = {
        qty: width * 0.11,
        price: width * 0.15,
        tax: width * 0.07,
        amt: right - colAmt,
      };
      const drawHead = (): void => {
        const y = doc.y;
        doc.font(BOLD).fontSize(8).fillColor(MUTED);
        doc.text('DESCRIPTION', left, y, { width: descWidth });
        doc.text('QTY', colQty, y, { width: numW.qty, align: 'right' });
        doc.text('UNIT PRICE', colPrice, y, { width: numW.price, align: 'right' });
        doc.text('TAX', colTax, y, { width: numW.tax, align: 'right' });
        doc.text('AMOUNT', colAmt, y, { width: numW.amt, align: 'right' });
        const lineY = y + 12;
        doc.moveTo(left, lineY).lineTo(right, lineY).strokeColor('#bbbbbb').lineWidth(0.5).stroke();
        doc.y = lineY + 4;
      };
      drawHead();
      for (const line of input.lines) {
        if (doc.y > doc.page.height - 120) {
          doc.addPage();
          drawHead();
        }
        const y = doc.y;
        doc.font(REGULAR).fontSize(9).fillColor('black');
        doc.text(line.description, left, y, { width: descWidth });
        const endY = doc.y;
        doc.text(quantity(line.quantityMilli), colQty, y, { width: numW.qty, align: 'right' });
        doc.text(money(line.unitPriceCents), colPrice, y, { width: numW.price, align: 'right' });
        doc.text(line.taxRateBp === 0 ? '-' : `${rate(line.taxRateBp)}%`, colTax, y, { width: numW.tax, align: 'right' });
        // A price that included GST must add up to what the buyer pays.
        const lineAmount = gst?.inclusive === true ? line.netCents + (line.taxCents ?? 0) : line.netCents;
        doc.text(money(lineAmount), colAmt, y, { width: numW.amt, align: 'right' });
        doc.y = Math.max(endY, y + 11) + 4;
      }

      // Totals.
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.moveDown(0.5);
      const labelX = left + width * 0.55;
      const labelW = width * 0.25;
      const valX = labelX + labelW;
      const valW = right - valX;
      const totalRow = (name: string, value: string, bold: boolean): void => {
        const y = doc.y;
        doc.font(bold ? BOLD : REGULAR).fontSize(bold ? 10 : 9).fillColor('black');
        doc.text(name, labelX, y, { width: labelW });
        doc.text(value, valX, y, { width: valW, align: 'right' });
        doc.y = y + (bold ? 15 : 13);
      };
      totalRow('Subtotal', money(input.subtotalCents), false);
      if (gst?.registered !== false) totalRow(gst === null ? 'Tax' : 'GST', money(input.taxCents), false);
      totalRow('Total', formatMoney(input.totalCents, input.currencyCode), true);
      if (gst?.registered === true) {
        doc.font(REGULAR).fontSize(8).fillColor(MUTED);
        doc.text(`Total includes GST of ${money(input.taxCents)}. Lines showing "-" are not taxable.`, left, doc.y, { width, align: 'right' });
        doc.moveDown(0.4);
      }
      if (input.paidCents !== null && input.amountDueCents !== null) {
        totalRow('Paid', money(input.paidCents), false);
        totalRow('Amount due', formatMoney(input.amountDueCents, input.currencyCode), true);
      }

      const section = (heading2: string, body: string): void => {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.moveDown(0.8);
        doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(heading2, left, doc.y, { width });
        doc.font(REGULAR).fontSize(9).fillColor('black').text(body, left, doc.y, { width });
      };
      if (gst?.reason !== null && gst?.reason !== undefined) section('REASON FOR ADJUSTMENT', gst.reason);
      if (input.bankDetails !== null) section('PAYMENT DETAILS', input.bankDetails);
      if (input.notes !== null) section('NOTES', input.notes);

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
