import { useEffect, useState } from 'react';
import { getAbnLookupStatus, lookupAbn } from '../services/fetchServices';

/**
 * Phase 49f — checks an ABN with the ABR when ABN Lookup is configured, and
 * otherwise links to the public register so a person can check by hand.
 */
export default function AbnLookupButton({ value }: { value: string }) {
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    getAbnLookupStatus()
      .then((res) => {
        if (!ignore) setEnabled(res.lookupEnabled);
      })
      .catch(() => {
        // The link below still works.
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    setMessage(null);
  }, [value]);

  const digits = value.replace(/[\s-]/g, '');
  if (digits.length !== 11) return null;

  if (!enabled) {
    return (
      <a className="text-xs" href={`https://abr.business.gov.au/ABN/View?abn=${encodeURIComponent(digits)}`} target="_blank" rel="noreferrer">
        Check on ABN Lookup
      </a>
    );
  }

  async function check() {
    setBusy(true);
    try {
      const res = await lookupAbn(digits);
      if (res.result === null) setMessage('ABN Lookup has no record of this ABN.');
      else {
        const gst = res.result.gstRegisteredFrom === null ? 'not registered for GST' : 'registered for GST';
        setMessage(`${res.result.entityName}: ${res.result.active ? 'active' : 'cancelled'}, ${gst}.`);
      }
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : 'Could not check this ABN');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" className="btn btn--ghost text-xs" disabled={busy} onClick={() => void check()}>
        Check ABN
      </button>
      {message !== null && <span role="status">{message}</span>}
    </span>
  );
}
