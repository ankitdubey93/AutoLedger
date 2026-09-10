import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FxExposurePage from '../Pages/ledger-core/FxExposurePage';
import type { FxExposureReport } from '../services/fetchServices';

/** FxExposurePage — Phase 8. "Post revaluation" is gated by ConfirmDialog, matching every other irreversible action in this app (FiscalPeriodsPage's Lock). */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const openExposure: FxExposureReport = {
  asOfDate: '2026-01-31',
  baseCurrency: 'INR',
  documents: [
    {
      documentType: 'INVOICE',
      documentId: 'inv-1',
      documentNumber: 'INV-000001',
      counterpartyName: 'Acme Global',
      currencyCode: 'USD',
      outstandingCents: 100000,
      documentRate: '83.00000000',
      revaluationRate: '84.00000000',
      carryingBaseCents: 8300000,
      revaluedBaseCents: 8400000,
      deltaCents: 100000,
    },
  ],
  byCurrency: [
    { currencyCode: 'USD', outstandingCents: 100000, carryingBaseCents: 8300000, revaluedBaseCents: 8400000, deltaCents: 100000 },
  ],
  totalDeltaCents: 100000,
  alreadyRevalued: false,
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockExposureRoutes(exposure: FxExposureReport) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/fx-revaluations')) {
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          revaluation: {
            id: 'reval-1',
            asOfDate: exposure.asOfDate,
            journalEntryId: 'entry-1',
            reversalJournalEntryId: 'entry-2',
            totalDeltaCents: exposure.totalDeltaCents,
            lineCount: exposure.documents.length,
            createdBy: 'u1',
            createdAt: new Date().toISOString(),
            lines: [],
          },
        }),
      );
    }
    if (url.includes('/ledger-core/reports/fx-exposure')) {
      return Promise.resolve(jsonResponse(200, { success: true, exposure }));
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

function renderFxExposurePage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/fx-exposure']}>
      <Routes>
        <Route path="/app/:appSlug/fx-exposure" element={<FxExposurePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FxExposurePage', () => {
  it('posting a revaluation requires confirmation before calling the API', async () => {
    mockExposureRoutes(openExposure);
    const user = userEvent.setup();
    renderFxExposurePage();

    const postButton = await screen.findByRole('button', { name: 'Post revaluation' });
    await user.click(postButton);

    // The dialog is open; no POST has fired yet.
    const dialog = await screen.findByRole('dialog');
    expect(
      fetchMock.mock.calls.some((c) => {
        const [, init] = c as [RequestInfo | URL, RequestInit?];
        return init?.method === 'POST';
      }),
    ).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Post revaluation' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => {
          const [input, init] = c as [RequestInfo | URL, RequestInit?];
          const url = typeof input === 'string' ? input : input.toString();
          return init?.method === 'POST' && url.includes('/ledger-core/fx-revaluations');
        }),
      ).toBe(true);
    });
  });

  it('hides the post button when the date is already revalued', async () => {
    mockExposureRoutes({ ...openExposure, alreadyRevalued: true });
    renderFxExposurePage();

    await screen.findByText(/already been revalued/);
    expect(screen.queryByRole('button', { name: 'Post revaluation' })).not.toBeInTheDocument();
  });
});
