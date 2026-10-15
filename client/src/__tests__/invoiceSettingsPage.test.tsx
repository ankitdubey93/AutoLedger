import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InvoiceSettingsPage from '../Pages/settings/InvoiceSettingsPage';
import type { InvoiceSettings } from '../services/fetchServices';

/**
 * Phase 42 Step A4 — the Quotes section of Settings → Invoices.
 * Fetch-mock and fixture setup copied from `settingsTabs.test.tsx`.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

function requestMethod(init?: RequestInit): string {
  return init?.method ?? 'GET';
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, urlPredicate: (url: string) => boolean): unknown[][] {
  return fetchMock.mock.calls.filter((call: unknown[]) => {
    const init = call[1] as RequestInit | undefined;
    return requestMethod(init) === method && urlPredicate(requestUrl(call[0] as RequestInfo | URL));
  });
}

function bodyOf(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

function baseInvoiceSettings(overrides: Partial<InvoiceSettings> = {}): InvoiceSettings {
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InvoiceSettingsPage', () => {
  it('saves the quote prefixes, validity and default terms', async () => {
    const invoiceSettings = baseInvoiceSettings();

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(init);

      if (url.endsWith('/api/v1/settings/invoicing') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings: { ...invoiceSettings, ...body } }));
      }
      if (url.endsWith('/api/v1/settings/invoicing')) {
        return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings }));
      }
      if (url.endsWith('/api/v1/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/invoicing']}>
        <InvoiceSettingsPage />
      </MemoryRouter>,
    );

    // Wait for the stored values to load into the form.
    const quotePrefix = await screen.findByLabelText('Sales quote prefix');
    await waitFor(() => expect(quotePrefix).toHaveValue('QU-'));

    const validity = screen.getByLabelText('Quotes are valid for (days)');

    await user.clear(quotePrefix);
    await user.type(quotePrefix, 'EST-');
    await user.clear(validity);
    await user.type(validity, '14');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(callsTo(fetchMock, 'PATCH', (url) => url.endsWith('/api/v1/settings/invoicing'))).toHaveLength(1),
    );
    const [call] = callsTo(fetchMock, 'PATCH', (url) => url.endsWith('/api/v1/settings/invoicing'));
    expect(bodyOf(call)).toMatchObject({ quotePrefix: 'EST-', defaultQuoteValidityDays: 14 });
  });
});
