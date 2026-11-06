import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InvoiceDetailPage from '../Pages/sales/InvoiceDetailPage';
import InvoicesPage from '../Pages/sales/InvoicesPage';
import InvoiceSettingsPage from '../Pages/settings/InvoiceSettingsPage';
import MakeRecurringDialog from '../components/MakeRecurringDialog';
import PublicInvoicePage from '../Pages/public/PublicInvoicePage';
import { SAMPLE_INVOICE } from '../Pages/sales/sampleInvoice';
import type { Customer, Invoice, InvoiceSend, InvoiceSettings, PublicInvoiceView } from '../services/fetchServices';

/**
 * Phase 48 on the client: emailing an invoice (dialog, sent panel, list
 * badges), the recurring auto-send checkbox, the reminder settings, and the
 * public invoice page with its card panel. Stripe.js is mocked; the fetch
 * layer is a routed mock, as in the other client suites.
 */

const perms = vi.hoisted(() => ({ granted: new Set<string>() }));

vi.mock('../context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/AuthContext')>()),
  useCan: () => (permission: string) => perms.granted.has(permission),
}));
vi.mock('../context/OrgContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/OrgContext')>()),
  useOrg: () => ({ organization: { id: 'o1', name: 'Acme Ltd', slug: 'acme', baseCurrency: 'USD' } }),
  useOrganizationName: () => 'Acme Ltd',
}));
vi.mock('../context/LedgerSettingsContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/LedgerSettingsContext')>()),
  useLedgerSettings: () => ({ status: 'ready', settings: ledgerSettings }),
}));

const confirmPayment = vi.fn();
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: ReactNode }) => <div data-testid="elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment }),
  useElements: () => ({}),
}));

const ledgerSettings = {
  organizationName: 'Acme',
  legalName: 'Acme Inc.',
  baseCurrency: 'USD',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-01-01',
  industry: null,
  timezone: 'UTC',
  cashAccountId: null,
  onboardedAt: '2026-01-01T00:00:00.000Z',
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
};

type Reply = { status: number; body: unknown };
type Router = (method: string, url: string, init?: RequestInit) => Reply | undefined;

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Routes by method and URL; an unhandled call answers 404, as the other client suites do. */
function mockApi(route: Router) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const reply = route(method, url, init);
    if (reply === undefined) {
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${method} ${url}` }));
    }
    return Promise.resolve(jsonResponse(reply.status, reply.body));
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  confirmPayment.mockReset();
  perms.granted = new Set(['invoices.view', 'invoices.send']);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ----------------------------------------------------------------- fixtures

const customer: Customer = {
  id: 'cust-1',
  name: 'Northwind Traders',
  email: 'ap@northwind.test',
  phone: null,
  billingAddress: null,
  taxNumber: null,
  notes: null,
  defaultPaymentTermId: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    ...SAMPLE_INVOICE,
    id: 'inv-1',
    invoiceNumber: 'INV-000001',
    status: 'ISSUED',
    customerId: customer.id,
    customerName: customer.name,
    customerNameSnapshot: customer.name,
    lastSentAt: null,
    lastViewedAt: null,
    ...overrides,
  };
}

function send(overrides: Partial<InvoiceSend> = {}): InvoiceSend {
  return {
    id: 'send-1',
    invoiceId: 'inv-1',
    sendKind: 'MANUAL',
    toEmail: 'ap@northwind.test',
    sentByName: 'Alice',
    createdAt: '2026-10-01T09:00:00.000Z',
    expiresAt: '2026-11-30T09:00:00.000Z',
    revokedAt: null,
    lastViewedAt: null,
    deliveryStatus: 'SENT',
    ...overrides,
  };
}

function baseSettings(overrides: Partial<InvoiceSettings> = {}): InvoiceSettings {
  return {
    numberPrefix: 'INV-',
    numberPadding: 6,
    nextNumber: 1,
    defaultDueDays: 30,
    defaultTaxRateBp: 0,
    taxLabel: 'Tax',
    receivableAccountId: null,
    defaultRevenueAccountId: null,
    taxPayableAccountId: null,
    showTaxNumber: true,
    showBusinessNumber: true,
    showLegalName: true,
    billingAddress: null,
    paymentTerms: null,
    footerNotes: null,
    accentColor: '#0f172a',
    templateId: 'classic',
    documentTitle: 'INVOICE',
    fontFamily: 'sans',
    density: 'comfortable',
    showLogo: true,
    showOrgAddress: true,
    showPaymentTerms: true,
    showDueDate: true,
    remindersEnabled: false,
    reminderOffsetsDays: [7, 14, 30],
    bankDetails: null,
    quotePrefix: 'QU-',
    quoteNextNumber: 1,
    purchaseQuotePrefix: 'PQ-',
    purchaseQuoteNextNumber: 1,
    defaultQuoteValidityDays: 30,
    defaultQuoteTerms: null,
    quoteAcceptanceRequiresCode: false,
    customerDepositAccountId: null,
    supplierPrepaymentAccountId: null,
    configured: true,
    ...overrides,
  };
}

/** The staff detail page's routes, with the sends list supplied by the caller. */
function detailApi(inv: Invoice, sends: InvoiceSend[], extra?: Router): Router {
  return (method, url, init) => {
    const custom = extra?.(method, url, init);
    if (custom !== undefined) return custom;
    if (method === 'GET' && url.endsWith(`/invoices/${inv.id}`)) return { status: 200, body: { success: true, invoice: inv } };
    if (method === 'GET' && url.endsWith(`/invoices/${inv.id}/sends`)) return { status: 200, body: { success: true, sends } };
    if (method === 'GET' && url.endsWith('/settings/invoicing')) {
      return { status: 200, body: { success: true, invoiceSettings: baseSettings() } };
    }
    if (method === 'GET' && url.includes('/customers')) {
      return { status: 200, body: { success: true, count: 1, customers: [customer] } };
    }
    if (method === 'GET' && url.includes('/payments')) {
      return { status: 200, body: { success: true, count: 0, payments: [] } };
    }
    return undefined;
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/invoices/inv-1']}>
      <Routes>
        <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ----------------------------------------------------------- staff: sending

describe('emailing an invoice', () => {
  it('hides the Email button on a draft', async () => {
    mockApi(detailApi(invoice({ status: 'DRAFT', invoiceNumber: null }), []));
    renderDetail();
    await screen.findByRole('button', { name: /Download PDF/ });
    expect(screen.queryByRole('button', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('hides the Email button without invoices.send', async () => {
    perms.granted = new Set(['invoices.view']);
    mockApi(detailApi(invoice(), []));
    renderDetail();
    await screen.findByRole('button', { name: /Download PDF/ });
    expect(screen.queryByRole('button', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('prefills the address and posts toEmail and message', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    mockApi(
      detailApi(invoice(), [], (method, url, init) => {
        if (method === 'POST' && url.endsWith('/invoices/inv-1/send')) {
          posted = bodyOf(init);
          return { status: 201, body: { success: true, send: send() } };
        }
        return undefined;
      }),
    );
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Email invoice' });
    const to = within(dialog).getByLabelText('To');
    await waitFor(() => expect(to).toHaveValue('ap@northwind.test'));
    await user.type(within(dialog).getByLabelText('Message (optional)'), 'Thanks for your business');
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toEqual({ toEmail: 'ap@northwind.test', message: 'Thanks for your business' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Email invoice' })).not.toBeInTheDocument());
  });

  it('shows a server 422 inline and keeps the dialog open', async () => {
    const user = userEvent.setup();
    mockApi(
      detailApi(invoice(), [], (method, url) => {
        if (method === 'POST' && url.endsWith('/invoices/inv-1/send')) {
          return {
            status: 422,
            body: { success: false, error: 'This customer has no email address. Enter one to send the invoice' },
          };
        }
        return undefined;
      }),
    );
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Email invoice' });
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));

    expect(await within(dialog).findByText(/has no email address/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Email invoice' })).toBeInTheDocument();
  });

  it('lists sends: viewed date, not viewed, and failed', async () => {
    mockApi(
      detailApi(invoice(), [
        send({ id: 's1', toEmail: 'viewed@x.test', lastViewedAt: '2026-10-02T10:00:00.000Z' }),
        send({ id: 's2', toEmail: 'quiet@x.test' }),
        send({ id: 's3', toEmail: 'bounced@x.test', deliveryStatus: 'FAILED' }),
      ]),
    );
    renderDetail();

    const viewedRow = (await screen.findByText('viewed@x.test')).closest('tr');
    const quietRow = screen.getByText('quiet@x.test').closest('tr');
    const failedRow = screen.getByText('bounced@x.test').closest('tr');
    expect(viewedRow).not.toBeNull();
    expect(within(viewedRow as HTMLElement).getByText(/^Viewed /)).toBeInTheDocument();
    expect(within(quietRow as HTMLElement).getByText('Not viewed')).toBeInTheDocument();
    expect(within(failedRow as HTMLElement).getByText('Failed')).toBeInTheDocument();
  });
});

describe('the invoices list', () => {
  it('shows Viewed over Sent, and nothing when never sent', async () => {
    mockApi((method, url) => {
      if (method === 'GET' && url.includes('/invoices')) {
        return {
          status: 200,
          body: {
            success: true,
            count: 3,
            totalCount: 3,
            currentPage: 1,
            totalPages: 1,
            invoices: [
              invoice({
                id: 'a',
                invoiceNumber: 'INV-A',
                lastSentAt: '2026-10-01T00:00:00.000Z',
                lastViewedAt: '2026-10-02T00:00:00.000Z',
                settlementStatus: 'NOT_APPLICABLE',
              }),
              invoice({ id: 'b', invoiceNumber: 'INV-B', lastSentAt: '2026-10-01T00:00:00.000Z', settlementStatus: 'NOT_APPLICABLE' }),
              invoice({ id: 'c', invoiceNumber: 'INV-C', settlementStatus: 'NOT_APPLICABLE' }),
            ],
          },
        };
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/invoices']}>
        <InvoicesPage />
      </MemoryRouter>,
    );

    const rowA = (await screen.findByText('INV-A')).closest('tr') as HTMLElement;
    const rowB = screen.getByText('INV-B').closest('tr') as HTMLElement;
    const rowC = screen.getByText('INV-C').closest('tr') as HTMLElement;
    expect(within(rowA).getByText('Viewed')).toBeInTheDocument();
    expect(within(rowA).queryByText('Sent')).not.toBeInTheDocument();
    expect(within(rowB).getByText('Sent')).toBeInTheDocument();
    expect(within(rowC).queryByText('Sent')).not.toBeInTheDocument();
    expect(within(rowC).queryByText('Viewed')).not.toBeInTheDocument();
  });
});

// -------------------------------------------------- recurring + settings

describe('recurring auto-send checkbox', () => {
  const label = 'Email each invoice to the customer';

  function renderDialog(kind: 'INVOICE' | 'BILL') {
    return render(
      <MakeRecurringDialog kind={kind} sourceId="src-1" defaultName="Monthly" onClose={vi.fn()} onCreated={vi.fn()} />,
    );
  }

  it('appears only for an invoice that is posted, and resets when changed back to draft', async () => {
    const user = userEvent.setup();
    renderDialog('INVOICE');
    expect(screen.queryByLabelText(label)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Mode'), 'POST');
    const box = screen.getByLabelText(label);
    await user.click(box);
    expect(box).toBeChecked();

    await user.selectOptions(screen.getByLabelText('Mode'), 'DRAFT');
    expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Mode'), 'POST');
    expect(screen.getByLabelText(label)).not.toBeChecked();
  });

  it('is not offered for a bill', async () => {
    const user = userEvent.setup();
    renderDialog('BILL');
    await user.selectOptions(screen.getByLabelText('Mode'), 'POST');
    expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  });

  it('sends autoSend true with the schedule', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    mockApi((method, url, init) => {
      if (method === 'POST' && url.endsWith('/recurring-schedules')) {
        posted = bodyOf(init);
        return { status: 201, body: { success: true, schedule: { id: 'sched-1' } } };
      }
      return undefined;
    });
    renderDialog('INVOICE');
    await user.selectOptions(screen.getByLabelText('Mode'), 'POST');
    await user.click(screen.getByLabelText(label));
    await user.click(screen.getByRole('button', { name: /create schedule/i }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ kind: 'INVOICE', mode: 'POST', autoSend: true });
  });
});

describe('reminder settings', () => {
  it('turns "14, 7" into [14, 7] and saves the toggle', async () => {
    const user = userEvent.setup();
    let patched: Record<string, unknown> | null = null;
    mockApi((method, url, init) => {
      if (method === 'PATCH' && url.endsWith('/settings/invoicing')) {
        patched = bodyOf(init);
        return { status: 200, body: { success: true, invoiceSettings: { ...baseSettings(), ...patched } } };
      }
      if (method === 'GET' && url.endsWith('/settings/invoicing')) {
        return { status: 200, body: { success: true, invoiceSettings: baseSettings() } };
      }
      if (method === 'GET' && url.endsWith('/accounts')) {
        return { status: 200, body: { success: true, count: 0, accounts: [] } };
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/settings/invoicing']}>
        <InvoiceSettingsPage />
      </MemoryRouter>,
    );

    const days = await screen.findByLabelText(/Reminder days/);
    await waitFor(() => expect(days).toHaveValue('7, 14, 30'));
    await user.clear(days);
    await user.type(days, '14, 7');
    await user.click(screen.getByLabelText(/Email payment reminders/));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toMatchObject({ remindersEnabled: true, reminderOffsetsDays: [14, 7] });
  });

  it('shows the server validation message', async () => {
    const user = userEvent.setup();
    mockApi((method, url) => {
      if (method === 'PATCH' && url.endsWith('/settings/invoicing')) {
        return { status: 400, body: { success: false, error: 'Reminder days must be different from each other' } };
      }
      if (method === 'GET' && url.endsWith('/settings/invoicing')) {
        return { status: 200, body: { success: true, invoiceSettings: baseSettings() } };
      }
      if (method === 'GET' && url.endsWith('/accounts')) {
        return { status: 200, body: { success: true, count: 0, accounts: [] } };
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/settings/invoicing']}>
        <InvoiceSettingsPage />
      </MemoryRouter>,
    );
    await screen.findByLabelText(/Reminder days/);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Reminder days must be different from each other')).toBeInTheDocument();
  });
});

// ------------------------------------------------------- public invoice page

function publicView(overrides: Partial<PublicInvoiceView['invoice']> = {}, payment?: PublicInvoiceView['payment']): PublicInvoiceView {
  return {
    merchant: { name: 'Acme Ltd', addressLines: ['1 Main Street'], hasLogo: false },
    invoice: {
      number: 'INV-000042',
      status: 'ISSUED',
      settlementStatus: 'PARTIALLY_PAID',
      issueDate: '2026-10-01',
      dueDate: '2026-10-31',
      currencyCode: 'USD',
      customerName: 'Northwind Traders',
      notes: null,
      paymentTerms: 'Net 30',
      lines: [{ description: 'Consulting hours', quantityMilli: 2000, unitPriceCents: 50000, taxRateBp: 1000, netCents: 100000 }],
      subtotalCents: 100000,
      taxCents: 10000,
      totalCents: 110000,
      paidCents: 10000,
      amountDueCents: 100000,
      ...overrides,
    },
    bankDetails: null,
    payment: payment ?? { enabled: true, publishableKey: 'pk_test_x' },
    expiresAt: '2026-12-01T00:00:00.000Z',
  };
}

function renderPublic(path = '/invoice/tok-123') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invoice/:token" element={<PublicInvoicePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function publicApi(view: PublicInvoiceView, extra?: Router): Router {
  return (method, url, init) => {
    const custom = extra?.(method, url, init);
    if (custom !== undefined) return custom;
    if (method === 'GET' && url.endsWith('/public/invoices/tok-123')) return { status: 200, body: { success: true, ...view } };
    return undefined;
  };
}

describe('PublicInvoicePage', () => {
  it('renders the totals and the card panel, paying the whole amount due', async () => {
    const user = userEvent.setup();
    mockApi(
      publicApi(publicView(), (method, url, init) => {
        if (method === 'POST' && url.endsWith('/public/invoices/tok-123/payments')) {
          expect(init?.body).toBeUndefined();
          return {
            status: 201,
            body: {
              success: true,
              payment: { onlinePaymentId: 'op1', clientSecret: 'pi_1_secret', publishableKey: 'pk_test_x', amountCents: 100000, currencyCode: 'USD' },
            },
          };
        }
        if (method === 'POST' && url.endsWith('/public/invoices/tok-123/payments/pi_1/confirm')) {
          return { status: 200, body: { success: true, status: 'RECORDED', paymentId: 'p1' } };
        }
        return undefined;
      }),
    );
    confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded' } });
    renderPublic();

    expect(await screen.findByText('Invoice INV-000042')).toBeInTheDocument();
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText('Consulting hours')).toBeInTheDocument();
    expect(screen.getByTestId('amount-due')).toHaveTextContent('1,000.00 USD');
    expect(screen.getByTestId('pay-total')).toHaveTextContent('1,000.00 USD');

    await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pay 1,000.00 USD' }));
    expect(await screen.findByText('Payment received — thank you.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/payments/pi_1/confirm'))).toBe(true);
  });

  it('settles a 3-D Secure return (?payment_intent=) on mount', async () => {
    let confirmed = false;
    mockApi(
      publicApi(publicView(), (method, url) => {
        if (method === 'POST' && url.endsWith('/public/invoices/tok-123/payments/pi_9/confirm')) {
          confirmed = true;
          return { status: 200, body: { success: true, status: 'RECORDED', paymentId: 'p1' } };
        }
        return undefined;
      }),
    );
    window.history.replaceState(null, '', '/invoice/tok-123?payment_intent=pi_9&redirect_status=succeeded');
    try {
      renderPublic();
      await waitFor(() => expect(confirmed).toBe(true));
      expect(window.location.search).toBe('');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('offers no card panel when online payment is off', async () => {
    mockApi(publicApi(publicView({}, { enabled: false, publishableKey: null })));
    renderPublic();
    expect(await screen.findByText('Invoice INV-000042')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).not.toBeInTheDocument();
    expect(screen.getByText(/Online payment isn't available/)).toBeInTheDocument();
  });

  it('shows a voided invoice with no pay panel', async () => {
    mockApi(publicApi(publicView({ status: 'VOID', amountDueCents: 0 })));
    renderPublic();
    expect(await screen.findByText('This invoice has been voided.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).not.toBeInTheDocument();
    expect(screen.queryByText('Paid in full. Thank you.')).not.toBeInTheDocument();
  });

  it('thanks the customer when paid in full', async () => {
    mockApi(publicApi(publicView({ settlementStatus: 'PAID', paidCents: 110000, amountDueCents: 0 })));
    renderPublic();
    expect(await screen.findByText('Paid in full. Thank you.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).not.toBeInTheDocument();
  });

  it('shows the invalid-link text on a 404', async () => {
    mockApi(() => ({ status: 404, body: { success: false, error: 'This invoice link is not valid or has expired' } }));
    renderPublic();
    expect(
      await screen.findByText('This invoice link is not valid or has expired. Please contact the sender for a new one.'),
    ).toBeInTheDocument();
  });
});
