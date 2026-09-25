import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOnboardingChecklist, type OnboardingChecklistItem } from '../../services/fetchServices';

const STATUS_LABEL: Record<OnboardingChecklistItem['status'], string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  SKIPPED: 'Skipped',
  COMPLETED: 'Complete',
};

/**
 * The setup tasks that have a wizard, keyed by the onboarding state the
 * server keeps for each. The keys are internal module tags, never shown.
 * Tasks the server reports but that have no setup screen (the retired app
 * picker's `platform` row, bill capture) are not listed.
 */
const TASKS: Record<string, { label: string; to: string }> = {
  'ledger-core': { label: 'Accounting setup', to: '/onboarding' },
  stock: { label: 'Inventory (optional)', to: '/inventory/setup' },
};

/**
 * What is left to set up, shown on the dashboard until every task is
 * complete. Phase 9a built it as the suite-level checklist on the app
 * chooser; Phase 33 moved it here and dropped the per-app framing.
 */
export default function SetupChecklist() {
  const [items, setItems] = useState<OnboardingChecklistItem[] | null>(null);

  useEffect(() => {
    let ignore = false;

    getOnboardingChecklist()
      .then((res) => {
        // Defensive: an unexpected response shape must not crash the
        // dashboard. It renders nothing, same as a failed fetch.
        if (!ignore && Array.isArray(res.items)) setItems(res.items);
      })
      .catch(() => {
        // The dashboard works without the checklist.
      });

    return () => {
      ignore = true;
    };
  }, []);

  if (items === null) return null;

  const tasks = items.filter((item) => TASKS[item.module] !== undefined);
  if (tasks.every((item) => item.status === 'COMPLETED')) return null;

  return (
    <section className="card flex flex-col gap-3" aria-label="Setup">
      <h2 className="text-base font-semibold m-0">Finish setting up</h2>
      <ul className="flex flex-col gap-2 m-0 p-0 list-none">
        {tasks.map((item) => {
          const task = TASKS[item.module];
          if (task === undefined) return null;
          return (
            <li key={item.module} className="flex items-center justify-between gap-4 text-sm">
              <span>{task.label}</span>
              <span className="flex items-center gap-3">
                <span className="chip chip--muted">{STATUS_LABEL[item.status]}</span>
                {item.status !== 'COMPLETED' && <Link to={task.to}>Set up</Link>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
