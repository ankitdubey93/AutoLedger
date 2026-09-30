import { Link } from 'react-router-dom';
import type { MigrationImportKind } from '../../../services/fetchServices';
import { IMPORT_GUIDES, MIGRATION_STEPS } from './importGuides';

export default function ImportGuidePanel({ kind }: { kind: MigrationImportKind }) {
  const guide = IMPORT_GUIDES[kind];

  return (
    <aside aria-label="How to import" className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3 text-sm">
      <h3 className="text-sm font-semibold m-0">How to import</h3>
      <p>{guide.intro}</p>
      <ol className="list-decimal list-inside pl-0">
        {guide.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <h4 className="text-sm font-semibold m-0 mt-2">Good to know</h4>
      <ul className="list-disc list-inside pl-0">
        {guide.rules.map((rule, i) => (
          <li key={i}>{rule}</li>
        ))}
      </ul>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">Moving from another system mid-year?</summary>
        <div className="mt-2 ml-4 space-y-2">
          <p>Import in this order so every reference already exists:</p>
          <ol className="list-decimal list-inside pl-0">
            {MIGRATION_STEPS.map((step) => (
              <li key={step.key} className="text-sm">
                <Link to={step.to} className="text-[var(--accent)] hover:underline">
                  {step.label}
                </Link>
                {' '}
                <span className="text-[var(--muted)]">— {step.hint}</span>
              </li>
            ))}
          </ol>
        </div>
      </details>
      <Link to="/migration-imports" className="text-[var(--accent)] hover:underline text-sm">
        See the migration checklist
      </Link>
    </aside>
  );
}
