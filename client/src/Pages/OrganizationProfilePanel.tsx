import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  getOrganizationProfile,
  updateOrganizationProfile,
  uploadDocument,
  type OrganizationProfile,
} from '../services/fetchServices';
import { useOrg } from '../context/OrgContext';
import { useDocumentObjectUrl } from '../utils/useDocumentObjectUrl';

/**
 * The organization's postal identity: legal name, industry, street and postal
 * address, contact details and a logo. Platform-level (Phase 30) — the invoice
 * document in LedgerCore reads it, and so can any other app.
 *
 * Seeded once from GET /organizations/profile, then edited locally and saved
 * with PATCH. Blank inputs are sent as `null` (the server rejects a blank
 * legal name outright, and an empty string is not a stored value anywhere).
 *
 * The logo is two calls, upload-then-link: the file goes to the Document Vault,
 * then the profile is PATCHed to reference the returned document id. If the
 * second call fails the previous logo stays and the vaulted file is left
 * orphaned — accepted, the same way documentService accepts an orphaned blob
 * on rollback. SVG is not offered: the vault sniffs PNG/JPEG/PDF/CSV only, and
 * an SVG logo would be inline markup in the printed document.
 */

const MAX_LOGO_BYTES = 10 * 1024 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg'];
const LOGO_ERROR = 'Logo must be a PNG or JPEG under 10 MB';

interface FormState {
  legalName: string;
  industry: string;
  streetAddress1: string;
  streetAddress2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  postalSameAsStreet: boolean;
  postalAddress1: string;
  postalAddress2: string;
  postalCity: string;
  postalRegion: string;
  postalPostalCode: string;
  postalCountryCode: string;
  phone: string;
  contactEmail: string;
  website: string;
}

function toForm(p: OrganizationProfile): FormState {
  return {
    legalName: p.legalName ?? '',
    industry: p.industry ?? '',
    streetAddress1: p.streetAddress1 ?? '',
    streetAddress2: p.streetAddress2 ?? '',
    city: p.city ?? '',
    region: p.region ?? '',
    postalCode: p.postalCode ?? '',
    countryCode: p.countryCode ?? '',
    postalSameAsStreet: p.postalSameAsStreet,
    postalAddress1: p.postalAddress1 ?? '',
    postalAddress2: p.postalAddress2 ?? '',
    postalCity: p.postalCity ?? '',
    postalRegion: p.postalRegion ?? '',
    postalPostalCode: p.postalPostalCode ?? '',
    postalCountryCode: p.postalCountryCode ?? '',
    phone: p.phone ?? '',
    contactEmail: p.contactEmail ?? '',
    website: p.website ?? '',
  };
}

/** Blank (after trimming) becomes `null`. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export default function OrganizationProfilePanel() {
  const { role } = useOrg();
  const canEdit = role === 'OWNER' || role === 'ADMIN';

  const [form, setForm] = useState<FormState | null>(null);
  const [logoDocumentId, setLogoDocumentId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const logoUrl = useDocumentObjectUrl(logoDocumentId);

  // `ignore` rather than AbortController — see the note in AuthContext.tsx.
  useEffect(() => {
    let ignore = false;
    getOrganizationProfile()
      .then((profile) => {
        if (ignore) return;
        setForm(toForm(profile));
        setLogoDocumentId(profile.logoDocumentId);
      })
      .catch((err: unknown) => {
        if (!ignore) setLoadError(err instanceof Error ? err.message : 'Could not load the organization profile');
      });
    return () => {
      ignore = true;
    };
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev === null ? prev : { ...prev, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    if (form === null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const same = form.postalSameAsStreet;
    try {
      await updateOrganizationProfile({
        legalName: orNull(form.legalName),
        industry: orNull(form.industry),
        streetAddress1: orNull(form.streetAddress1),
        streetAddress2: orNull(form.streetAddress2),
        city: orNull(form.city),
        region: orNull(form.region),
        postalCode: orNull(form.postalCode),
        countryCode: orNull(form.countryCode),
        postalSameAsStreet: same,
        postalAddress1: same ? null : orNull(form.postalAddress1),
        postalAddress2: same ? null : orNull(form.postalAddress2),
        postalCity: same ? null : orNull(form.postalCity),
        postalRegion: same ? null : orNull(form.postalRegion),
        postalPostalCode: same ? null : orNull(form.postalPostalCode),
        postalCountryCode: same ? null : orNull(form.postalCountryCode),
        phone: orNull(form.phone),
        contactEmail: orNull(form.contactEmail),
        website: orNull(form.website),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the organization profile');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear the input so choosing the same file again re-fires onChange.
    e.target.value = '';
    if (file === undefined) return;

    setLogoError(null);
    if (!LOGO_TYPES.includes(file.type) || file.size > MAX_LOGO_BYTES) {
      setLogoError(LOGO_ERROR);
      return;
    }

    setLogoBusy(true);
    try {
      const { document } = await uploadDocument(file);
      const updated = await updateOrganizationProfile({ logoDocumentId: document.id });
      setLogoDocumentId(updated.logoDocumentId);
    } catch (err) {
      // The previous logo is kept; a vaulted-but-unlinked file is left as is.
      setLogoError(err instanceof Error ? err.message : LOGO_ERROR);
    } finally {
      setLogoBusy(false);
    }
  }

  async function handleRemoveLogo() {
    setLogoBusy(true);
    setLogoError(null);
    try {
      const updated = await updateOrganizationProfile({ logoDocumentId: null });
      setLogoDocumentId(updated.logoDocumentId);
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Could not remove the logo');
    } finally {
      setLogoBusy(false);
    }
  }

  if (loadError !== null) {
    return (
      <section className="card">
        <h2>Organization profile</h2>
        <p className="status status--bad">{loadError}</p>
      </section>
    );
  }
  if (form === null) {
    return (
      <section className="card">
        <h2>Organization profile</h2>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const ro = !canEdit;

  return (
    <section className="card">
      <h2>Organization profile</h2>
      {ro && (
        <p className="muted">Only an OWNER or ADMIN can edit the organization profile.</p>
      )}

      <h3>Logo</h3>
      {logoUrl !== null && (
        <img src={logoUrl} alt="Organization logo" style={{ maxHeight: '96px', maxWidth: '240px' }} />
      )}
      {canEdit && (
        <div>
          <label htmlFor="org-logo">Upload logo (PNG or JPEG, up to 10 MB)</label>
          <input
            id="org-logo"
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg"
            disabled={logoBusy}
            onChange={(e) => void handleLogoChosen(e)}
          />
          {logoDocumentId !== null && (
            <button type="button" className="btn" disabled={logoBusy} onClick={() => void handleRemoveLogo()}>
              Remove logo
            </button>
          )}
        </div>
      )}
      {logoError !== null && <p className="status status--bad">{logoError}</p>}

      <h3>Identity</h3>
      <label htmlFor="org-legal-name">Legal name</label>
      <input id="org-legal-name" type="text" maxLength={200} disabled={ro} value={form.legalName}
        onChange={(e) => set('legalName', e.target.value)} />
      <label htmlFor="org-industry">Industry</label>
      <input id="org-industry" type="text" maxLength={120} disabled={ro} value={form.industry}
        onChange={(e) => set('industry', e.target.value)} />

      <h3>Street address</h3>
      <label htmlFor="org-street-1">Address line 1</label>
      <input id="org-street-1" type="text" maxLength={200} disabled={ro} value={form.streetAddress1}
        onChange={(e) => set('streetAddress1', e.target.value)} />
      <label htmlFor="org-street-2">Address line 2</label>
      <input id="org-street-2" type="text" maxLength={200} disabled={ro} value={form.streetAddress2}
        onChange={(e) => set('streetAddress2', e.target.value)} />
      <label htmlFor="org-city">City</label>
      <input id="org-city" type="text" maxLength={120} disabled={ro} value={form.city}
        onChange={(e) => set('city', e.target.value)} />
      <label htmlFor="org-region">State / region</label>
      <input id="org-region" type="text" maxLength={120} disabled={ro} value={form.region}
        onChange={(e) => set('region', e.target.value)} />
      <label htmlFor="org-postal-code">Postal code</label>
      <input id="org-postal-code" type="text" maxLength={32} disabled={ro} value={form.postalCode}
        onChange={(e) => set('postalCode', e.target.value)} />
      <label htmlFor="org-country">Country code</label>
      <input id="org-country" type="text" maxLength={2} disabled={ro} value={form.countryCode}
        onChange={(e) => set('countryCode', e.target.value.toUpperCase())} />

      <h3>Postal address</h3>
      <label htmlFor="org-postal-same">
        <input id="org-postal-same" type="checkbox" disabled={ro} checked={form.postalSameAsStreet}
          onChange={(e) => set('postalSameAsStreet', e.target.checked)} />{' '}
        Same as street address
      </label>
      {!form.postalSameAsStreet && (
        <>
          <label htmlFor="org-postal-1">Postal address line 1</label>
          <input id="org-postal-1" type="text" maxLength={200} disabled={ro} value={form.postalAddress1}
            onChange={(e) => set('postalAddress1', e.target.value)} />
          <label htmlFor="org-postal-2">Postal address line 2</label>
          <input id="org-postal-2" type="text" maxLength={200} disabled={ro} value={form.postalAddress2}
            onChange={(e) => set('postalAddress2', e.target.value)} />
          <label htmlFor="org-postal-city">Postal city</label>
          <input id="org-postal-city" type="text" maxLength={120} disabled={ro} value={form.postalCity}
            onChange={(e) => set('postalCity', e.target.value)} />
          <label htmlFor="org-postal-region">Postal state / region</label>
          <input id="org-postal-region" type="text" maxLength={120} disabled={ro} value={form.postalRegion}
            onChange={(e) => set('postalRegion', e.target.value)} />
          <label htmlFor="org-postal-postal-code">Postal code (mailing)</label>
          <input id="org-postal-postal-code" type="text" maxLength={32} disabled={ro} value={form.postalPostalCode}
            onChange={(e) => set('postalPostalCode', e.target.value)} />
          <label htmlFor="org-postal-country">Postal country code</label>
          <input id="org-postal-country" type="text" maxLength={2} disabled={ro} value={form.postalCountryCode}
            onChange={(e) => set('postalCountryCode', e.target.value.toUpperCase())} />
        </>
      )}

      <h3>Contact</h3>
      <label htmlFor="org-phone">Phone</label>
      <input id="org-phone" type="text" maxLength={40} disabled={ro} value={form.phone}
        onChange={(e) => set('phone', e.target.value)} />
      <label htmlFor="org-contact-email">Contact email</label>
      <input id="org-contact-email" type="email" maxLength={254} disabled={ro} value={form.contactEmail}
        onChange={(e) => set('contactEmail', e.target.value)} />
      <label htmlFor="org-website">Website</label>
      <input id="org-website" type="text" maxLength={200} disabled={ro} value={form.website}
        onChange={(e) => set('website', e.target.value)} />

      {error !== null && <p className="status status--bad">{error}</p>}
      {saved && error === null && <p className="status status--good">Saved.</p>}

      {canEdit && (
        <button type="button" className="btn" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </section>
  );
}
