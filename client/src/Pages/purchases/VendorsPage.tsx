import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  createVendor,
  getAgingReport,
  listVendors,
  updateVendor,
  type Vendor,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useDebouncedInput } from '../../utils/useDebouncedInput';
import { useTableSort } from '../../utils/useTableSort';
import { useClientPage } from '../../utils/useClientPage';
import SortableHeader from '../../components/ui/SortableHeader';
import Pagination from '../../components/ui/Pagination';
import LoadingState from '../../components/ui/LoadingState';
import ImportButton from '../../components/imports/ImportButton';

/**
 * The vendor list — the parties bills are entered against.
 *
 * `?new=1` opens the create form on mount, the same idiom CreateMenu and
 * CustomersPage use to jump straight into "add one" from anywhere in the app.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

function VendorForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createVendor({
        name: name.trim(),
        email: email.trim() === '' ? null : email.trim(),
        phone: phone.trim() === '' ? null : phone.trim(),
        billingAddress: billingAddress.trim() === '' ? null : billingAddress.trim(),
        taxNumber: taxNumber.trim() === '' ? null : taxNumber.trim(),
        paymentTerms: paymentTerms.trim() === '' ? null : paymentTerms.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the vendor');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <h3 className="text-sm font-semibold m-0">New vendor</h3>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Name</span>
          <input
            type="text"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Email</span>
          <input
            type="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Phone</span>
          <input
            type="text"
            maxLength={40}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Tax number</span>
          <input
            type="text"
            maxLength={64}
            value={taxNumber}
            onChange={(e) => setTaxNumber(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Payment terms</span>
        <input
          type="text"
          maxLength={500}
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Billing address</span>
        <textarea
          value={billingAddress}
          onChange={(e) => setBillingAddress(e.target.value)}
          rows={2}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Creating…' : 'Create vendor'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn--ghost">
          Cancel
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
    </form>
  );
}

export default function VendorsPage() {
  const [params, setParams] = useSearchParams();
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  // Balance due per vendor, from the AP aging report's per-party rows
  // (Phase 25). `null` = still loading or failed — the list renders anyway.
  const [balances, setBalances] = useState<Map<string, number> | null>(null);
  const { sorted: sortedVendors, sort, toggle: toggleSort } = useTableSort(
    vendors,
    {
      name: (row: Vendor) => row.name,
      email: (row: Vendor) => row.email,
      phone: (row: Vendor) => row.phone,
      taxNumber: (row: Vendor) => row.taxNumber,
      balance: (row: Vendor) => (balances === null ? null : (balances.get(row.id) ?? 0)),
      status: (row: Vendor) => (row.isActive ? 0 : 1),
    },
    { key: 'name', direction: 'asc' },
    [balances],
  );
  const paged = useClientPage(sortedVendors);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(params.get('new') === '1');
  const [reloadToken, setReloadToken] = useState(0);
  const q = params.get('q') ?? '';
  const [qDraft, setQDraft] = useDebouncedInput(q, setSearch);

  useEffect(() => {
    let ignore = false;

    const filters: { q?: string; includeInactive: boolean } = { includeInactive: true };
    if (q !== '') filters.q = q;

    listVendors(filters)
      .then((res) => {
        if (!ignore) setVendors(res.vendors);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load vendors');
      });

    return () => {
      ignore = true;
    };
  }, [q, reloadToken]);

  useEffect(() => {
    let ignore = false;
    getAgingReport('AP')
      .then((report) => {
        if (!ignore) setBalances(new Map(report.rows.map((row) => [row.counterpartyId, row.totalCents])));
      })
      .catch(() => {
        if (!ignore) setBalances(null);
      });
    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  async function toggleActive(vendor: Vendor) {
    try {
      await updateVendor(vendor.id, { isActive: !vendor.isActive });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update the vendor');
    }
  }

  function setSearch(value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete('q');
    else next.set('q', value);
    next.delete('new');
    setParams(next);
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Vendors</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">The parties expenses are entered against.</p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton kind="VENDORS" returnTo="/vendors" />
          <button
            type="button"
            onClick={() => setShowForm((open) => !open)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            <Plus size={15} aria-hidden="true" /> New vendor
          </button>
        </div>
      </header>

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">Search</span>
        <input type="text" value={qDraft} onChange={(e) => setQDraft(e.target.value)} className={inputClass} />
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}

      {showForm && (
        <VendorForm
          onCreated={() => {
            setShowForm(false);
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {vendors === null && error === null && <LoadingState />}

      {vendors !== null && vendors.length === 0 && !showForm && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">No vendors yet.</p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            Create the first vendor
          </button>
        </div>
      )}

      {vendors !== null && vendors.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[42rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <SortableHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Email" sortKey="email" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Phone" sortKey="phone" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Tax number" sortKey="taxNumber" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Balance due" sortKey="balance" sort={sort} onSort={toggleSort} align="right" />
                <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(paged.pageRows ?? []).map((vendor) => (
                <tr key={vendor.id} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <Link to={vendor.id}>{vendor.name}</Link>
                  </td>
                  <td className="p-3">{vendor.email ?? '—'}</td>
                  <td className="p-3">{vendor.phone ?? '—'}</td>
                  <td className="p-3">{vendor.taxNumber ?? '—'}</td>
                  <td className="p-3 text-right tabular-nums">
                    {balances === null ? '—' : formatCents(balances.get(vendor.id) ?? 0)}
                  </td>
                  <td className="p-3">
                    {vendor.isActive ? (
                      <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Active</span>
                    ) : (
                      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    <button type="button" onClick={() => void toggleActive(vendor)} className="btn btn--ghost">
                      {vendor.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paged.pageRows !== null && (
        <Pagination
          page={paged.page}
          totalPages={paged.totalPages}
          shownCount={paged.pageRows.length}
          totalCount={paged.totalCount}
          noun="vendors"
          onPageChange={paged.setPage}
        />
      )}
    </section>
  );
}
