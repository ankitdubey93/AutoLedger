import { Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { MigrationImportKind } from '../../services/fetchServices';

export default function ImportButton({ kind, returnTo }: { kind: MigrationImportKind; returnTo: string }) {
  const href = `/migration-imports/new?kind=${kind}&returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <Link
      to={href}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-[var(--border)] bg-transparent text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors no-underline"
    >
      <Upload size={15} aria-hidden="true" />
      Import
    </Link>
  );
}
