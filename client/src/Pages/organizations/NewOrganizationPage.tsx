import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { createOrganization } from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

/**
 * Phase 37 — add another organization (another company whose books you keep).
 *
 * Only the name is asked for. Everything else — base currency, fiscal year,
 * address — belongs to the new organization's own setup wizard, which the
 * setup gate opens as soon as the session lands in it: the server moves the
 * session into the new organization, `enterSession` navigates to `/`, and an
 * organization without settings is sent to `/onboarding`.
 */
export default function NewOrganizationPage() {
  const { enterSession } = useOrg();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      enterSession(await createOrganization(name.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the organization');
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-xl flex flex-col gap-5">
      <PageHeader
        icon={Building2}
        title="Add an organization"
        subtitle="A separate set of books — its own chart of accounts, customers, invoices and settings. You will be its owner."
      />

      <form className="card flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
        <label htmlFor="new-org-name" className="text-sm font-medium">
          Organization name
        </label>
        <input
          id="new-org-name"
          className={inputClass}
          required
          minLength={2}
          maxLength={120}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="muted text-sm m-0">Next you will set it up: currency, fiscal year and address.</p>

        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button type="submit" className={primaryButtonClass} disabled={submitting || name.trim().length < 2}>
            {submitting ? 'Creating…' : 'Create and set up'}
          </button>
          <Link to="/organizations" className={`${secondaryButtonClass} no-underline`}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
