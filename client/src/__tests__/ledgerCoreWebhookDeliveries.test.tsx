import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebhookDeliveriesPage from '../Pages/ledger-core/WebhookDeliveriesPage';
import type { WebhookDelivery, WebhookEndpoint } from '../services/fetchServices';

/**
 * The webhook delivery log (Phase 7) — retry is gated to FAILED rows only,
 * and every filter change refetches server-side rather than filtering the
 * page in place.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const endpoint1: WebhookEndpoint = {
  id: 'ep-1',
  url: 'https://hooks.example.com/one',
  label: 'Slack',
  eventTypes: ['invoice.issued'],
  isActive: true,
  createdBy: 'user-1',
  createdByName: 'Alice',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'del-1',
    endpointId: 'ep-1',
    endpointLabel: 'Slack',
    endpointUrl: 'https://hooks.example.com/one',
    eventId: '1',
    eventType: 'invoice.issued',
    status: 'DELIVERED',
    attemptCount: 1,
    lastStatusCode: 200,
    lastError: null,
    deliveredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(deliveries: WebhookDelivery[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.match(/\/webhooks$/)) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, endpoints: [endpoint1] }));
    }
    if (url.includes('/webhook-deliveries') && url.includes('status=FAILED')) {
      const failedOnly = deliveries.filter((d) => d.status === 'FAILED');
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: failedOnly.length,
          totalCount: failedOnly.length,
          currentPage: 1,
          totalPages: 1,
          deliveries: failedOnly,
        }),
      );
    }
    if (url.includes('/webhook-deliveries')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: deliveries.length,
          totalCount: deliveries.length,
          currentPage: 1,
          totalPages: 1,
          deliveries,
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/webhooks/deliveries']}>
      <Routes>
        <Route path="/app/:appSlug/webhooks/deliveries" element={<WebhookDeliveriesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WebhookDeliveriesPage', () => {
  it('shows Retry only on FAILED rows', async () => {
    mockRoutes([
      delivery({ id: 'del-delivered', status: 'DELIVERED' }),
      delivery({ id: 'del-failed', status: 'FAILED', lastStatusCode: 500, lastError: 'boom' }),
    ]);
    renderPage();

    await screen.findAllByText('Slack');
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBe(1);
    });
  });

  it('changing the status filter refetches with status in the query string', async () => {
    mockRoutes([delivery()]);
    renderPage();

    await screen.findByText('Delivered');

    const select = screen.getByLabelText('Status');
    (select as HTMLSelectElement).value = 'FAILED';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [RequestInfo | URL, RequestInit?];
      const url = typeof lastCall[0] === 'string' ? lastCall[0] : lastCall[0].toString();
      expect(url).toContain('status=FAILED');
    });
  });
});
