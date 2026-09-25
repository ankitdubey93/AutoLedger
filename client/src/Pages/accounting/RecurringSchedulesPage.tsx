import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Repeat } from 'lucide-react';
import {
  listRecurringSchedules,
  type RecurringSchedule,
  type RecurringKind,
} from '../../services/fetchServices';
import PageHeader from '../../components/ui/PageHeader';
import TabBar from '../../components/ui/TabBar';
import EmptyState from '../../components/ui/EmptyState';

/**
 * Phase 34b — the recurring schedules list. Invoices, bills, and journals
 * that repeat on a schedule.
 */

function frequencyLabel(frequency: string, intervalCount: number): string {
  const plural = intervalCount > 1 ? 's' : '';
  if (frequency === 'WEEKLY') return `Every ${intervalCount} week${plural}`;
  if (frequency === 'MONTHLY') return `Every ${intervalCount} month${plural}`;
  if (frequency === 'QUARTERLY') return `Every ${intervalCount} quarter${plural}`;
  return `Every ${intervalCount} year${plural}`;
}

function kindLabel(kind: RecurringKind): string {
  if (kind === 'INVOICE') return 'Invoice';
  if (kind === 'BILL') return 'Bill';
  return 'Journal';
}

export default function RecurringSchedulesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [schedules, setSchedules] = useState<RecurringSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kindFilter = (searchParams.get('kind') || null) as RecurringKind | null;
  const activeTab =
    kindFilter === 'INVOICE' ? 'invoices' : kindFilter === 'BILL' ? 'bills' : kindFilter === 'JOURNAL' ? 'journals' : 'all';

  useEffect(() => {
    let ignore = false;

    listRecurringSchedules({ kind: kindFilter })
      .then((res) => {
        if (!ignore) setSchedules(res.schedules);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load schedules');
      });

    return () => {
      ignore = true;
    };
  }, [kindFilter]);

  const items = [
    { id: 'all', label: 'All' },
    { id: 'invoices', label: 'Invoices' },
    { id: 'bills', label: 'Bills' },
    { id: 'journals', label: 'Journals' },
  ];

  function handleTabChange(tabId: string) {
    const kindMap: Record<string, RecurringKind | null> = {
      all: null,
      invoices: 'INVOICE',
      bills: 'BILL',
      journals: 'JOURNAL',
    };
    const kind = kindMap[tabId] ?? null;
    const newParams = new URLSearchParams(searchParams);
    if (kind === null) {
      newParams.delete('kind');
    } else {
      newParams.set('kind', kind);
    }
    setSearchParams(newParams);
  }

  if (schedules === null) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader as="h2" icon={Repeat} title="Recurring" />
        <div className="shell" aria-busy="true">
          <div className="skeleton skeleton--title" />
          <span className="visually-hidden">Loading schedules…</span>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <PageHeader as="h2" icon={Repeat} title="Recurring" />

      {error !== null && <p className="status status--bad">{error}</p>}

      <TabBar variant="buttons" items={items} active={activeTab} onChange={handleTabChange} ariaLabel="Filter by kind" />

      {schedules.length === 0 ? (
        <EmptyState icon={Repeat} title="No recurring schedules yet" body="Create a recurring schedule from an invoice, bill, or journal entry detail page." />
      ) : (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[52rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Kind</th>
                <th className="p-3 font-medium">Frequency</th>
                <th className="p-3 font-medium">Next run</th>
                <th className="p-3 font-medium">Last run</th>
                <th className="p-3 font-medium">Mode</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id} className="border-t border-[var(--border)] hover:bg-[var(--hover-bg)] transition-colors">
                  <td className="p-3">
                    <Link to={`/recurring/${schedule.id}`} className="text-[var(--accent)] hover:underline">
                      {schedule.name}
                    </Link>
                  </td>
                  <td className="p-3">{kindLabel(schedule.kind)}</td>
                  <td className="p-3">{frequencyLabel(schedule.frequency, schedule.intervalCount)}</td>
                  <td className="p-3">{schedule.nextRunDate ?? '—'}</td>
                  <td className="p-3">{schedule.lastRunDate ?? '—'}</td>
                  <td className="p-3">{schedule.mode === 'DRAFT' ? 'Draft' : 'Posted'}</td>
                  <td className="p-3">
                    <div
                      className={`inline-block px-2 py-1 rounded-md text-xs font-medium ${
                        schedule.lastError !== null
                          ? 'bg-[var(--warning-bg)] text-[var(--warning-text)]'
                          : schedule.status === 'ACTIVE'
                            ? 'bg-[var(--success-bg)] text-[var(--success-text)]'
                            : schedule.status === 'PAUSED'
                              ? 'bg-[var(--muted-bg)] text-[var(--muted-text)]'
                              : 'bg-[var(--muted-bg)] text-[var(--muted-text)]'
                      }`}
                    >
                      {schedule.status}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
