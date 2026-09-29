import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  getOrganizationProfile,
  updateOrganizationProfile,
  uploadDocument,
  type OrganizationProfile,
} from '../services/fetchServices';
import { useOrg } from '../context/OrgContext';
import { useDocumentObjectUrl } from '../utils/useDocumentObjectUrl';
import { inputClass } from '../components/ui/formClasses';

/**
 * The organization's postal identity: legal name, industry, street and postal
 * address, contact details and a logo. Platform-level (Phase 30) — the invoice
 * document in Accounting reads it, and so can any other app.
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

      <h3 className="m-0 mt-2 mb-2 text-sm font-semibold">Logo</h3>
      {logoUrl !== null && (
        <img src={logoUrl} alt="Organization logo" style={{ maxHeight: '96px', maxWidth: '240px' }} />
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor="org-logo" className="flex flex-col gap-1">
            <span className="text-[var(--muted)]">Upload logo (PNG or JPEG, up to 10 MB)</span>
            <input
              id="org-logo"
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              disabled={logoBusy}
              onChange={(e) => void handleLogoChosen(e)}
            />
          </label>
          {logoDocumentId !== null && (
            <button type="button" className="btn btn--ghost !mt-0" disabled={logoBusy} onClick={() => void handleRemoveLogo()}>
              Remove logo
            </button>
          )}
        </div>
      )}
      {logoError !== null && <p className="status status--bad">{logoError}</p>}

      <h3 className="m-0 mt-5 mb-2 text-sm font-semibold">Identity</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor="org-legal-name" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Legal name</span>
          <input id="org-legal-name" type="text" maxLength={200} disabled={ro} value={form.legalName} className={inputClass}
            onChange={(e) => set('legalName', e.target.value)} />
        </label>
        <label htmlFor="org-industry" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Industry</span>
          <input id="org-industry" type="text" maxLength={120} disabled={ro} value={form.industry} className={inputClass}
            onChange={(e) => set('industry', e.target.value)} />
        </label>
      </div>
      <h3 className="m-0 mt-5 mb-2 text-sm font-semibold">Street address</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor="org-street-1" className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-[var(--muted)]">Address line 1</span>
          <input id="org-street-1" type="text" maxLength={200} disabled={ro} value={form.streetAddress1} className={inputClass}
            onChange={(e) => set('streetAddress1', e.target.value)} />
        </label>
        <label htmlFor="org-street-2" className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-[var(--muted)]">Address line 2</span>
          <input id="org-street-2" type="text" maxLength={200} disabled={ro} value={form.streetAddress2} className={inputClass}
            onChange={(e) => set('streetAddress2', e.target.value)} />
        </label>
        <label htmlFor="org-city" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">City</span>
          <input id="org-city" type="text" maxLength={120} disabled={ro} value={form.city} className={inputClass}
            onChange={(e) => set('city', e.target.value)} />
        </label>
        <label htmlFor="org-region" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">State / region</span>
          <input id="org-region" type="text" maxLength={120} disabled={ro} value={form.region} className={inputClass}
            onChange={(e) => set('region', e.target.value)} />
        </label>
        <label htmlFor="org-postal-code" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Postal code</span>
          <input id="org-postal-code" type="text" maxLength={32} disabled={ro} value={form.postalCode} className={inputClass}
            onChange={(e) => set('postalCode', e.target.value)} />
        </label>
        <label htmlFor="org-country" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Country code</span>
          <input id="org-country" type="text" maxLength={2} disabled={ro} value={form.countryCode} className={inputClass}
            onChange={(e) => set('countryCode', e.target.value.toUpperCase())} />
        </label>
      </div>
      <h3 className="m-0 mt-5 mb-2 text-sm font-semibold">Postal address</h3>
      <label htmlFor="org-postal-same" className="flex items-center gap-2 text-sm">
        <input id="org-postal-same" type="checkbox" disabled={ro} checked={form.postalSameAsStreet}
          onChange={(e) => set('postalSameAsStreet', e.target.checked)} />
        Same as street address
      </label>
      {!form.postalSameAsStreet && (
        <div className="grid gap-3 sm:grid-cols-2 mt-3">
          <label htmlFor="org-postal-1" className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-[var(--muted)]">Postal address line 1</span>
            <input id="org-postal-1" type="text" maxLength={200} disabled={ro} value={form.postalAddress1} className={inputClass}
              onChange={(e) => set('postalAddress1', e.target.value)} />
          </label>
          <label htmlFor="org-postal-2" className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-[var(--muted)]">Postal address line 2</span>
            <input id="org-postal-2" type="text" maxLength={200} disabled={ro} value={form.postalAddress2} className={inputClass}
              onChange={(e) => set('postalAddress2', e.target.value)} />
          </label>
          <label htmlFor="org-postal-city" className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Postal city</span>
            <input id="org-postal-city" type="text" maxLength={120} disabled={ro} value={form.postalCity} className={inputClass}
              onChange={(e) => set('postalCity', e.target.value)} />
          </label>
          <label htmlFor="org-postal-region" className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Postal state / region</span>
            <input id="org-postal-region" type="text" maxLength={120} disabled={ro} value={form.postalRegion} className={inputClass}
              onChange={(e) => set('postalRegion', e.target.value)} />
          </label>
          <label htmlFor="org-postal-postal-code" className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Postal code (mailing)</span>
            <input id="org-postal-postal-code" type="text" maxLength={32} disabled={ro} value={form.postalPostalCode} className={inputClass}
              onChange={(e) => set('postalPostalCode', e.target.value)} />
          </label>
          <label htmlFor="org-postal-country" className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Postal country code</span>
            <input id="org-postal-country" type="text" maxLength={2} disabled={ro} value={form.postalCountryCode} className={inputClass}
              onChange={(e) => set('postalCountryCode', e.target.value.toUpperCase())} />
          </label>
        </div>
      )}

      <h3 className="m-0 mt-5 mb-2 text-sm font-semibold">Contact</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor="org-phone" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Phone</span>
          <input id="org-phone" type="text" maxLength={40} disabled={ro} value={form.phone} className={inputClass}
            onChange={(e) => set('phone', e.target.value)} />
        </label>
        <label htmlFor="org-contact-email" className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Contact email</span>
          <input id="org-contact-email" type="email" maxLength={254} disabled={ro} value={form.contactEmail} className={inputClass}
            onChange={(e) => set('contactEmail', e.target.value)} />
        </label>
        <label htmlFor="org-website" className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-[var(--muted)]">Website</span>
          <input id="org-website" type="text" maxLength={200} disabled={ro} value={form.website} className={inputClass}
            onChange={(e) => set('website', e.target.value)} />
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {saved && error === null && <p className="status status--good">Saved.</p>}

      {canEdit && (
        <button type="button" className="btn mt-4" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </section>
  );
}
