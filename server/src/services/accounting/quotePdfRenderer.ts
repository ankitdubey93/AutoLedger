import PDFDocument from 'pdfkit';
import type { QuoteDirection } from '../../types/accounting.js';
import { formatMoney } from './statementEmailService.js';

/**
 * Phase 42 — a quote as a PDF. Pure: bytes in, bytes out, no database. Mirrors the
 * layout of the client's QuoteDocument (header, party block, title, lines, totals,
 * notes, terms). Built-in Helvetica only (WinAnsi): non-Latin text is a known
 * limitation. Money is integer cents throughout; the only division is for display.
 */

export interface QuotePdfInput {
  merchantName: string;
  merchantAddressLines: string[];
  logo: Buffer | null; // PNG or JPEG bytes only
  direction: QuoteDirection;
  quoteNumber: string | null;
  revision: number;
  partyName: string;
  partyAddress: string | null;
  partyTaxNumber: string | null;
  partyReference: string | null;
  quoteDate: string;
  validUntil: string;
  currencyCode: string;
  title: string | null;
  notes: string | null;
  terms: string | null;
  paymentTerms: string | null;
  depositPercentBp: number | null; // render nothing when null
  lines: { description: string; quantityMilli: number; unitPriceCents: number; taxRateBp: number; netCents: number }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const MUTED = '#666666';

/** Integer-cents amount with thousands grouping, no currency. */
function money(cents: number): string {
  const magnitude = Math.abs(cents);
  const major = String(Math.trunc(magnitude / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minor = String(magnitude % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${major}.${minor}`;
}

/** Quantity in thousandths, up to 3 decimals, trailing zeros trimmed. */
function quantity(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const frac = String(Math.abs(milli % 1000)).padStart(3, '0').replace(/0+$/, '');
  return frac === '' ? String(whole) : `${String(whole)}.${frac}`;
}

/** Basis points as a percentage, e.g. 1850 -> "18.5". */
function rate(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return frac === '' ? String(whole) : `${String(whole)}.${frac}`;
}

function label(input: Pick<QuotePdfInput, 'quoteNumber' | 'revision'>): string {
  if (input.quoteNumber === null) return input.revision > 1 ? `DRAFT revision ${String(input.revision)}` : 'DRAFT';
  return input.revision > 1 ? `${input.quoteNumber} rev ${String(input.revision)}` : input.quoteNumber;
}

export function renderQuotePdf(input: QuotePdfInput, options: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const purchase = input.direction === 'PURCHASE';
    const heading = purchase ? 'PURCHASE QUOTE' : 'QUOTE';
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: options.compress ?? true,
      info: { Title: `${heading} ${label(input)}`, Producer: 'AutoLedger' },
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
      for (const line of input.merchantAddressLines) doc.text(line, left, doc.y, { width: width / 2 });
      const leftEnd = doc.y;

      doc.font(BOLD).fontSize(18).fillColor('black').text(heading, left, top, { width, align: 'right' });
      doc.font(REGULAR).fontSize(10).text(label(input), left, doc.y, { width, align: 'right' });
      doc.fillColor(MUTED).fontSize(9);
      doc.text(`Date ${input.quoteDate}`, left, doc.y, { width, align: 'right' });
      doc.text(`Valid until ${input.validUntil}`, left, doc.y, { width, align: 'right' });
      doc.y = Math.max(doc.y, leftEnd) + 16;

      // Party block.
      const partyTop = doc.y;
      doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(purchase ? 'VENDOR' : 'PREPARED FOR', left, partyTop, { width: width / 2 });
      doc.font(BOLD).fontSize(11).fillColor('black').text(input.partyName, left, doc.y, { width: width / 2 });
      doc.font(REGULAR).fontSize(9).fillColor(MUTED);
      if (input.partyAddress !== null) doc.text(input.partyAddress, left, doc.y, { width: width / 2 });
      if (input.partyTaxNumber !== null) doc.text(`Tax no. ${input.partyTaxNumber}`, left, doc.y, { width: width / 2 });
      const partyEnd = doc.y;

      doc.y = partyTop;
      doc.font(REGULAR).fontSize(9).fillColor('black');
      if (input.partyReference !== null) {
        doc.text(`${purchase ? 'Your quote no.' : 'Your reference'}: ${input.partyReference}`, left, doc.y, { width, align: 'right' });
      }
      if (input.paymentTerms !== null) doc.text(`Payment terms: ${input.paymentTerms}`, left, doc.y, { width, align: 'right' });
      doc.text(`Currency: ${input.currencyCode}`, left, doc.y, { width, align: 'right' });
      if (input.depositPercentBp !== null) {
        doc.text(`Deposit on acceptance: ${rate(input.depositPercentBp)}%`, left, doc.y, { width, align: 'right' });
      }
      doc.y = Math.max(doc.y, partyEnd) + 16;

      if (input.title !== null) {
        doc.font(BOLD).fontSize(12).fillColor('black').text(input.title, left, doc.y, { width });
        doc.moveDown(0.6);
      }

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
        doc.text(money(line.netCents), colAmt, y, { width: numW.amt, align: 'right' });
        doc.y = Math.max(endY, y + 11) + 4;
      }

      // Totals.
      if (doc.y > doc.page.height - 120) doc.addPage();
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
      totalRow('Tax', money(input.taxCents), false);
      totalRow('Total', formatMoney(input.totalCents, input.currencyCode), true);

      const section = (heading2: string, body: string): void => {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.moveDown(0.8);
        doc.font(REGULAR).fontSize(8).fillColor(MUTED).text(heading2, left, doc.y, { width });
        doc.font(REGULAR).fontSize(9).fillColor('black').text(body, left, doc.y, { width });
      };
      if (input.notes !== null) section('NOTES', input.notes);
      if (input.terms !== null) section('TERMS AND CONDITIONS', input.terms);

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
