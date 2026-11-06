import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayRunPage from '../Pages/banking/PayRunPage';
import { BANK_PRESETS, withPresetHeader } from '../Pages/banking/bankPresets';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const bill = { id: 'b1', vendorId: 'v1', vendorName: 'Coastal Supplies', vendorReference: 'INV-1', dueDate: '2026-08-31', amountDueCents: 12_345, currencyCode: 'AUD' };

let vendorDetails: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test/api/v1');
  vendorDetails = [];
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/pay-runs/bank-accounts/')) {
      return Promise.resolve(jsonResponse({ success: true, details: { accountId: 'a1', bsb: '062-000', accountNumberLast3: '678', accountName: 'X', financialInstitution: 'CBA', apcaUserId: '123456', selfBalancing: false } }));
    }
    if (url.includes('/pay-runs/vendor-details')) return Promise.resolve(jsonResponse({ success: true, details: vendorDetails }));
    if (url.includes('/pay-runs')) return Promise.resolve(jsonResponse({ success: true, batches: [] }));
    if (url.includes('/bills')) return Promise.resolve(jsonResponse({ success: true, count: 1, totalCount: 1, currentPage: 1, totalPages: 1, bills: [bill] }));
    if (url.includes('/accounts')) return Promise.resolve(jsonResponse({ success: true, accounts: [{ id: 'a1', code: '1110', name: 'Operating', bankAccountKind: 'BANK', isActive: true }] }));
    return Promise.resolve(jsonResponse({ success: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the pay run page', () => {
  it('asks for missing supplier bank details before it can pay', async () => {
    render(<PayRunPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Pay INV-1' }));
    expect(await screen.findByText(/Coastal Supplies: bank details needed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay 123.45 and download ABA/ })).toBeDisabled();
  });

  it('warns about recently changed bank details', async () => {
    vendorDetails = [{ vendorId: 'v1', bsb: '083-004', accountNumberLast3: '321', accountName: 'C', changedAt: new Date().toISOString() }];
    render(<PayRunPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Pay INV-1' }));
    expect(await screen.findByText(/common payment fraud/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay 123.45/ })).toBeEnabled());
  });

  it('says no money moves until the file is uploaded', async () => {
    vendorDetails = [{ vendorId: 'v1', bsb: '083-004', accountNumberLast3: '321', accountName: 'C', changedAt: '2020-01-01T00:00:00Z' }];
    render(<PayRunPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Pay INV-1' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay 123.45/ })).toBeEnabled());
    expect(screen.queryByText(/common payment fraud/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Pay 123.45/ }));
    expect(await screen.findByText(/No money moves until you upload/)).toBeInTheDocument();
  });
});

describe('bank presets', () => {
  const preset = (id: string) => BANK_PRESETS.find((b) => b.id === id) ?? null;

  it('adds a header to a headerless export', () => {
    expect(withPresetHeader('01/08/2026,-10.00,Coffee,100.00', preset('CBA'))).toBe('Date,Amount,Description,Balance\n01/08/2026,-10.00,Coffee,100.00');
  });

  it('leaves a file that already has a header, and any file with no headerless preset', () => {
    expect(withPresetHeader('Date,Amount,Description\n01/08/2026,-1,x', preset('ANZ'))).toBe('Date,Amount,Description\n01/08/2026,-1,x');
    expect(withPresetHeader('a,b', preset('NAB'))).toBe('a,b');
    expect(withPresetHeader('a,b', null)).toBe('a,b');
  });
});
