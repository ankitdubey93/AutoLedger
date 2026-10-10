import { useEffect, useRef, useState, type FormEvent } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { CreditCard, Lock } from 'lucide-react';
import {
  confirmStatementPayment,
  startStatementPayment,
  type StartedStatementPayment,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';
import type { PayPanelProps } from './PublicStatementPage';

/**
 * The right-hand card panel of the public statement page (Phase 39c).
 *
 * Two steps, so the server — not this component — fixes the amount:
 *   1. "Continue to payment" asks the server to price the chosen invoices
 *      and create a Stripe PaymentIntent; only its client secret comes back.
 *   2. Stripe's PaymentElement collects the card inside Stripe's own iframe —
 *      card numbers never touch this page's JavaScript or our server — and
 *      `confirmPayment` charges it. On success the server is told to settle
 *      (it re-reads the intent from Stripe; the webhook does the same).
 *
 * Changing the selection after step 1 discards the intent and starts over.
 * A redirect-based authentication (3-D Secure) returns here with
 * `?payment_intent=…`, which is settled on mount.
 */

const stripeByKey = new Map<string, Promise<Stripe | null>>();

/** One Stripe.js instance per publishable key, for the page's lifetime. */
function stripeFor(publishableKey: string): Promise<Stripe | null> {
  let stripe = stripeByKey.get(publishableKey);
  if (stripe === undefined) {
    stripe = loadStripe(publishableKey);
    stripeByKey.set(publishableKey, stripe);
  }
  return stripe;
}

function selectionKey(ids: string[]): string {
  return [...ids].sort().join(',');
}

export default function StripePayPanel({ token, selected, totalCents, currency, onPaid }: PayPanelProps) {
  const [started, setStarted] = useState<(StartedStatementPayment & { key: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const handledReturn = useRef(false);

  const key = selectionKey(selected.map((i) => i.documentId));
  const active = started !== null && started.key === key ? started : null;

  // Back from a redirect-based card authentication: settle what Stripe says happened.
  useEffect(() => {
    if (handledReturn.current) return;
    handledReturn.current = true;
    const params = new URLSearchParams(window.location.search);
    const intentId = params.get('payment_intent');
    if (intentId === null) return;
    window.history.replaceState(null, '', window.location.pathname);
    confirmStatementPayment(token, intentId)
      .then((res) => {
        if (res.status === 'RECORDED' || res.status === 'NEEDS_REVIEW') onPaid();
        else if (params.get('redirect_status') === 'failed') setError('The card was not authorised. Please try again.');
      })
      .catch(() => setError('We could not confirm the payment. If you were charged, the merchant will see it.'));
  }, [token, onPaid]);

  async function begin() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await startStatementPayment(
        token,
        selected.map((i) => i.documentId),
      );
      setStarted({ ...next, key });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the payment');
    } finally {
      setBusy(false);
    }
  }

  const nothingChosen = selected.length === 0;
  const mixedCurrency = !nothingChosen && currency === null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
      <p className="m-0 font-semibold flex items-center gap-2">
        <CreditCard size={16} aria-hidden="true" /> Pay by card
      </p>

      <div className="flex justify-between text-sm">
        <span className="text-[var(--muted)]">
          {selected.length} invoice{selected.length === 1 ? '' : 's'} selected
        </span>
        <span className="font-semibold tabular-nums" data-testid="pay-total">
          {formatCents(totalCents)} {currency ?? ''}
        </span>
      </div>

      {nothingChosen && <p className="m-0 text-sm text-[var(--muted)]">Choose the invoices you want to pay.</p>}
      {mixedCurrency && <p className="m-0 text-sm text-[var(--bad)]">Pay invoices in one currency at a time.</p>}
      {notice !== null && <p className="status status--good m-0">{notice}</p>}
      {error !== null && <p className="status status--bad m-0">{error}</p>}

      {active === null ? (
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy || nothingChosen || mixedCurrency}
          onClick={() => void begin()}
        >
          {busy ? 'Preparing…' : 'Continue to payment'}
        </button>
      ) : (
        <Elements
          key={active.clientSecret}
          stripe={stripeFor(active.publishableKey)}
          options={{ clientSecret: active.clientSecret, appearance: { theme: 'stripe' } }}
        >
          <CardForm
            token={token}
            amountLabel={`${formatCents(active.amountCents)} ${active.currencyCode}`}
            onCancel={() => setStarted(null)}
            onError={setError}
            onDone={(message) => {
              setStarted(null);
              setNotice(message);
              onPaid();
            }}
          />
        </Elements>
      )}

      <p className="m-0 text-xs text-[var(--muted)] flex items-center gap-1.5">
        <Lock size={12} aria-hidden="true" /> Card details go directly to Stripe and are never stored by us.
      </p>
    </div>
  );
}

function CardForm(props: {
  token: string;
  amountLabel: string;
  onCancel: () => void;
  onError: (message: string | null) => void;
  onDone: (message: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [paying, setPaying] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (stripe === null || elements === null) return;
    setPaying(true);
    props.onError(null);
    const result = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: window.location.href.split('?')[0] ?? window.location.href },
    });
    if (result.error !== undefined) {
      props.onError(result.error.message ?? 'The payment did not go through.');
      setPaying(false);
      return;
    }
    try {
      const settled = await confirmStatementPayment(props.token, result.paymentIntent.id);
      props.onDone(
        settled.status === 'NEEDS_REVIEW'
          ? 'Payment received — the merchant will apply it to your account shortly.'
          : settled.status === 'RECORDED'
            ? 'Payment received — thank you.'
            : 'Payment is processing. Your balance will update once it completes.',
      );
    } catch {
      props.onDone('Payment received. Your balance will update shortly.');
    } finally {
      setPaying(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <PaymentElement />
      <button type="submit" className={primaryButtonClass} disabled={paying || stripe === null || elements === null}>
        {paying ? 'Paying…' : `Pay ${props.amountLabel}`}
      </button>
      <button type="button" className={secondaryButtonClass} disabled={paying} onClick={props.onCancel}>
        Change selection
      </button>
    </form>
  );
}
