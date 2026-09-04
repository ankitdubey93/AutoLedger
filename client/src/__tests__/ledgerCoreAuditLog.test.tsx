import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuditLogPage from '../Pages/ledger-core/AuditLogPage';
import type { AuditLogDetail, AuditLogEntry } from '../services/fetchServices';

/**
 * The audit trail page (Phase 5). No AuthContext/OrgContext dependency and
 * no client-side role gating (the Phase 3.7 ruling) — the page always
 * attempts the load, and a 403 from the server renders inline.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: '1',
    txid: '1000',
    appSlug: 'ledger-core',
    tableName: 'customers',
    rowId: 'row-1',
    operation: 'INSERT',
    changedKeys: null,
    actorUserId: 'user-1',
    actorName: 'Alice',
    actorEmail: 'alice@example.com',
    clientIp: '127.0.0.1',
    createdAt: '2026-09-04T10:00:00.000Z',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockListRoute(logs: AuditLogEntry[], status = 200) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.match(/\/audit-logs\/\d+$/)) {
      const id = url.split('/').pop();
      const log = logs.find((l) => l.id === id);
      const detail: AuditLogDetail = {
        ...(log ?? entry()),
        oldRow: { name: 'Old Name' },
        newRow: { name: 'New Name' },
      };
      return Promise.resolve(jsonResponse(200, { success: true, log: { ...detail, changedKeys: ['name'] } }));
    }

    if (url.includes('/audit-logs')) {
      if (status !== 200) {
        return Promise.resolve(jsonResponse(status, { success: false, error: 'Forbidden' }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: logs.length,
          totalCount: logs.length,
          currentPage: 1,
          totalPages: 1,
          logs,
        }),
      );
    }

    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuditLogPage', () => {
  it('renders the trail newest first', async () => {
    mockListRoute([
      entry({ id: '2', tableName: 'invoices', createdAt: '2026-09-04T11:00:00.000Z' }),
      entry({ id: '1', tableName: 'customers', createdAt: '2026-09-04T10:00:00.000Z' }),
    ]);
    render(<AuditLogPage />);

    const rows = await screen.findAllByRole('row');
    // rows[0] is the header row.
    expect(rows[1]).toHaveTextContent('invoices');
    expect(rows[2]).toHaveTextContent('customers');
  });

  it('renders an em dash when there are no changed keys', async () => {
    mockListRoute([entry({ changedKeys: null })]);
    render(<AuditLogPage />);

    await screen.findByText('customers');
    const row = screen.getByText('customers').closest('tr');
    expect(row).toHaveTextContent('—');
  });

  it('filtering by operation refetches with the parameter', async () => {
    mockListRoute([entry()]);
    const user = userEvent.setup();
    render(<AuditLogPage />);

    await screen.findByText('customers');

    const select = screen.getByLabelText('Operation');
    await user.selectOptions(select, 'DELETE');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input] = c as [RequestInfo | URL];
        const url = typeof input === 'string' ? input : input.toString();
        return url.includes('/audit-logs') && url.includes('operation=DELETE');
      });
      expect(call).toBeDefined();
    });
  });

  it('expanding a row fetches and shows the before/after diff', async () => {
    mockListRoute([entry({ id: '5' })]);
    const user = userEvent.setup();
    render(<AuditLogPage />);

    const row = await screen.findByText('customers');
    await user.click(row);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input] = c as [RequestInfo | URL];
        const url = typeof input === 'string' ? input : input.toString();
        return url.endsWith('/audit-logs/5');
      });
      expect(call).toBeDefined();
    });

    expect(await screen.findByText('"Old Name"')).toBeInTheDocument();
    expect(await screen.findByText('"New Name"')).toBeInTheDocument();
  });

  it('shows a permission message on 403', async () => {
    mockListRoute([], 403);
    render(<AuditLogPage />);

    expect(
      await screen.findByText('Only an owner or admin can view the audit trail.'),
    ).toBeInTheDocument();
  });
});
