import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiUsagePage from '../Pages/settings/AiUsagePage';
import type { AiUsageSummary } from '../services/fetchServices';

/** AP-Flow's AI usage report (Phase 19.1). */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function summary(overrides: Partial<AiUsageSummary> = {}): AiUsageSummary {
  return {
    totals: {
      callCount: 0,
      okCount: 0,
      errorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicroUsd: 0,
      unpricedCallCount: 0,
    },
    byModel: [],
    byApp: [],
    byPurpose: [],
    byDay: [],
    pricingVersion: '2026-06-24',
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

function mockUsage(body: unknown, status = 200) {
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(status, body)));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/ai-usage']}>
      <Routes>
        <Route path="/settings/ai-usage" element={<AiUsagePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AiUsagePage', () => {
  it('renders totals and a formatted cost', async () => {
    mockUsage({
      success: true,
      usage: summary({
        totals: {
          callCount: 3,
          okCount: 3,
          errorCount: 0,
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          costMicroUsd: 23_400,
          unpricedCallCount: 0,
        },
      }),
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('$0.0234')).toBeInTheDocument();
    });
  });

  it('warns when some calls are unpriced', async () => {
    mockUsage({
      success: true,
      usage: summary({
        totals: {
          callCount: 3,
          okCount: 3,
          errorCount: 0,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          costMicroUsd: 100,
          unpricedCallCount: 2,
        },
      }),
    });

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(/2 call\(s\) from a model with no published price/),
      ).toBeInTheDocument();
    });
  });

  it('does not warn when every call is priced', async () => {
    mockUsage({
      success: true,
      usage: summary({
        totals: {
          callCount: 1,
          okCount: 1,
          errorCount: 0,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          costMicroUsd: 100,
          unpricedCallCount: 0,
        },
      }),
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('$0.0001')).toBeInTheDocument();
    });
    expect(screen.queryByText(/no published price/)).not.toBeInTheDocument();
  });

  it('renders a row per model', async () => {
    mockUsage({
      success: true,
      usage: summary({
        totals: {
          callCount: 2,
          okCount: 2,
          errorCount: 0,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          costMicroUsd: 100,
          unpricedCallCount: 0,
        },
        byModel: [
          {
            key: 'claude-sonnet-5',
            provider: 'anthropic',
            callCount: 1,
            okCount: 1,
            errorCount: 0,
            inputTokens: 50,
            outputTokens: 10,
            totalTokens: 60,
            costMicroUsd: 50,
            unpricedCallCount: 0,
          },
          {
            key: 'gemini-3.6-flash',
            provider: 'gemini',
            callCount: 1,
            okCount: 1,
            errorCount: 0,
            inputTokens: 50,
            outputTokens: 10,
            totalTokens: 60,
            costMicroUsd: 0,
            unpricedCallCount: 1,
          },
        ],
      }),
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument();
      expect(screen.getByText('gemini-3.6-flash')).toBeInTheDocument();
    });
  });

  it('shows the empty state when nothing has been recorded', async () => {
    mockUsage({ success: true, usage: summary() });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No model calls recorded yet.')).toBeInTheDocument();
    });
  });

  it('shows an error message when the request fails', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument();
    });
  });
});
