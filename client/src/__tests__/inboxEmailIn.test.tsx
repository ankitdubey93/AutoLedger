import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InboxEmailInCard from '../Pages/inbox/InboxEmailInCard';

/**
 * Phase 43d — the "Email bills in" card on the bill inbox settings page.
 * The address comes from GET /integrations/inbound-mail; rotation is behind a
 * ConfirmDialog; a 404 (feature off) renders nothing.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ADDRESS = 'abcdefghijklmnop@inbound.example.com';
const ROTATED = 'qrstuvwxyz234567@inbound.example.com';

const EMPTY_MESSAGES = {
  success: true,
  messages: [],
  totalCount: 0,
  currentPage: 1,
  totalPages: 1,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Call AFTER userEvent.setup(): user-event installs its own clipboard stub on setup. */
function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

function mockRoutes(addressStatus: number = 200) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.endsWith('/api/v1/integrations/inbound-mail')) {
      if (addressStatus !== 200) {
        return Promise.resolve(jsonResponse(addressStatus, { success: false, error: 'Email-in is not enabled' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, address: ADDRESS, rotatedAt: null }));
    }
    if (method === 'POST' && url.endsWith('/api/v1/integrations/inbound-mail/rotate')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, address: ROTATED, rotatedAt: '2026-10-15T10:00:00.000Z' }),
      );
    }
    if (method === 'GET' && url.includes('/api/v1/integrations/inbound-mail/messages')) {
      return Promise.resolve(jsonResponse(200, EMPTY_MESSAGES));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: 'not mocked' }));
  });
}

function renderCard() {
  return render(
    <MemoryRouter>
      <InboxEmailInCard />
    </MemoryRouter>,
  );
}

describe('InboxEmailInCard', () => {
  it('renders the organization address under the "Email bills in" title', async () => {
    mockRoutes();
    renderCard();

    expect(screen.getByText('Email bills in')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    });
  });

  it('copy writes the address to the clipboard', async () => {
    const user = userEvent.setup();
    mockRoutes();
    renderCard();
    const writeText = mockClipboard();

    await waitFor(() => {
      expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(ADDRESS);
    });
  });

  it('generate new address confirms first, then calls the rotate endpoint', async () => {
    const user = userEvent.setup();
    mockRoutes();
    renderCard();

    await waitFor(() => {
      expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    });

    const rotateCallsBefore = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(rotateCallsBefore).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Generate new address' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('The current address will stop working.')).toBeInTheDocument();

    const rotateCallsAfterOpen = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(rotateCallsAfterOpen).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Generate new address' }));

    await waitFor(() => {
      expect(screen.getByText(ROTATED)).toBeInTheDocument();
    });
    const rotateCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(rotateCalls).toHaveLength(1);
    expect(String(rotateCalls[0]?.[0])).toContain('/api/v1/integrations/inbound-mail/rotate');
  });

  it('renders nothing when the feature is off (404)', async () => {
    mockRoutes(404);
    const { container } = renderCard();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });
});
