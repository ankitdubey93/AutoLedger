import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import InvoiceDocument from '../Pages/sales/InvoiceDocument';
import InvoiceTemplatePage from '../Pages/settings/InvoiceTemplatePage';
import { SAMPLE_CUSTOMER_NAME, SAMPLE_INVOICE } from '../Pages/sales/sampleInvoice';
import * as fetchServices from '../services/fetchServices';
import type { InvoiceSettings, OrganizationProfile } from '../services/fetchServices';

/**
 * Invoice template editor and shared renderer (Phase 30, Step 15).
 *
 * The invariant under test: the editor's preview IS the real InvoiceDocument,
 * fed sample data and LOCAL unsaved state — so edits show instantly with no
 * request, and no request value ever reaches the DOM as markup.
 *
 * The harness and fixtures are copied from ledgerCoreInvoices.test.tsx and
 * ledgerCoreInvoiceDocument.test.tsx rather than imported from them.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const invoiceSettings: InvoiceSettings = {
  numberPrefix: 'INV-',
  numberPadding: 6,
  nextNumber: 1,
  defaultDueDays: 30,
  defaultTaxRateBp: 0,
  taxLabel: 'GST',
  receivableAccountId: null,
  defaultRevenueAccountId: null,
  taxPayableAccountId: null,
  showTaxNumber: true,
  showBusinessNumber: true,
  showLegalName: true,
  billingAddress: null,
  paymentTerms: null,
  footerNotes: null,
  accentColor: '#2563eb',
  templateId: 'classic',
  documentTitle: 'INVOICE',
  fontFamily: 'sans',
  density: 'comfortable',
  showLogo: true,
  showOrgAddress: true,
  showPaymentTerms: true,
  showDueDate: true,
  bankDetails: null,
  configured: true,
};

const profileFixture: OrganizationProfile = {
  legalName: 'Acme Holdings Pty Ltd',
  industry: null,
  streetAddress1: '1 Main Street',
  streetAddress2: null,
  city: 'Mumbai',
  region: null,
  postalCode: '400001',
  countryCode: 'IN',
  postalSameAsStreet: true,
  postalAddress1: null,
  postalAddress2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountryCode: null,
  phone: null,
  contactEmail: null,
  website: null,
  logoDocumentId: null,
  configured: true,
};

function makeSession() {
  return {
    success: true,
    user: {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      emailVerified: false,
      createdAt: new Date().toISOString(),
    },
    organization: {
      id: 'o1',
      name: 'Acme',
      slug: 'acme',
      baseCurrency: 'USD',
      taxNumber: 'TAX-123',
      businessNumber: 'BUS-456',
      createdAt: new Date().toISOString(),
    },
    role: 'OWNER',
    memberships: [
      { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER', joinedAt: new Date().toISOString() },
    ],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

// jsdom implements neither URL.createObjectURL nor revokeObjectURL, so both are stubbed
// onto URL directly and restored afterwards (same stub as useDocumentObjectUrl.test.tsx).
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let fetchMock: ReturnType<typeof vi.fn>;
let downloadSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:mock-logo') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  downloadSpy = vi.spyOn(fetchServices, 'downloadDocument').mockResolvedValue({
    blob: new Blob(['x'], { type: 'image/png' }),
    filename: 'logo.png',
  });
});

afterEach(() => {
  downloadSpy.mockRestore();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.unstubAllGlobals();
});

interface Scenario {
  settings?: Partial<InvoiceSettings>;
  /** `null` makes GET /organizations/profile answer 404. */
  profile?: Partial<OrganizationProfile> | null;
}

function callsMatching(predicate: (url: string, init: RequestInit | undefined) => boolean) {
  return fetchMock.mock.calls.filter((call) => {
    const [input, init] = call as [RequestInfo | URL, RequestInit?];
    const url = typeof input === 'string' ? input : input.toString();
    return predicate(url, init);
  });
}

function patchCalls() {
  return callsMatching((url, init) => init?.method === 'PATCH' && url.endsWith('/ledger-core/settings/invoicing'));
}

async function renderEditor(scenario: Scenario = {}) {
  const settings: InvoiceSettings = { ...invoiceSettings, ...scenario.settings };
  const profile = scenario.profile === null ? null : { ...profileFixture, ...scenario.profile };

  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, makeSession()));
    if (init?.method === 'PATCH' && url.endsWith('/ledger-core/settings/invoicing')) {
      const patch = JSON.parse(init.body as string) as Partial<InvoiceSettings>;
      return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings: { ...settings, ...patch } }));
    }
    if (url.endsWith('/ledger-core/settings/invoicing')) {
      return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings: settings }));
    }
    if (url.endsWith('/organizations/profile')) {
      return profile === null
        ? Promise.resolve(jsonResponse(404, { success: false, error: 'not found' }))
        : Promise.resolve(jsonResponse(200, { success: true, profile }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });

  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={['/settings/invoice-template']}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/settings/invoice-template" element={<InvoiceTemplatePage />} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );

  // Wait for every async input: the page skeleton gone (settings + profile landed) and the
  // organization (session) resolved — the org tax number only renders once useOrg() has it.
  await screen.findByRole('heading', { name: 'Invoice template' });
  await screen.findByText('Tax no. TAX-123');
  return { user, ...view };
}

function radio(name: string): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(name, 'i') });
}

describe('InvoiceTemplatePage — live preview', () => {
  it('shows the sample invoice number and customer in the preview', async () => {
    await renderEditor();
    expect(screen.getByText('INV-000042')).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_CUSTOMER_NAME)).toBeInTheDocument();
    expect(screen.getByText('INVOICE')).toBeInTheDocument();
  });

  it('takes the legal name from the profile', async () => {
    await renderEditor();
    expect(screen.getByText('Acme Holdings Pty Ltd')).toBeInTheDocument();
  });

  it('updates the preview from a document-title edit with no request', async () => {
    const { user } = await renderEditor();
    const before = fetchMock.mock.calls.length;

    const title = screen.getByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'TAX INVOICE');

    // The document title label is the only place the title renders in the document.
    expect(screen.getAllByText('TAX INVOICE').some((el) => el.tagName === 'P')).toBe(true);
    expect(screen.queryByText('INVOICE')).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('removes the org tax number from the preview when Show tax number is unchecked, with no request', async () => {
    const { user } = await renderEditor();
    const before = fetchMock.mock.calls.length;

    expect(screen.getByText('Tax no. TAX-123')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Tax registration number' }));

    expect(screen.queryByText('Tax no. TAX-123')).toBeNull();
    // Other disclosures are unaffected.
    expect(screen.getByText('Business no. BUS-456')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it.each(['classic', 'modern', 'compact'] as const)('renders the %s template with the sample invoice', async (id) => {
    const { user } = await renderEditor({ settings: { templateId: id === 'classic' ? 'modern' : 'classic' } });
    await user.click(radio(id));
    expect(radio(id)).toBeChecked();
    expect(screen.getByText('INV-000042')).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_CUSTOMER_NAME)).toBeInTheDocument();
  });

  it('renders bank details from the draft as text in the preview', async () => {
    const { user } = await renderEditor();
    await user.type(screen.getByLabelText('Bank details'), 'ACC 12345');
    expect(screen.getByText('Bank details', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('ACC 12345', { selector: 'p' })).toBeInTheDocument();
  });

  it('renders markup typed into bank details as text, never as an element', async () => {
    const { user, container } = await renderEditor();
    await user.type(screen.getByLabelText('Bank details'), '<img src=x onerror=alert(1)>');
    expect(screen.getByText('<img src=x onerror=alert(1)>', { selector: 'p' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('InvoiceTemplatePage — save and discard', () => {
  it('Save fires exactly one PATCH carrying only the fields this page owns', async () => {
    const { user } = await renderEditor();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(radio('modern'));
    const title = screen.getByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'TAX INVOICE');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const [, init] = patchCalls()[0] as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body.templateId).toBe('modern');
    expect(body.documentTitle).toBe('TAX INVOICE');
    expect(Object.keys(body).sort()).toEqual(
      [
        'templateId',
        'documentTitle',
        'fontFamily',
        'density',
        'accentColor',
        'showLogo',
        'showOrgAddress',
        'showLegalName',
        'showTaxNumber',
        'showBusinessNumber',
        'showPaymentTerms',
        'showDueDate',
        'bankDetails',
        'footerNotes',
      ].sort(),
    );
    for (const owned of ['numberPrefix', 'nextNumber', 'paymentTerms', 'receivableAccountId', 'defaultRevenueAccountId', 'taxPayableAccountId']) {
      expect(body).not.toHaveProperty(owned);
    }
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(patchCalls()).toHaveLength(1);
  });

  it('Discard changes reverts the preview to the loaded values', async () => {
    const { user } = await renderEditor();

    await user.click(radio('compact'));
    const title = screen.getByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'TAX INVOICE');
    await user.click(screen.getByRole('checkbox', { name: 'Tax registration number' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.queryByText('Tax no. TAX-123')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(screen.getByText('INVOICE')).toBeInTheDocument();
    expect(screen.queryByText('TAX INVOICE')).toBeNull();
    expect(screen.getByText('Tax no. TAX-123')).toBeInTheDocument();
    expect(radio('classic')).toBeChecked();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(patchCalls()).toHaveLength(0);
  });
});

describe('InvoiceTemplatePage — profile is optional decoration', () => {
  it('still renders the editor and the preview when the profile fetch 404s', async () => {
    const { container } = await renderEditor({ profile: null });
    expect(screen.getByRole('heading', { name: 'Invoice template' })).toBeInTheDocument();
    expect(screen.getByLabelText('Document title')).toBeInTheDocument();
    expect(screen.getByText('INV-000042')).toBeInTheDocument();
    // No profile: no legal name, no logo.
    expect(screen.queryByText('Acme Holdings Pty Ltd')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

describe('InvoiceTemplatePage — logo', () => {
  it('renders no <img> when the profile has no logo, even with showLogo true', async () => {
    const { container } = await renderEditor({ profile: { logoDocumentId: null }, settings: { showLogo: true } });
    expect(container.querySelector('img')).toBeNull();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('renders the logo <img> when one is set and Show logo is checked, and hides it when unchecked', async () => {
    const { user, container } = await renderEditor({
      profile: { logoDocumentId: 'doc-logo-1' },
      settings: { showLogo: true },
    });
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(downloadSpy).toHaveBeenCalledWith('doc-logo-1');
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:mock-logo');

    await user.click(screen.getByRole('checkbox', { name: 'Logo' }));
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders no <img> when showLogo is off even though the profile has a logo', async () => {
    const { container } = await renderEditor({
      profile: { logoDocumentId: 'doc-logo-1' },
      settings: { showLogo: false },
    });
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledWith('doc-logo-1'));
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('InvoiceDocument — escaping', () => {
  function renderDirect(settings: Partial<InvoiceSettings>) {
    return render(
      <InvoiceDocument
        invoice={SAMPLE_INVOICE}
        settings={{ ...invoiceSettings, ...settings }}
        profile={null}
        organizationName="Acme"
        taxNumber={null}
        businessNumber={null}
        legalName={null}
        baseCurrency="USD"
        logoSrc={null}
        preview
      />,
    );
  }

  it.each(['classic', 'modern', 'compact'] as const)('%s renders a script tag in footer notes as text', (templateId) => {
    const { container } = renderDirect({ templateId, footerNotes: '<script>alert(1)</script>' });
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders markup in bank details as text with no <img> from it', () => {
    const { container } = renderDirect({ bankDetails: '<img src=x onerror=alert(1)>' });
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
