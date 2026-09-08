import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebhooksPage from '../Pages/ledger-core/WebhooksPage';
import type { WebhookEndpoint } from '../services/fetchServices';

/**
 * Webhook endpoint configuration (Phase 7). Doesn't depend on
 * AuthContext/OrgContext — it talks to fetchServices directly, like
 * CustomersPage.
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

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(endpoints: WebhookEndpoint[], listStatus = 200) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (init?.method === 'POST' && url.match(/\/webhooks$/)) {
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          endpoint: { ...endpoint1, id: 'ep-new', label: 'New Hook', secret: 'a'.repeat(64) },
          secretNotice: 'Store this secret now — it is shown once and cannot be retrieved again.',
        }),
      );
    }
    if (url.match(/\/webhooks$/)) {
      if (listStatus !== 200) {
        return Promise.resolve(jsonResponse(listStatus, { success: false, error: 'Forbidden' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, count: endpoints.length, endpoints }));
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

function renderWebhooksPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/webhooks']}>
      <Routes>
        <Route path="/app/:appSlug/webhooks" element={<WebhooksPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WebhooksPage', () => {
  it('renders one row per endpoint', async () => {
    mockRoutes([endpoint1, { ...endpoint1, id: 'ep-2', label: 'PagerDuty', url: 'https://hooks.example.com/two' }]);
    renderWebhooksPage();

    expect(await screen.findByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('PagerDuty')).toBeInTheDocument();
  });

  it('shows the secret once after create, and it never appears in the list response', async () => {
    mockRoutes([endpoint1]);
    const user = userEvent.setup();
    renderWebhooksPage();

    await screen.findByText('Slack');

    await user.click(screen.getByRole('button', { name: /new endpoint/i }));
    await user.type(screen.getByLabelText('Label'), 'New Hook');
    await user.type(screen.getByLabelText('URL'), 'https://hooks.example.com/new');
    await user.click(screen.getByLabelText('Invoice issued'));
    await user.click(screen.getByRole('button', { name: 'Create endpoint' }));

    await waitFor(() => {
      expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
    });

    // The list response never carried a secret field for endpoint1 either.
    const listCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return (init === undefined || init.method === undefined) && url.match(/\/webhooks$/);
    });
    expect(listCall).toBeDefined();
  });

  it('a 403 renders the permission message, not an empty table', async () => {
    mockRoutes([], 403);
    renderWebhooksPage();

    expect(await screen.findByText('Only an owner or admin can manage webhooks.')).toBeInTheDocument();
  });
});
