import { useOrg } from '../../context/OrgContext';

/**
 * Switches the active organization.
 *
 * A `<select>` rather than a fancy menu: it is the honest control for "pick
 * one of N", and it is keyboard- and screen-reader-accessible for free.
 *
 * Hidden entirely when the user belongs to one organization, which is every
 * freshly-registered user — a picker with a single option is noise.
 */
export default function OrgSwitcher() {
  const { organization, memberships, switching, error, switchTo } = useOrg();

  if (memberships.length <= 1) return null;

  return (
    <div className="org-switcher">
      <label htmlFor="org-switcher" className="visually-hidden">
        Active organization
      </label>
      <select
        id="org-switcher"
        value={organization?.id ?? ''}
        disabled={switching}
        onChange={(event) => void switchTo(event.target.value)}
      >
        {memberships.map((m) => (
          <option key={m.orgId} value={m.orgId}>
            {m.orgName} · {m.role}
          </option>
        ))}
      </select>
      {switching && <span className="muted">Switching…</span>}
      {error !== null && <span className="status--bad">{error}</span>}
    </div>
  );
}
