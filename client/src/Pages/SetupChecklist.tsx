import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOnboardingChecklist, type OnboardingChecklistItem } from '../services/fetchServices';

const STATUS_LABEL: Record<OnboardingChecklistItem['status'], string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  SKIPPED: 'Skipped',
  COMPLETED: 'Complete',
};

/**
 * The suite-level setup checklist — Phase 9a. Lists only apps that actually
 * have a wizard to run (`appStatus === 'building'`); a `planned` app, and the
 * `'platform'` sentinel (no suite-level wizard UI exists yet), have no
 * onboarding worth showing here.
 *
 * Rendered on AppChooserPage, below the app grid, so a fresh organization
 * sees at a glance which of its live apps still need setup.
 */
export default function SetupChecklist() {
  const [items, setItems] = useState<OnboardingChecklistItem[] | null>(null);

  useEffect(() => {
    let ignore = false;

    getOnboardingChecklist()
      .then((res) => {
        // Defensive: an unexpected response shape (e.g. a test harness that
        // mocks every fetch call identically) must not crash the chooser —
        // it simply renders nothing, same as a failed fetch below.
        if (!ignore && Array.isArray(res.items)) setItems(res.items);
      })
      .catch(() => {
        // The chooser still works without the checklist — it simply does not render.
      });

    return () => {
      ignore = true;
    };
  }, []);

  if (items === null) return null;

  const buildingItems = items.filter((item) => item.appStatus === 'building');
  if (buildingItems.length === 0) return null;

  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-base font-semibold m-0">Setup</h2>
      <ul className="flex flex-col gap-2 m-0 p-0 list-none">
        {buildingItems.map((item) => (
          <li key={item.appSlug} className="flex items-center justify-between gap-4 text-sm">
            <span>{item.appName}</span>
            <span className="flex items-center gap-3">
              <span className="chip chip--muted">{STATUS_LABEL[item.status]}</span>
              {item.status !== 'COMPLETED' && (
                <Link to={`/app/${item.appSlug}/onboarding`}>Set up</Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
