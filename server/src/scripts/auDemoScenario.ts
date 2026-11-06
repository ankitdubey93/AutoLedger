/**
 * Phase 49i — the Australian demo: Wattle & Ash Bakehouse, two quarters of
 * books, entered through the real API. A fictional business; its ABNs pass the
 * checksum and are not meant to be anyone's.
 *
 * The answer key below is worked by hand from the transactions, in
 * walkthrough/australia/README.md, never read back from the engine. Run on both
 * bases it has its own cross-check: once everything is paid, the two bases must
 * report the same GST over the two quarters.
 *
 * The bill inbox is not replayed, because capture needs a real vision model;
 * gstCapture.test.ts covers a mixed receipt instead.
 */
export interface AuResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

export interface AuApi {
  get(path: string): Promise<AuResponse>;
  post(path: string, body?: unknown): Promise<AuResponse>;
  patch(path: string, body?: unknown): Promise<AuResponse>;
  put(path: string, body?: unknown): Promise<AuResponse>;
}

export const AU_ORG_NAME = 'Wattle & Ash Bakehouse';

const ABN = {
  self: '90 123 400 160',
  harbourCafe: '90 123 400 192',
  quayHotel: '90 123 400 241',
  flourMill: '90 123 400 273',
  packaging: '90 123 400 322',
  ovenWorks: '90 123 400 354',
  sunriseCleaning: '90 123 400 386',
} as const;

/** Worked by hand. Cents. Keys are BAS labels. */
export const AU_ANSWER_KEY = {
  ACCRUAL: {
    q1: { G1: 504_000, G2: 80_000, G3: 50_000, G4: 0, G5: 130_000, G6: 374_000, G7: 0, G8: 374_000, G9: 34_000, G10: 550_000, G11: 126_000, G12: 676_000, G13: 0, G14: 60_000, G15: 0, G16: 60_000, G17: 616_000, G18: 0, G19: 616_000, G20: 56_000, '1A': 34_000, '1B': 56_000 },
    q2: { G1: 170_500, G2: 0, G3: 0, G4: 0, G5: 0, G6: 170_500, G7: -11_000, G8: 159_500, G9: 14_500, G10: 0, G11: 109_600, G12: 109_600, G13: 0, G14: 70_000, G15: 0, G16: 70_000, G17: 39_600, G18: -3_300, G19: 36_300, G20: 3_300, '1A': 14_500, '1B': 3_300 },
    netPayable: { q1: 230, q2: 812 },
  },
  CASH: {
    q1: { G1: 245_000, G2: 0, G3: 25_000, G4: 0, G5: 25_000, G6: 220_000, G7: 0, G8: 220_000, G9: 20_000, G10: 275_000, G11: 126_000, G12: 401_000, G13: 0, G14: 60_000, G15: 0, G16: 60_000, G17: 341_000, G18: 0, G19: 341_000, G20: 31_000, '1A': 20_000, '1B': 31_000 },
    q2: { G1: 418_500, G2: 80_000, G3: 25_000, G4: 0, G5: 105_000, G6: 313_500, G7: 0, G8: 313_500, G9: 28_500, G10: 275_000, G11: 106_300, G12: 381_300, G13: 0, G14: 70_000, G15: 0, G16: 70_000, G17: 311_300, G18: 0, G19: 311_300, G20: 28_300, '1A': 28_500, '1B': 28_300 },
    netPayable: { q1: 340, q2: 702 },
  },
  payg: { q1: { w1: 300_000, w2: 45_000, instalment: 0 }, q2: { w1: 330_000, w2: 50_000, instalment: 20_000 } },
  tpar: { firstYear: { grossPaidCents: 22_000, gstCents: 2_000 }, secondYear: { grossPaidCents: 22_000, gstCents: 2_000 } },
} as const;

/** The two most recently completed calendar quarters, as the first day of the earlier one. */
export function defaultAuAnchor(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const quarterIndex = Math.floor((month - 1) / 3);
  const earlier = new Date(Date.UTC(year, (quarterIndex - 2) * 3, 1));
  return earlier.toISOString().slice(0, 10);
}

export interface AuScenarioResult {
  q1Id: string;
  q2Id: string;
  q1Start: string;
  q2Start: string;
}

export async function runAuScenario(api: AuApi, anchor: string, basis: 'CASH' | 'ACCRUAL'): Promise<AuScenarioResult> {
  function check(res: AuResponse, status: number, what: string): void {
    if (res.status !== status) throw new Error(`au demo: ${what} failed: ${String(res.status)} ${res.text}`);
  }

  // quarter 1 or 2, month 1-3 within it, day 1-28.
  function on(quarter: 1 | 2, month: 1 | 2 | 3, day: number): string {
    const startYear = Number(anchor.slice(0, 4));
    const startMonth = Number(anchor.slice(5, 7)) - 1;
    const date = new Date(Date.UTC(startYear, startMonth + (quarter - 1) * 3 + month - 1, day));
    return date.toISOString().slice(0, 10);
  }
  const FAR = '2099-12-31';

  const setup = await api.post('/api/v1/settings/onboarding', {
    organizationName: AU_ORG_NAME,
    legalName: 'Wattle & Ash Bakehouse Pty Ltd',
    baseCurrency: 'AUD',
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    booksStartDate: `${String(Number(anchor.slice(0, 4)) - 1)}-07-01`,
    industry: 'Retail',
    timezone: 'Australia/Sydney',
    cashAccountId: null,
    australia: { gst: { registered: true, basis, basCycle: 'QUARTERLY', basMethod: 'FULL' } },
  });
  check(setup, 200, 'setup');
  check(await api.patch('/api/v1/organizations', { taxNumber: ABN.self }), 200, 'own ABN');

  const accountsRes = await api.get('/api/v1/accounts');
  check(accountsRes, 200, 'accounts');
  const accounts = new Map((accountsRes.body.accounts as { id: string; code: string }[]).map((a) => [a.code, a.id]));
  const account = (code: string): string => {
    const id = accounts.get(code);
    if (id === undefined) throw new Error(`au demo: no account ${code}`);
    return id;
  };

  async function customer(name: string, taxNumber: string | null): Promise<string> {
    const res = await api.post('/api/v1/customers', { name, taxNumber, billingAddress: '12 Wharf Rd, Sydney NSW 2000' });
    check(res, 201, `customer ${name}`);
    return res.body.customer.id as string;
  }
  async function vendor(name: string, taxNumber: string | null, tparReportable = false): Promise<string> {
    const res = await api.post('/api/v1/vendors', { name, taxNumber, billingAddress: '4 Mill Ln, Newcastle NSW 2300', tparReportable });
    check(res, 201, `vendor ${name}`);
    return res.body.vendor.id as string;
  }

  const harbourCafe = await customer('Harbour Cafe', ABN.harbourCafe);
  const quayHotel = await customer('Quay Hotel', ABN.quayHotel);
  const aucklandDeli = await customer('Auckland Deli', 'NZ-99-123');
  const flourMill = await vendor('Flour Mill Co', ABN.flourMill);
  const packaging = await vendor('Packaging Direct', ABN.packaging);
  const ovenWorks = await vendor('Oven Works', ABN.ovenWorks);
  const sunrise = await vendor('Sunrise Cleaning', ABN.sunriseCleaning, true);

  async function invoice(customerId: string, issueDate: string, lines: { cents: number; code: string; text: string }[], taxMode = 'EXCLUSIVE'): Promise<string> {
    const created = await api.post('/api/v1/invoices', {
      customerId,
      issueDate,
      dueDate: FAR,
      notes: null,
      paymentTerms: null,
      taxMode,
      lines: lines.map((l) => ({ description: l.text, quantityMilli: 1000, unitPriceCents: l.cents, revenueAccountId: account('4100'), taxCode: l.code })),
    });
    check(created, 201, 'invoice');
    const id = created.body.invoice.id as string;
    check(await api.post(`/api/v1/invoices/${id}/issue`, {}), 200, 'issue');
    return id;
  }

  async function bill(vendorId: string, reference: string, billDate: string, cents: number, code: string, accountCode = '6130'): Promise<string> {
    const created = await api.post('/api/v1/bills', {
      vendorId,
      vendorReference: reference,
      billDate,
      dueDate: FAR,
      notes: null,
      paymentTerms: null,
      lines: [{ description: reference, quantityMilli: 1000, unitPriceCents: cents, expenseAccountId: account(accountCode), taxCode: code }],
    });
    check(created, 201, `bill ${reference}`);
    const id = created.body.bill.id as string;
    check(await api.post(`/api/v1/bills/${id}/submit`, {}), 200, 'submit');
    check(await api.post(`/api/v1/bills/${id}/approve`, {}), 200, 'approve');
    return id;
  }

  async function receive(customerId: string, invoiceId: string, cents: number, date: string): Promise<void> {
    const res = await api.post('/api/v1/payments', {
      direction: 'RECEIVE',
      paymentDate: date,
      amountCents: cents,
      cashAccountId: account('1110'),
      customerId,
      reference: `R-${date}`,
      allocations: [{ invoiceId, billId: null, amountCents: cents }],
    });
    check(res, 201, 'receive');
  }

  async function pay(vendorId: string, billId: string, cents: number, date: string): Promise<void> {
    const res = await api.post('/api/v1/payments', {
      direction: 'PAY',
      paymentDate: date,
      amountCents: cents,
      cashAccountId: account('1110'),
      vendorId,
      reference: `P-${date}`,
      allocations: [{ invoiceId: null, billId, amountCents: cents }],
    });
    check(res, 201, 'pay');
  }

  async function wages(date: string, gross: number, withheld: number): Promise<void> {
    const res = await api.post('/api/v1/manual-journals', {
      entryDate: date,
      narration: 'Wages from payroll software',
      action: 'post',
      lines: [
        { accountId: account('6100'), debitCents: gross },
        { accountId: account('2162'), creditCents: withheld },
        { accountId: account('2120'), creditCents: gross - withheld },
      ],
    });
    check(res, 201, 'wages');
  }

  async function statement(rows: [string, string, number][]): Promise<Map<string, string>> {
    const csv = ['Date,Description,Amount', ...rows.map(([d, memo, cents]) => `${d},${memo},${(cents / 100).toFixed(2)}`)].join('\n');
    const res = await api.post('/api/v1/bank-imports', { accountId: account('1110'), fileName: `statement-${rows[0]?.[0] ?? ''}.csv`, content: csv });
    check(res, 201, 'bank import');
    const list = await api.get('/api/v1/bank-transactions?limit=200');
    check(list, 200, 'bank lines');
    return new Map((list.body.transactions as { id: string; description: string }[]).map((t) => [t.description, t.id]));
  }

  async function postLine(id: string | undefined, accountCode: string, taxCode: string | null): Promise<void> {
    check(await api.post(`/api/v1/bank-transactions/${id ?? ''}/post-journal`, { accountId: account(accountCode), taxCode }), 200, 'post bank line');
  }

  async function newBas(start: string, w1: number, w2: number, instalment: number): Promise<string> {
    const res = await api.post('/api/v1/bas', { periodStart: start });
    check(res, 201, 'new BAS');
    const id = res.body.bas.id as string;
    check(await api.patch(`/api/v1/bas/${id}`, { w1Cents: w1, w2Cents: w2, instalmentCents: instalment }), 200, 'PAYG');
    return id;
  }

  // ---- Quarter 1 ----
  const i1 = await invoice(harbourCafe, on(1, 1, 10), [{ cents: 100_000, code: 'S_GST', text: 'Catering, April' }]);
  await receive(harbourCafe, i1, 110_000, on(1, 2, 5));

  const i2 = await invoice(
    quayHotel,
    on(1, 2, 20),
    [
      { cents: 220_000, code: 'S_GST', text: 'Pastries, wedding order' },
      { cents: 50_000, code: 'S_FREE', text: 'Plain bread' },
    ],
    'INCLUSIVE',
  );
  await receive(quayHotel, i2, 135_000, on(1, 3, 15));

  const i3 = await invoice(aucklandDeli, on(1, 3, 1), [{ cents: 80_000, code: 'S_EXPORT', text: 'Shortbread export' }]);
  const i4 = await invoice(harbourCafe, on(1, 3, 25), [{ cents: 40_000, code: 'S_GST', text: 'Catering, June' }]);

  const b1 = await bill(flourMill, 'FM-101', on(1, 1, 12), 60_000, 'P_FREE', '5100');
  await pay(flourMill, b1, 60_000, on(1, 1, 28));
  const b2 = await bill(packaging, 'PD-55', on(1, 2, 3), 30_000, 'P_GST');
  await pay(packaging, b2, 33_000, on(1, 2, 28));
  const b3 = await bill(ovenWorks, 'OW-9', on(1, 3, 5), 500_000, 'P_CAP_GST', '1500');
  await pay(ovenWorks, b3, 275_000, on(1, 3, 20));
  const b4 = await bill(sunrise, 'SC-1', on(1, 3, 10), 20_000, 'P_GST', '6200');
  await pay(sunrise, b4, 22_000, on(1, 3, 28));

  await wages(on(1, 3, 28), 300_000, 45_000);
  const q1Lines = await statement([
    [on(1, 3, 18), 'Telstra phone', -11_000],
    [on(1, 3, 28), 'Wages paid', -255_000],
  ]);
  await postLine(q1Lines.get('Telstra phone'), '6110', 'P_GST');
  await postLine(q1Lines.get('Wages paid'), '2120', null);

  const q1Id = await newBas(on(1, 1, 1), 300_000, 45_000, 0);
  check(await api.post(`/api/v1/bas/${q1Id}/finalise`, {}), 200, 'finalise Q1');
  check(await api.post(`/api/v1/bas/${q1Id}/lodge`, { lodgedOn: on(2, 1, 20), atoReference: 'DEMO-Q1' }), 200, 'lodge Q1');

  // ---- Quarter 2 ----
  await pay(ovenWorks, b3, 275_000, on(2, 1, 5));
  await receive(quayHotel, i2, 135_000, on(2, 1, 10));
  await receive(harbourCafe, i4, 44_000, on(2, 1, 20));
  await receive(aucklandDeli, i3, 80_000, on(2, 2, 3));

  const i5 = await invoice(harbourCafe, on(2, 2, 10), [{ cents: 150_000, code: 'S_GST', text: 'Catering, August' }]);

  // A credit against April's paid invoice: an adjustment on accruals, then used on August's.
  const creditNote = await api.post('/api/v1/credit-notes', {
    invoiceId: i1,
    issueDate: on(2, 2, 15),
    reasonCode: 'PRICE_ADJUSTMENT',
    reason: 'Short delivery in April',
    notes: null,
    lines: [{ description: 'Short delivery', quantityMilli: 1000, unitPriceCents: 10_000, revenueAccountId: account('4100'), taxCode: 'S_GST' }],
  });
  check(creditNote, 201, 'credit note');
  const cn = creditNote.body.creditNote.id as string;
  check(await api.post(`/api/v1/credit-notes/${cn}/issue`, {}), 200, 'issue note');
  check(await api.post(`/api/v1/credit-notes/${cn}/allocations`, { invoiceId: i5, amountCents: 11_000, allocationDate: on(2, 2, 20) }), 201, 'apply note');
  await receive(harbourCafe, i5, 154_000, on(2, 3, 1));

  const b5 = await bill(flourMill, 'FM-102', on(2, 1, 15), 70_000, 'P_FREE', '5100');
  const b6 = await bill(packaging, 'PD-61', on(2, 3, 1), 10_000, 'P_GST');
  const b7 = await bill(sunrise, 'SC-2', on(2, 2, 1), 20_000, 'P_GST', '6200');

  // A debit against May's paid bill, used on September's.
  const debitNote = await api.post('/api/v1/debit-notes', {
    billId: b2,
    issueDate: on(2, 2, 20),
    reasonCode: 'RETURN',
    reason: 'Damaged boxes returned',
    vendorCreditReference: 'PD-CR-3',
    notes: null,
    lines: [{ description: 'Damaged boxes', quantityMilli: 1000, unitPriceCents: 3_000, expenseAccountId: account('6130'), taxCode: 'P_GST' }],
  });
  check(debitNote, 201, 'debit note');
  const dn = debitNote.body.debitNote.id as string;
  check(await api.post(`/api/v1/debit-notes/${dn}/issue`, {}), 200, 'issue debit note');
  check(await api.post(`/api/v1/debit-notes/${dn}/allocations`, { billId: b6, amountCents: 3_300, allocationDate: on(2, 3, 2) }), 201, 'apply debit note');
  await pay(packaging, b6, 7_700, on(2, 3, 5));

  // Flour and cleaning go through a pay run, when bank details can be stored.
  const bankDetails = await api.put(`/api/v1/pay-runs/bank-accounts/${account('1110')}`, {
    bsb: '062-000',
    accountNumber: '12345678',
    accountName: 'Wattle & Ash Bakehouse',
    financialInstitution: 'CBA',
    apcaUserId: '123456',
  });
  if (bankDetails.status === 200) {
    check(await api.put(`/api/v1/pay-runs/vendor-details/${flourMill}`, { bsb: '083-004', accountNumber: '111222333', accountName: 'Flour Mill Co' }), 200, 'vendor bank');
    check(await api.put(`/api/v1/pay-runs/vendor-details/${sunrise}`, { bsb: '033-000', accountNumber: '444555666', accountName: 'Sunrise Cleaning' }), 200, 'vendor bank');
    const run = await api.post('/api/v1/pay-runs', {
      bankAccountId: account('1110'),
      paymentDate: on(2, 2, 15),
      description: 'Suppliers',
      items: [
        { billId: b5, amountCents: 70_000 },
        { billId: b7, amountCents: 22_000 },
      ],
    });
    check(run, 201, 'pay run');
  } else {
    await pay(flourMill, b5, 70_000, on(2, 2, 15));
    await pay(sunrise, b7, 22_000, on(2, 2, 15));
  }

  const rule = await api.post('/api/v1/bank-rules', {
    name: 'Fuel',
    memoContains: 'FUEL',
    targetAccountId: account('6300'),
    taxCode: 'P_GST',
  });
  check(rule, 201, 'bank rule');

  await wages(on(2, 3, 28), 330_000, 50_000);
  const q2Lines = await statement([
    [on(2, 3, 10), 'Counter sale', 5_500],
    [on(2, 3, 12), 'FUEL STOP', -6_600],
    [on(2, 3, 28), 'Wages paid again', -280_000],
  ]);
  await postLine(q2Lines.get('Counter sale'), '4100', 'S_GST');
  await postLine(q2Lines.get('Wages paid again'), '2120', null);

  const q2Id = await newBas(on(2, 1, 1), 330_000, 50_000, 20_000);
  return { q1Id, q2Id, q1Start: on(1, 1, 1), q2Start: on(2, 1, 1) };
}
