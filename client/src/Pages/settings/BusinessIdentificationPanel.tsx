import { useEffect, useState } from 'react';
import { updateOrganization } from '../../services/fetchServices';
import { useAuthActions } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';

/**
 * Tax and business registration numbers — platform fields on `organizations`
 * (`PATCH /organizations`). Moved from the Account page to Organization
 * settings → Profile in Phase 38a: they belong to the company, not the person.
 */
export default function BusinessIdentificationPanel() {
  const { organization } = useOrg();
  const { refreshNow } = useAuthActions();

  const [taxNumber, setTaxNumber] = useState('');
  const [businessNumber, setBusinessNumber] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seeded once the organization is available, rather than at useState
  // initialization time — `organization` is null on the render before
  // OrgContext finishes loading.
  useEffect(() => {
    if (organization !== null && !seeded) {
      setTaxNumber(organization.taxNumber ?? '');
      setBusinessNumber(organization.businessNumber ?? '');
      setSeeded(true);
    }
  }, [organization, seeded]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateOrganization({
        taxNumber: taxNumber.trim() === '' ? null : taxNumber.trim(),
        businessNumber: businessNumber.trim() === '' ? null : businessNumber.trim(),
      });
      await refreshNow();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save business identification');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2>Business identification</h2>

      <div className="form">
        <label htmlFor="tax-number">Tax registration number</label>
        <input
          id="tax-number"
          type="text"
          maxLength={64}
          value={taxNumber}
          onChange={(e) => setTaxNumber(e.target.value)}
        />

        <label htmlFor="business-number">Business registration number</label>
        <input
          id="business-number"
          type="text"
          maxLength={64}
          value={businessNumber}
          onChange={(e) => setBusinessNumber(e.target.value)}
        />
      </div>

      <p className="muted">Shown on invoices when enabled in the invoice settings.</p>

      {error !== null && <p className="status status--bad">{error}</p>}
      {saved && error === null && <p className="status status--good">Saved.</p>}

      <button type="button" className="btn" disabled={saving} onClick={() => void handleSave()}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </section>
  );
}
