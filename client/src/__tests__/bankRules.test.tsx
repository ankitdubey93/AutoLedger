import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BankRulesPage from '../Pages/banking/BankRulesPage';
import * as fetchServices from '../services/fetchServices';
import type { BankRule, Account } from '../services/fetchServices';

vi.mock('../services/fetchServices');

const mockAccounts: Account[] = [
  {
    id: 'acc-1110',
    code: '1110',
    name: 'Operating Cash',
    type: 'Asset',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'acc-6600',
    code: '6600',
    name: 'Bank Fees',
    type: 'Expense',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const mockRules: BankRule[] = [
  {
    id: 'rule-1',
    name: 'Service Charges',
    priority: 100,
    direction: 'OUT',
    memoContains: 'SERVICE CHARGE',
    amountMinCents: null,
    amountMaxCents: null,
    bankAccountId: null,
    targetAccountId: 'acc-6600',
    targetAccountCode: '6600',
    targetAccountName: 'Bank Fees',
    description: null,
    isActive: true,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

beforeEach(() => {
  vi.mocked(fetchServices.listBankRules).mockResolvedValue({
    success: true,
    count: 1,
    bankRules: mockRules,
  });
  vi.mocked(fetchServices.listAccounts).mockResolvedValue({
    success: true,
    count: mockAccounts.length,
    accounts: mockAccounts,
  });
  vi.mocked(fetchServices.createBankRule).mockResolvedValue({
    success: true,
    bankRule: mockRules[0]!,
  });
  vi.mocked(fetchServices.updateBankRule).mockResolvedValue({
    success: true,
    bankRule: mockRules[0]!,
  });
  vi.mocked(fetchServices.applyBankRules).mockResolvedValue({
    success: true,
    appliedCount: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

it('lists rules with their target account', async () => {
  render(
    <MemoryRouter>
      <BankRulesPage />
    </MemoryRouter>,
  );

  await waitFor(() => {
    expect(screen.getByText('Service Charges')).toBeInTheDocument();
    expect(screen.getByText('6600 Bank Fees')).toBeInTheDocument();
  });
});

it('creating a rule posts the form body to /bank-rules', async () => {
  render(
    <MemoryRouter>
      <BankRulesPage />
    </MemoryRouter>,
  );

  await waitFor(() => {
    expect(screen.getByText('New rule')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByText('New rule'));

  const nameInput = screen.getByPlaceholderText('Rule name') as HTMLInputElement;
  const memoInput = screen.getByPlaceholderText('Text to match') as HTMLInputElement;
  const targetSelect = screen.getAllByDisplayValue('Select an account…')[0] as HTMLSelectElement;

  fireEvent.change(nameInput, { target: { value: 'Test Rule' } });
  fireEvent.change(memoInput, { target: { value: 'TEST' } });
  fireEvent.change(targetSelect, { target: { value: 'acc-6600' } });

  fireEvent.click(screen.getByText('Create rule'));

  await waitFor(() => {
    expect(vi.mocked(fetchServices.createBankRule)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Rule',
        memoContains: 'TEST',
        targetAccountId: 'acc-6600',
      }),
    );
  });
});

it('query string prefills memo, account and direction', async () => {
  render(
    <MemoryRouter initialEntries={['/bank/rules?memo=FEE&account=acc-6600&direction=OUT']}>
      <BankRulesPage />
    </MemoryRouter>,
  );

  await waitFor(() => {
    expect(screen.getByText('New rule')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByText('New rule'));

  const memoInput = screen.getByPlaceholderText('Text to match') as HTMLInputElement;
  const directionSelect = screen.getByDisplayValue('Out') as HTMLSelectElement;

  expect(memoInput.value).toBe('FEE');
  expect(directionSelect.value).toBe('OUT');
});

it('apply button reports the settled count', async () => {
  vi.mocked(fetchServices.applyBankRules).mockResolvedValueOnce({
    success: true,
    appliedCount: 3,
  });

  render(
    <MemoryRouter>
      <BankRulesPage />
    </MemoryRouter>,
  );

  await waitFor(() => {
    expect(screen.getByText('Apply to unmatched lines')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByText('Apply to unmatched lines'));

  await waitFor(() => {
    expect(screen.getByText('Settled 3 line(s)')).toBeInTheDocument();
  });
});
