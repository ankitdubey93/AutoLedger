import { useId } from 'react';
import type { AppSummary } from '../services/fetchServices';
import { requiredBy, toggleApp } from '../utils/appSelection';

/**
 * A checkbox grid of the suite's apps — Phase 27. Used by the post-sign-up
 * picker (/welcome) and Account's Apps panel. Controlled: the parent owns the
 * selection and saves it.
 *
 * Dependencies are enforced here as well as on the server: ticking AP-Flow
 * ticks LedgerCore, and LedgerCore's box is locked while anything that needs
 * it is ticked, so the UI never offers a set the server would reject.
 */
export default function AppPicker({
  apps,
  selected,
  onChange,
  disabled = false,
}: {
  apps: AppSummary[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const nameOf = (slug: string) => apps.find((a) => a.slug === slug)?.name ?? slug;
  // Each checkbox is named by its app's name alone (aria-labelledby), not by
  // the whole card — otherwise LedgerCore's "Needed by AP-Flow" line would make
  // its checkbox answer to "AP-Flow" too.
  const idBase = useId();

  return (
    <fieldset className="border-0 p-0 m-0">
      <legend className="visually-hidden">Apps</legend>
      <div className="app-grid">
        {apps.map((app) => {
          const checked = selected.has(app.slug);
          const neededBy = checked ? requiredBy(apps, selected, app.slug) : [];
          const locked = disabled || app.status === 'planned' || neededBy.length > 0;

          return (
            <label key={app.slug} className="card app-card cursor-pointer">
              <div className="app-card__head">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-labelledby={`${idBase}-${app.slug}`}
                    checked={checked}
                    disabled={locked}
                    onChange={() => onChange(toggleApp(apps, selected, app.slug))}
                  />
                  <span id={`${idBase}-${app.slug}`} className="app-card__name">
                    {app.name}
                  </span>
                </span>
                {app.status === 'planned' && <span className="chip chip--muted">Coming soon</span>}
              </div>
              <p className="app-card__domain">{app.domain}</p>
              <p className="muted">{app.tagline}</p>
              {app.requires.length > 0 && (
                <p className="muted">Requires {app.requires.map(nameOf).join(', ')}</p>
              )}
              {neededBy.length > 0 && <p className="muted">Needed by {neededBy.join(', ')}</p>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
