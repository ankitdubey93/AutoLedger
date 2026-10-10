import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StripePayPanel from '../Pages/public/StripePayPanel';
import type { PayPanelProps } from '../Pages/public/PublicStatementPage';
import { sampleStatement } from '../Pages/statements/sampleStatement';

/**
 * The card panel (Phase 39c). Stripe.js is mocked: `PaymentElement` is a
 * placeholder and `confirmPayment` is a spy — the real one runs in Stripe's
 * iframe. What is under test is our flow: the server prices the selection,
 * Stripe confirms, the server is asked to settle, the page is told.
 */

const confirmPayment = vi.fn();

vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: ReactNode }) => <div data-testid="elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment }),
  useElements: () => ({}),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirmPayment.mockReset();
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/public/statements/tok/payments') && init?.method === 'POST') {
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          payment: { onlinePaymentId: 'op1', clientSecret: 'pi_1_secret', publishableKey: 'pk_test_x', amountCents: 145000, currencyCode: 'USD' },
        }),
      );
    }
    if (url.endsWith('/public/statements/tok/payments/pi_1/confirm')) {
      return Promise.resolve(jsonResponse(200, { success: true, status: 'RECORDED', paymentId: 'p1' }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled ${url}` }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function props(overrides: Partial<PayPanelProps> = {}): PayPanelProps {
  const statement = sampleStatement('OUTSTANDING');
  const overdue = statement.openItems.filter((i) => i.daysOverdue > 0);
  return {
    token: 'tok',
    view: {} as PayPanelProps['view'],
    selected: overdue,
    totalCents: 145000,
    currency: 'USD',
    onPaid: vi.fn(),
    ...overrides,
  };
}

describe('StripePayPanel', () => {
  it('asks the server to price the selection, confirms with Stripe, then settles and tells the page', async () => {
    const user = userEvent.setup();
    const p = props();
    confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded' } });
    render(<StripePayPanel {...p} />);

    expect(screen.getByTestId('pay-total')).toHaveTextContent('1,450.00 USD');
    await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();

    const start = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/payments'));
    expect(JSON.parse(String((start?.[1] as RequestInit).body))).toEqual({ invoiceIds: ['sample-inv-2'] });
    expect((start?.[1] as RequestInit).credentials).toBe('omit');

    await user.click(screen.getByRole('button', { name: 'Pay 1,450.00 USD' }));
    expect(await screen.findByText('Payment received — thank you.')).toBeInTheDocument();
    expect(confirmPayment).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'if_required' }));
    expect(p.onPaid).toHaveBeenCalledTimes(1);
  });

  it('shows a declined card and does not settle', async () => {
    const user = userEvent.setup();
    const p = props();
    confirmPayment.mockResolvedValue({ error: { message: 'Your card was declined.' } });
    render(<StripePayPanel {...p} />);
    await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await user.click(await screen.findByRole('button', { name: /^Pay / }));
    expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/confirm'))).toBe(false);
    expect(p.onPaid).not.toHaveBeenCalled();
  });

  it('cannot start with nothing chosen or with mixed currencies', () => {
    const { rerender } = render(<StripePayPanel {...props({ selected: [], totalCents: 0 })} />);
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
    rerender(<StripePayPanel {...props({ currency: null })} />);
    expect(screen.getByText('Pay invoices in one currency at a time.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
  });
});
