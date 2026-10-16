import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ManualJournalsPage from '../Pages/accounting/ManualJournalsPage';
import ManualJournalFormPage from '../Pages/accounting/ManualJournalFormPage';
import ManualJournalDetailPage from '../Pages/accounting/ManualJournalDetailPage';
import NewRepeatingJournalPage from '../Pages/accounting/NewRepeatingJournalPage';
import type {
  Account,
  ManualJournal,
  ManualJournalSummary,
  RecurringSchedule,
} from '../services/fetchServices';

/**
 * Phase 44 — the Manual journals list, form, detail and new-repeating pages.
 * They talk to fetchServices directly, so (as in journals.test.tsx) the tests
 * stub `fetch`. The detail page reads useCan(), so that one hook is stubbed to
 * grant every permission; the server re-checks each route regardless.
 */

vi.mock('../context/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context/AuthContext')>();
  return { ...actual, useCan: () => () => true };
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function account(id: string, code: string, name: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    code,
    name,
    type: 'Expense',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    bankAccountKind: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const rent = account('acc-6110', '6110', 'Rent');
const payable = account('acc-2150', '2150', 'Accruals', { type: 'Liability' });
const operatingCash = account('acc-1110', '1110', 'Operating Cash', { type: 'Asset', bankAccountKind: 'BANK' });

function summary(overrides: Partial<ManualJournalSummary> = {}): ManualJournalSummary {
  return {
    id: 'mj-1',
    status: 'DRAFT',
    origin: 'MANUAL',
    narration: 'Accrued rent',
    narrationTemplate: null,
    entryDate: '2026-09-30',
    journalEntryId: null,
    voidJournalEntryId: null,
    recurringScheduleId: null,
    templateScheduleId: null,
    postedAt: null,
    voidedAt: null,
    createdBy: 'u1',
    createdByName: 'Alice',
    createdAt: '2026-09-30T00:00:00Z',
    updatedAt: '2026-09-30T00:00:00Z',
    totalDebitCents: 120000,
    totalCreditCents: 120000,
    ...overrides,
  };
}

function journal(overrides: Partial<ManualJournal> = {}): ManualJournal {
  return {
    ...summary(),
    lines: [
      {
        id: 'l1',
        lineNumber: 1,
        accountId: rent.id,
        accountCode: rent.code,
        accountName: rent.name,
        description: null,
        debitCents: 120000,
        creditCents: 0,
      },
      {
        id: 'l2',
        lineNumber: 2,
        accountId: payable.id,
        accountCode: payable.code,
        accountName: payable.name,
        description: null,
        debitCents: 0,
        creditCents: 120000,
      },
    ],
    ...overrides,
  };
}

function schedule(overrides: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 'sched-1',
    kind: 'JOURNAL',
    name: 'Prepaid insurance release',
    sourceId: null,
    sourceManualJournalId: 'mj-t',
    frequency: 'MONTHLY',
    intervalCount: 1,
    startDate: '2026-10-01',
    endDate: null,
    nextRunDate: '2026-11-01',
    nextOccurrenceIndex: 1,
    mode: 'POST',
    autoReverse: false,
    status: 'ACTIVE',
    lastError: null,
    lastErrorAt: null,
    lastRunDate: null,
    createdBy: 'u1',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  } as RecurringSchedule;
}

let fetchMock: ReturnType<typeof vi.fn>;

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

function callsTo(pathPart: string, method: string): Array<{ url: string; body: Record<string, unknown> | null }> {
  return fetchMock.mock.calls
    .map((call) => call as [RequestInfo | URL, RequestInit?])
    .filter(([input, init]) => urlOf(input).includes(pathPart) && (init?.method ?? 'GET') === method)
    .map(([input, init]) => ({
      url: urlOf(input),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    }));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function LocationDisplay() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

/* ------------------------------------------------------------- list page */

function mockListRoutes(journals: ManualJournalSummary[], schedules: RecurringSchedule[] = []) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes('/api/v1/manual-journals')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: journals.length,
          totalCount: journals.length,
          currentPage: 1,
          totalPages: 1,
          counts: { all: 5, draft: 2, posted: 2, voided: 1 },
          journals,
        }),
      );
    }
    if (url.includes('/api/v1/recurring-schedules')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: schedules.length, schedules }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderList(initialEntry = '/manual-journals') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationDisplay />
      <Routes>
        <Route path="/manual-journals" element={<ManualJournalsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ManualJournalsPage', () => {
  it('tabs show counts and switching to Draft sets ?status=draft', async () => {
    mockListRoutes([summary()]);
    const user = userEvent.setup();
    renderList();

    expect(await screen.findByRole('tab', { name: 'All (5)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Draft (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Posted (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Voided (1)' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Draft (2)' }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/manual-journals?status=draft');
    });
    await waitFor(() => {
      expect(callsTo('/api/v1/manual-journals', 'GET').some((c) => c.url.includes('status=draft'))).toBe(true);
    });
  });

  it('a draft row links to /manual-journals/:id', async () => {
    mockListRoutes([summary({ id: 'mj-77', narration: 'Accrued rent' })]);
    renderList();

    const link = await screen.findByRole('link', { name: 'Accrued rent' });
    expect(link).toHaveAttribute('href', '/manual-journals/mj-77');
  });

  it('Repeating tab lists JOURNAL schedules with Active only checked by default', async () => {
    mockListRoutes([], [schedule()]);
    const user = userEvent.setup();
    renderList('/manual-journals?status=repeating');

    expect(await screen.findByText('Prepaid insurance release')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: 'Active only' });
    expect(checkbox).toBeChecked();

    const firstCall = callsTo('/api/v1/recurring-schedules', 'GET')[0];
    expect(firstCall?.url).toContain('kind=JOURNAL');
    expect(firstCall?.url).toContain('status=ACTIVE');

    await user.click(checkbox);
    await waitFor(() => {
      const calls = callsTo('/api/v1/recurring-schedules', 'GET');
      expect(calls.some((c) => c.url.includes('kind=JOURNAL') && !c.url.includes('status='))).toBe(true);
    });
  });
});

/* ------------------------------------------------------------- form page */

function mockFormRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (init?.method === 'POST' && url.endsWith('/api/v1/manual-journals')) {
      return Promise.resolve(
        jsonResponse(201, { success: true, journal: journal({ id: 'mj-new', status: 'POSTED' }) }),
      );
    }
    if (url.includes('/api/v1/accounts')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 3, accounts: [rent, payable, operatingCash] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderForm() {
  return render(
    <MemoryRouter initialEntries={['/manual-journals/new']}>
      <LocationDisplay />
      <Routes>
        <Route path="/manual-journals/new" element={<ManualJournalFormPage />} />
        <Route path="/manual-journals/:journalId" element={<span data-testid="detail-stub" />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillBalancedLines(user: ReturnType<typeof userEvent.setup>) {
  await screen.findAllByRole('option', { name: /6110/ });
  await user.selectOptions(screen.getByLabelText('Account for line 1'), rent.id);
  await user.type(screen.getByLabelText('Debit for line 1'), '1200.00');
  await user.selectOptions(screen.getByLabelText('Account for line 2'), payable.id);
  await user.type(screen.getByLabelText('Credit for line 2'), '1200.00');
}

describe('ManualJournalFormPage', () => {
  it('Post is disabled until balanced and a narration is entered', async () => {
    mockFormRoutes();
    const user = userEvent.setup();
    renderForm();

    const post = screen.getByRole('button', { name: 'Post' });
    expect(post).toBeDisabled();

    await fillBalancedLines(user);
    // Balanced, but no narration yet.
    expect(post).toBeDisabled();

    await user.type(screen.getByLabelText('Narration'), 'Accrued rent');
    expect(post).toBeEnabled();
  });

  it('Save draft is enabled with an unbalanced form', async () => {
    mockFormRoutes();
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Narration'), 'Half done');
    await screen.findAllByRole('option', { name: /6110/ });
    await user.type(screen.getByLabelText('Debit for line 1'), '50.00');

    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('the account picker omits accounts with bankAccountKind', async () => {
    mockFormRoutes();
    renderForm();

    await screen.findAllByRole('option', { name: /6110/ });
    const select = screen.getByLabelText('Account for line 1');
    expect(within(select).queryByRole('option', { name: /1110/ })).toBeNull();
    expect(within(select).getByRole('option', { name: /2150/ })).toBeInTheDocument();
  });

  it('Save & add another posts, clears narration and lines, keeps the date, and shows the posted message', async () => {
    mockFormRoutes();
    const user = userEvent.setup();
    renderForm();

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-30' } });
    await user.type(screen.getByLabelText('Narration'), 'Accrued rent');
    await fillBalancedLines(user);

    await user.click(screen.getByRole('button', { name: /save & add another/i }));

    await waitFor(() => {
      expect(screen.getByText(/Posted “Accrued rent”/)).toBeInTheDocument();
    });
    const posts = callsTo('/api/v1/manual-journals', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ action: 'post', narration: 'Accrued rent', entryDate: '2026-09-30' });

    expect(screen.getByLabelText('Narration')).toHaveValue('');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-30');
    expect(screen.getByLabelText('Account for line 1')).toHaveValue('');
    expect(screen.getByLabelText('Debit for line 1')).toHaveValue('');
    // Stayed on the form.
    expect(screen.getByTestId('location').textContent).toBe('/manual-journals/new');
  });
});

/* ----------------------------------------------------------- detail page */

function mockDetailRoute(j: ManualJournal) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (init?.method === 'POST' && url.endsWith(`/api/v1/manual-journals/${j.id}/void`)) {
      return Promise.resolve(jsonResponse(200, { success: true, journal: { ...j, status: 'VOIDED' } }));
    }
    if (url.endsWith(`/api/v1/manual-journals/${j.id}`)) {
      return Promise.resolve(jsonResponse(200, { success: true, journal: j }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderDetail(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/manual-journals/${id}`]}>
      <Routes>
        <Route path="/manual-journals/:journalId" element={<ManualJournalDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ManualJournalDetailPage', () => {
  it('DRAFT shows Edit/Post/Delete; POSTED shows Void/Copy; VOIDED shows View reversal', async () => {
    mockDetailRoute(journal({ status: 'DRAFT' }));
    const draft = renderDetail('mj-1');
    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
    draft.unmount();

    mockDetailRoute(journal({ status: 'POSTED', journalEntryId: 'je-1', postedAt: '2026-09-30T00:00:00Z' }));
    const posted = renderDetail('mj-1');
    expect(await screen.findByRole('button', { name: 'Void' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    posted.unmount();

    mockDetailRoute(
      journal({
        status: 'VOIDED',
        journalEntryId: 'je-1',
        voidJournalEntryId: 'je-2',
        postedAt: '2026-09-30T00:00:00Z',
        voidedAt: '2026-10-01T00:00:00Z',
      }),
    );
    renderDetail('mj-1');
    expect(await screen.findByRole('link', { name: 'View reversal' })).toHaveAttribute('href', '/journals/je-2');
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });

  it('voiding sends voidDate null when the date is left blank', async () => {
    mockDetailRoute(journal({ status: 'POSTED', journalEntryId: 'je-1', postedAt: '2026-09-30T00:00:00Z' }));
    const user = userEvent.setup();
    renderDetail('mj-1');

    await user.click(await screen.findByRole('button', { name: 'Void' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Void journal' }));

    await waitFor(() => {
      expect(callsTo('/manual-journals/mj-1/void', 'POST')).toHaveLength(1);
    });
    expect(callsTo('/manual-journals/mj-1/void', 'POST')[0]?.body).toEqual({ voidDate: null });
  });
});

/* ------------------------------------------------------ repeating journal */

describe('NewRepeatingJournalPage', () => {
  it('submits frequency, startDate, endDate null and autoReverse', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (init?.method === 'POST' && url.endsWith('/api/v1/manual-journals/repeating')) {
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            journal: journal({ id: 'mj-t', status: 'TEMPLATE' }),
            schedule: schedule({ id: 'sched-9' }),
          }),
        );
      }
      if (url.includes('/api/v1/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 2, accounts: [rent, payable] }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/manual-journals/repeating/new']}>
        <LocationDisplay />
        <Routes>
          <Route path="/manual-journals/repeating/new" element={<NewRepeatingJournalPage />} />
          <Route path="/recurring/:id" element={<span data-testid="recurring-stub" />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Name'), 'Prepaid insurance release');
    fireEvent.change(screen.getByLabelText('Narration'), { target: { value: 'Prepaid insurance [Month]' } });
    fireEvent.change(screen.getByLabelText('First date'), { target: { value: '2026-11-01' } });
    await user.click(screen.getByRole('checkbox', { name: /reverse on the 1st/i }));
    await fillBalancedLines(user);

    await user.click(screen.getByRole('button', { name: 'Save repeating journal' }));

    await waitFor(() => {
      expect(callsTo('/api/v1/manual-journals/repeating', 'POST')).toHaveLength(1);
    });
    expect(callsTo('/api/v1/manual-journals/repeating', 'POST')[0]?.body).toMatchObject({
      name: 'Prepaid insurance release',
      narration: 'Prepaid insurance [Month]',
      frequency: 'MONTHLY',
      intervalCount: 1,
      startDate: '2026-11-01',
      endDate: null,
      autoReverse: true,
    });
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/recurring/sched-9');
    });
  });
});
