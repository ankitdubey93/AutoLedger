import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import { leaveOrganization } from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import PageHeader from '../../components/ui/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import { primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

/**
 * Phase 37 — "Your organizations": every organization the user belongs to,
 * with Switch for the others and Leave for the active one.
 *
 * Leave applies to the active organization only, because the server takes
 * the organization from the access token (rule 1) — never from a URL — and
 * then moves the session to another of the user's organizations. To leave a
 * different one, switch to it first.
 */
export default function OrganizationsPage() {
  const { organization, memberships, switching, switchTo, enterSession } = useOrg();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    setLeaving(true);
    setError(null);
    try {
      enterSession(await leaveOrganization());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not leave the organization');
      setLeaving(false);
      setConfirmLeave(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={Building2}
        title="Your organizations"
        subtitle="Each organization keeps its own books. Switch between them at any time from the top bar."
        actions={
          <Link to="/organizations/new" className={`${primaryButtonClass} no-underline inline-flex items-center gap-1.5`}>
            <Plus size={15} aria-hidden="true" /> Add organization
          </Link>
        }
      />

      {error !== null && (
        <p className="status status--bad" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <div className="table-scroll">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Your role</th>
                  <th>Joined</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => {
                  const active = m.orgId === organization?.id;
                  return (
                    <tr key={m.orgId}>
                      <td>
                        {m.orgName}
                        {active && <span className="chip ml-2">Current</span>}
                      </td>
                      <td>
                        <span className="chip">{m.role}</span>
                      </td>
                      <td>{new Date(m.joinedAt).toLocaleDateString()}</td>
                      <td className="text-right">
                        {active ? (
                          <button
                            type="button"
                            className={secondaryButtonClass}
                            disabled={leaving || memberships.length <= 1}
                            title={memberships.length <= 1 ? 'You cannot leave your only organization' : undefined}
                            onClick={() => setConfirmLeave(true)}
                          >
                            Leave
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={secondaryButtonClass}
                            disabled={switching}
                            onClick={() => void switchTo(m.orgId)}
                          >
                            Switch
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {confirmLeave && organization !== null && (
        <ConfirmDialog
          title={`Leave ${organization.name}?`}
          body="You will lose access to its books straight away. An owner or admin can invite you back."
          confirmLabel="Leave organization"
          tone="danger"
          busy={leaving}
          onConfirm={() => void leave()}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </div>
  );
}
