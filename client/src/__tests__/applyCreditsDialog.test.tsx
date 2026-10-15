import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ApplyCreditsDialog from '../components/ApplyCreditsDialog';
import type { AvailableCredit } from '../services/fetchServices';

/**
 * Phase 43c — the apply-credit dialog shown on bill approval / invoice issue.
 * (The "no credits → plain confirm dialog" path is covered by the page tests in
 * bills.test.tsx and invoices.test.tsx, whose mocked available-credits list is empty.)
 */

const credits: AvailableCredit[] = [
  { kind: 'NOTE', id: 'n1', number: 'DN-0001', date: '2026-05-01', currencyCode: 'USD', availableCents: 6000 },
  { kind: 'DEPOSIT', id: 'd1', number: 'PRE-1', date: '2026-05-10', currencyCode: 'USD', availableCents: 7000 },
];

function renderDialog(overrides: Partial<React.ComponentProps<typeof ApplyCreditsDialog>> = {}) {
  const onConfirm = vi.fn();
  const onSkip = vi.fn();
  const onCancel = vi.fn();
  render(
    <ApplyCreditsDialog
      direction="PURCHASE"
      title="Approving posts this expense."
      documentTotalCents={10000}
      amountDueCents={10000}
      credits={credits}
      busy={false}
      onConfirm={onConfirm}
      onSkip={onSkip}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onSkip, onCancel };
}

describe('ApplyCreditsDialog', () => {
  it('pre-fills oldest first: 6,000 then 4,000, leaving nothing due', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Apply available credit?' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Amount for Debit note DN-0001')).toHaveValue('60.00');
    expect(within(dialog).getByLabelText('Amount for Prepayment PRE-1')).toHaveValue('40.00');
    expect(within(dialog).getByText('Remaining due: 0.00')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Approve and apply' })).toBeEnabled();
  });

  it('confirms with the pre-filled allocations as integer cents', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Approve and apply' }));
    expect(onConfirm).toHaveBeenCalledWith([
      { kind: 'NOTE', id: 'n1', amountCents: 6000 },
      { kind: 'DEPOSIT', id: 'd1', amountCents: 4000 },
    ]);
  });

  it('"Approve only" skips without sending any credit', async () => {
    const user = userEvent.setup();
    const { onSkip, onConfirm } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Approve only' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables the primary button when an amount exceeds what the credit has available', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByLabelText('Amount for Debit note DN-0001');
    await user.clear(input);
    await user.type(input, '60.01');
    expect(screen.getByRole('button', { name: 'Approve and apply' })).toBeDisabled();
  });

  it('uses invoice wording on the sales side', () => {
    renderDialog({ direction: 'SALES', title: 'Issuing posts this invoice.' });
    expect(screen.getByRole('button', { name: 'Issue and apply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue only' })).toBeInTheDocument();
    expect(screen.getByLabelText('Amount for Credit note DN-0001')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount for Deposit PRE-1')).toBeInTheDocument();
  });
});
