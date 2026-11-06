/**
 * The ABA (Cemtext / BECS Direct Entry) file Australian banks accept for bulk
 * payments. Pure: fixed-width records of exactly 120 characters, CRLF-ended.
 *
 * Layout from the published format, not from a bank: a real test upload is
 * still required, and banks differ on whether they want a balancing record.
 */
export interface AbaHeader {
  financialInstitution: string;
  userName: string;
  apcaUserId: string;
  description: string;
  /** YYYY-MM-DD. */
  processingDate: string;
  traceBsb: string;
  traceAccountNumber: string;
  remitterName: string;
  selfBalancing: boolean;
}

export interface AbaCredit {
  bsb: string;
  accountNumber: string;
  accountName: string;
  amountCents: number;
  lodgementReference: string;
}

const RECORD_LENGTH = 120;
const MAX_FIELD_CENTS = 9_999_999_999;
const CREDIT_CODE = '50';
const DEBIT_CODE = '13';

/** The format's character set, upper-cased. Anything else would make a bank reject the whole file. */
function clean(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9 &'()*+,./:;=?@_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function left(value: string, width: number): string {
  return clean(value).slice(0, width).padEnd(width, ' ');
}

function right(value: string, width: number): string {
  return value.slice(-width).padStart(width, ' ');
}

function zeros(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function blank(width: number): string {
  return ' '.repeat(width);
}

function record(fields: string[]): string {
  const line = fields.join('');
  if (line.length !== RECORD_LENGTH) throw new Error(`ABA record is ${String(line.length)} characters, not ${String(RECORD_LENGTH)}`);
  return line;
}

export function normalizeBsb(value: string): string | null {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
}

/** Up to nine characters, digits or hyphens, as the field allows. Spaces are only formatting. */
export function normalizeAccountNumber(value: string): string | null {
  const compact = value.replace(/\s/g, '');
  return /^[0-9-]{1,9}$/.test(compact) && /\d/.test(compact) ? compact : null;
}

function detail(code: string, r: AbaCredit, header: AbaHeader): string {
  return record([
    '1',
    r.bsb,
    right(r.accountNumber, 9),
    ' ',
    code,
    zeros(r.amountCents, 10),
    left(r.accountName, 32),
    left(r.lodgementReference, 18),
    header.traceBsb,
    right(header.traceAccountNumber, 9),
    left(header.remitterName, 16),
    zeros(0, 8),
  ]);
}

export function buildAbaFile(header: AbaHeader, credits: readonly AbaCredit[]): string {
  if (credits.length === 0) throw new Error('An ABA file needs at least one payment');
  const y = header.processingDate.slice(2, 4);
  const m = header.processingDate.slice(5, 7);
  const d = header.processingDate.slice(8, 10);

  const lines = [
    record([
      '0',
      blank(17),
      '01',
      left(header.financialInstitution, 3),
      blank(7),
      left(header.userName, 26),
      header.apcaUserId,
      left(header.description, 12),
      `${d}${m}${y}`,
      blank(40),
    ]),
  ];

  let creditTotal = 0;
  for (const credit of credits) {
    if (credit.amountCents <= 0 || credit.amountCents > MAX_FIELD_CENTS) {
      throw new Error(`An ABA amount must be between 1 cent and $99,999,999.99, not ${String(credit.amountCents)} cents`);
    }
    creditTotal += credit.amountCents;
    lines.push(detail(CREDIT_CODE, credit, header));
  }

  let debitTotal = 0;
  let count = credits.length;
  if (header.selfBalancing) {
    debitTotal = creditTotal;
    count += 1;
    lines.push(
      detail(
        DEBIT_CODE,
        {
          bsb: header.traceBsb,
          accountNumber: header.traceAccountNumber,
          accountName: header.remitterName,
          amountCents: creditTotal,
          lodgementReference: header.description,
        },
        header,
      ),
    );
  }
  if (creditTotal > MAX_FIELD_CENTS) throw new Error('This pay run is too large for one ABA file');

  lines.push(
    record([
      '7',
      '999-999',
      blank(12),
      zeros(Math.abs(creditTotal - debitTotal), 10),
      zeros(creditTotal, 10),
      zeros(debitTotal, 10),
      blank(24),
      zeros(count, 6),
      blank(40),
    ]),
  );
  return `${lines.join('\r\n')}\r\n`;
}
