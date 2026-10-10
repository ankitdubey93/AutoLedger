import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailTemplatesPage from '../Pages/settings/EmailTemplatesPage';
import StatementsListPage from '../Pages/statements/StatementsListPage';
import PublicStatementPage from '../Pages/public/PublicStatementPage';
import { sampleStatement } from '../Pages/statements/sampleStatement';
import type { PublicStatementView, StatementEmailTemplate } from '../services/fetchServices';

/**
 * Statement emails and the public statement link (Phase 39b).
 */

vi.mock('../context/AuthContext', () => ({ useCan: () => () => true }));
vi.mock('../context/OrgContext', () => ({
  useOrg: () => ({ organization: { id: 'o1', name: 'Acme Ltd', slug: 'acme', baseCurrency: 'USD' } }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(routes: Record<string, { status: number; body: unknown } | ((init?: RequestInit) => { status: number; body: unknown })>) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    for (const [fragment, response] of Object.entries(routes)) {
      const [m, f] = fragment.includes(' ') ? fragment.split(' ') : ['GET', fragment];
      if (method === m && f !== undefined && url.includes(f)) {
        const r = typeof response === 'function' ? response(init) : response;
        return Promise.resolve(jsonResponse(r.status, r.body));
      }
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${method} ${url}` }));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BUILT_IN: StatementEmailTemplate = {
  id: null,
  partyKind: 'CUSTOMER',
  name: 'Standard statement',
  subject: 'Statement from {{organization_name}}',
  body: 'Hi {{contact_name}},\n\nBalance due: {{balance_due}}',
  isDefault: true,
  builtIn: true,
  updatedAt: null,
};

describe('EmailTemplatesPage', () => {
  it('previews the built-in with sample values; a copy is editable, chips insert placeholders, unknown ones block save', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/settings/statement-email-templates?kind=CUSTOMER': { status: 200, body: { success: true, templates: [BUILT_IN] } },
    });
    render(
      <MemoryRouter>
        <EmailTemplatesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('preview-subject')).toHaveTextContent('Statement from Acme Ltd');
    expect(screen.getByTestId('preview-body')).toHaveTextContent('Balance due: USD 3,300.00');
    expect(screen.getByLabelText('Subject')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Customize a copy' }));
    const subject = screen.getByLabelText('Subject');
    expect(subject).toBeEnabled();
    await user.clear(subject);
    await user.type(subject, 'Overdue: ');
    await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
    await user.click(screen.getByRole('menuitem', { name: /^Overdue Amount/ }));
    expect(subject).toHaveValue('Overdue: [Overdue Amount]');
    expect(screen.getByTestId('preview-subject')).toHaveTextContent('Overdue: USD 1,450.00');

    await user.type(subject, ' {{{{nope}}');
    expect(screen.getByText('Unknown placeholder: {{nope}}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save template' })).toBeDisabled();
  });

  it('offers to convert a legacy {{name}} template, and hints at mistyped brackets without blocking', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/settings/statement-email-templates?kind=CUSTOMER': { status: 200, body: { success: true, templates: [BUILT_IN] } },
    });
    render(
      <MemoryRouter>
        <EmailTemplatesPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Customize a copy' }));
    await user.click(screen.getByRole('button', { name: 'Convert to [Name] placeholders' }));
    expect(screen.getByLabelText('Subject')).toHaveValue('Statement from [Organisation Name]');
    expect(screen.getByLabelText('Message')).toHaveValue('Hi [Contact Name],\n\nBalance due: [Balance Due]');
    expect(screen.queryByRole('button', { name: 'Convert to [Name] placeholders' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Subject'), ' [[Balanse Due]');
    expect(screen.getByText('[Balanse Due] — did you mean [Balance Due]?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save template' })).toBeEnabled();
  });
});

describe('Email statements from the list', () => {
  it('sends the selected parties with the default template and reports who was skipped', async () => {
    const user = userEvent.setup();
    let sentBody: unknown = null;
    mockRoutes({
      '/statements/customers?': {
        status: 200,
        body: {
          success: true,
          asOf: '2026-07-10',
          count: 2,
          parties: [
            { partyId: 'c1', name: 'Northwind', email: 'ap@nw.test', isActive: true, outstandingCents: 100, overdueCents: 0, lastSentAt: null },
            { partyId: 'c2', name: 'No Mail Co', email: null, isActive: true, outstandingCents: 50, overdueCents: 0, lastSentAt: null },
          ],
        },
      },
      '/settings/statement-email-templates': { status: 200, body: { success: true, templates: [BUILT_IN] } },
      'POST /statements/customers/preview-email': {
        status: 200,
        body: { success: true, preview: { toEmail: 'ap@nw.test', subject: 'Statement from Acme Ltd', body: 'Hi Northwind' } },
      },
      'POST /statements/customers/send': (init) => {
        sentBody = JSON.parse(String(init?.body));
        return {
          status: 201,
          body: { success: true, sent: [{ partyId: 'c1', sendId: 's1', toEmail: 'ap@nw.test' }], skipped: [{ partyId: 'c2', name: 'No Mail Co', reason: 'NO_EMAIL' }] },
        };
      },
    });
    render(
      <MemoryRouter initialEntries={['/statements/customers?asOf=2026-07-10']}>
        <Routes>
          <Route path="/statements/customers" element={<StatementsListPage kind="CUSTOMER" />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('checkbox', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: /Email \(2\)/ }));
    expect(await screen.findByText('Statement from Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText(/1 without an email will be skipped/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('1 statement queued to send.')).toBeInTheDocument();
    expect(screen.getByText('Skipped — no email address: No Mail Co')).toBeInTheDocument();
    expect(sentBody).toEqual({
      type: 'OUTSTANDING',
      asOf: '2026-07-10',
      partyIds: ['c1', 'c2'],
      templateId: null,
      toEmail: null,
    });
  });
});

function publicView(overrides: Partial<PublicStatementView> = {}): PublicStatementView {
  const statement = sampleStatement('OUTSTANDING');
  return {
    merchant: { name: 'Acme Ltd', addressLines: [], hasLogo: false, baseCurrency: 'USD' },
    partyKind: 'CUSTOMER',
    partyName: 'Northwind Traders',
    statement,
    current: {
      party: { kind: 'CUSTOMER', id: 'c1', name: 'Northwind Traders' },
      asOf: '2026-09-30',
      outstandingCents: statement.outstandingCents,
      overdueCents: statement.overdueCents,
      items: statement.openItems,
    },
    settings: {
      templateId: 'classic',
      documentTitle: 'STATEMENT',
      defaultType: 'OUTSTANDING',
      showLogo: true,
      showOrgAddress: true,
      showAgingSummary: true,
      showRemittance: true,
      footerNotes: null,
      accentColor: '#2563eb',
      configured: true,
    },
    bankDetails: 'Pay to BSB 000-000',
    payment: { enabled: false, publishableKey: null },
    expiresAt: '2026-12-01T00:00:00Z',
    ...overrides,
  };
}

function renderPublic(path: string, renderPayPanel?: Parameters<typeof PublicStatementPage>[0]['renderPayPanel']) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/statement/:token" element={<PublicStatementPage {...(renderPayPanel ? { renderPayPanel } : {})} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PublicStatementPage', () => {
  it('shows the merchant, balance and overdue, flags overdue invoices; without payment it shows how to pay', async () => {
    mockRoutes({ '/public/statements/tok-123': { status: 200, body: { success: true, ...publicView() } } });
    renderPublic('/statement/tok-123');

    expect(await screen.findByRole('heading', { name: 'Hi Northwind Traders' })).toBeInTheDocument();
    expect(screen.getByTestId('balance-due')).toHaveTextContent('3,300.00 USD');
    expect(screen.getByTestId('overdue')).toHaveTextContent('1,450.00 USD');
    expect(screen.getByText('Overdue 13 days')).toBeInTheDocument();
    expect(screen.getByText("Online payment isn't available for this account.")).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/public/statements/tok-123'));
    expect((call?.[1] as RequestInit).credentials).toBe('omit');
  });

  it('with payment enabled, overdue invoices are pre-selected and handed to the pay panel', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/public/statements/tok-123': {
        status: 200,
        body: { success: true, ...publicView({ payment: { enabled: true, publishableKey: 'pk_test_x' } }) },
      },
    });
    const panel = vi.fn((props: { totalCents: number; selected: unknown[]; currency: string | null }) => (
      <p data-testid="panel">{`${String(props.selected.length)}:${String(props.totalCents)}:${props.currency ?? '-'}`}</p>
    ));
    renderPublic('/statement/tok-123', panel);

    expect(await screen.findByTestId('panel')).toHaveTextContent('1:145000:USD');
    await user.click(screen.getByRole('checkbox', { name: 'Pay INV-000110' }));
    await waitFor(() => expect(screen.getByTestId('panel')).toHaveTextContent('2:330000:USD'));
  });

  it('an invalid or expired link says so', async () => {
    mockRoutes({ '/public/statements/bad': { status: 404, body: { success: false, error: 'nope' } } });
    renderPublic('/statement/bad');
    expect(await screen.findByText(/not valid or has expired/)).toBeInTheDocument();
  });
});
