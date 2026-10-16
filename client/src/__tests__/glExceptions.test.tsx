import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import ExceptionReportPage from '../Pages/reports/ExceptionReportPage';

/** Phase 45 — the ledger exceptions page. fetch is stubbed by URL and method. */

let permissions: string[] = ['reports.view', 'reports.review_exceptions'];

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ status: 'authenticated', organization: { baseCurrency: 'USD' } }),
  useCan: () => (key: string) => permissions.includes(key),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const exception = {
  rule: 'UNUSUAL_AMOUNT',
  subjectType: 'LEDGER_LINE',
  subjectId: '11111111-1111-4111-8111-111111111111',
  entryDate: '2026-09-15',
  journalEntryId: '22222222-2222-4222-8222-222222222222',
  documentType: null,
  documentId: null,
  documentNumber: null,
  accountId: 'a1',
  accountCode: '6130',
  accountName: 'Office supplies',
  amountCents: 500000,
  currencyCode: 'USD',
  expected: 'Usually about 100.00 (debit)',
  actual: '5,000.00',
  reason: 'Modified z-score 99.0 against 10 lines in the prior 12 months (threshold 3.5)',
  review: null,
};

const report = {
  success: true,
  from: '2026-07-01',
  to: '2026-09-30',
  rules: ['UNUSUAL_AMOUNT', 'UNEXPECTED_SIDE', 'NON_DEFAULT_TAX', 'POSSIBLE_DUPLICATE'],
  includeReviewed: false,
  counts: {
    UNUSUAL_AMOUNT: { open: 1, reviewed: 0 },
    UNEXPECTED_SIDE: { open: 0, reviewed: 0 },
    NON_DEFAULT_TAX: { open: 0, reviewed: 0 },
    POSSIBLE_DUPLICATE: { open: 0, reviewed: 0 },
  },
  exceptions: [exception],
  truncated: false,
};

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  permissions = ['reports.view', 'reports.review_exceptions'];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/reports/exceptions/reviews') && init?.method === 'POST') {
      return Promise.resolve(
        jsonResponse(201, { success: true, review: { id: 'r1', note: 'ok', reviewedAt: '2026-10-01T00:00:00Z', reviewedByName: 'Alice' } }),
      );
    }
    if (url.includes('/reports/exceptions')) return Promise.resolve(jsonResponse(200, report));
    return Promise.resolve(jsonResponse(404, { success: false, error: 'not stubbed' }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ExceptionReportPage />
    </MemoryRouter>,
  );
}

describe('ExceptionReportPage', () => {
  it('lists exceptions with counts', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: 'Unusual amount (1)' })).toBeTruthy();
    expect(await screen.findByText(/Modified z-score 99\.0/)).toBeTruthy();
  });

  it('mark reviewed posts the note', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    await user.type(screen.getByLabelText('Note'), 'ok');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(
        ([url, init]) => String(url).includes('/reports/exceptions/reviews') && init?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(String(post?.[1]?.body)).toContain('"note":"ok"');
    });
    // The list is fetched again after saving.
    await waitFor(() => {
      const gets = fetchSpy.mock.calls.filter(
        ([url, init]) => String(url).includes('/reports/exceptions?') && init?.method !== 'POST',
      );
      expect(gets.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows no review button without the permission', async () => {
    permissions = ['reports.view'];
    renderPage();
    await screen.findByText(/Modified z-score 99\.0/);
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
  });
});
