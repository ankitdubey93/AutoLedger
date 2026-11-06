import { useCallback, useEffect, useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import {
  createPayRun,
  downloadPayRunAba,
  getBankAccountDetails,
  listAccounts,
  listBills,
  listPayRuns,
  listVendorBankDetails,
  saveBankAccountDetails,
  saveVendorBankDetails,
  type Account,
  type BankAccountDetails,
  type Bill,
  type PaymentBatch,
  type VendorBankDetails,
} from '../../services/fetchServices';
import { formatDate, orgToday } from '../../utils/date';
import { formatCents } from '../../utils/money';
import ConfirmDialog from '../../components/ConfirmDialog';
import LoadingState from '../../components/ui/LoadingState';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';

const RECENT_CHANGE_DAYS = 7;

function changedRecently(changedAt: string, now: number = Date.now()): boolean {
  return now - new Date(changedAt).getTime() < RECENT_CHANGE_DAYS * 86_400_000;
}

/** A supplier's account: entered once, and never shown back in full. */
function VendorDetailsForm({ vendorName, onSave }: { vendorName: string; onSave: (body: { bsb: string; accountNumber: string; accountName: string }) => Promise<void> }) {
  const [bsb, setBsb] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState(vendorName.slice(0, 32));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave({ bsb, accountNumber, accountName });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save those details');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--border)] p-3">
      <span className="text-sm font-medium w-full">{vendorName}: bank details needed</span>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">BSB</span>
        <input value={bsb} onChange={(e) => setBsb(e.target.value)} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Account number</span>
        <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} autoComplete="off" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Account name</span>
        <input value={accountName} maxLength={32} onChange={(e) => setAccountName(e.target.value)} className={inputClass} />
      </label>
      <button type="button" className={secondaryButtonClass} disabled={busy || bsb === '' || accountNumber === '' || accountName === ''} onClick={() => void save()}>
        Save
      </button>
      {error !== null && <p className="status status--bad w-full m-0">{error}</p>}
    </div>
  );
}

/** Phase 49g — pick approved expenses, record the payments, download a file for the bank. */
export default function PayRunPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bankAccountId, setBankAccountId] = useState('');
  const [bankDetails, setBankDetails] = useState<BankAccountDetails | null | undefined>(undefined);
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [vendorDetails, setVendorDetails] = useState<VendorBankDetails[]>([]);
  const [batches, setBatches] = useState<PaymentBatch[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [paymentDate, setPaymentDate] = useState(orgToday());
  const [description, setDescription] = useState('Payments');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [newBsb, setNewBsb] = useState('');
  const [newAccount, setNewAccount] = useState('');
  const [newName, setNewName] = useState('');
  const [newInstitution, setNewInstitution] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [newBalancing, setNewBalancing] = useState(false);

  const reload = useCallback(async () => {
    const [billRes, vendorRes, batchRes] = await Promise.all([
      listBills({ status: 'POSTED', settlement: 'OUTSTANDING', limit: 200 }),
      listVendorBankDetails(),
      listPayRuns(),
    ]);
    setBills(billRes.bills.filter((b) => b.currencyCode === 'AUD'));
    setVendorDetails(vendorRes.details);
    setBatches(batchRes.batches);
  }, []);

  useEffect(() => {
    let ignore = false;
    Promise.all([listAccounts(), reload()])
      .then(([accountRes]) => {
        if (ignore) return;
        const banks = accountRes.accounts.filter((a) => a.bankAccountKind === 'BANK' && a.isActive);
        setAccounts(banks);
        setBankAccountId((current) => current || (banks[0]?.id ?? ''));
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the pay run');
      });
    return () => {
      ignore = true;
    };
  }, [reload]);

  useEffect(() => {
    if (bankAccountId === '') return;
    let ignore = false;
    getBankAccountDetails(bankAccountId)
      .then((res) => {
        if (!ignore) setBankDetails(res.details);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load this bank account');
      });
    return () => {
      ignore = true;
    };
  }, [bankAccountId]);

  const chosen = useMemo(() => (bills ?? []).filter((b) => selected.has(b.id)), [bills, selected]);
  const total = chosen.reduce((s, b) => s + b.amountDueCents, 0);
  const detailFor = (vendorId: string) => vendorDetails.find((d) => d.vendorId === vendorId);
  const chosenVendors = [...new Map(chosen.map((b) => [b.vendorId, b.vendorName])).entries()];
  const missing = chosenVendors.filter(([id]) => detailFor(id) === undefined);
  const recentlyChanged = chosenVendors.filter(([id]) => {
    const d = detailFor(id);
    return d !== undefined && changedRecently(d.changedAt);
  });

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveBank() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveBankAccountDetails(bankAccountId, {
        bsb: newBsb,
        accountNumber: newAccount,
        accountName: newName,
        financialInstitution: newInstitution,
        apcaUserId: newUserId,
        selfBalancing: newBalancing,
      });
      setBankDetails(res.details);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save this bank account');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const { batch } = await createPayRun({
        bankAccountId,
        paymentDate,
        description,
        items: chosen.map((b) => ({ billId: b.id, amountCents: b.amountDueCents })),
      });
      setSelected(new Set());
      await reload();
      await downloadPayRunAba(batch.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create this pay run');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        as="h2"
        icon={Send}
        title="Pay run"
        subtitle="Pay several suppliers at once: record the payments here, then upload the ABA file to your bank."
      />

      {error !== null && <p className="status status--bad">{error}</p>}
      {bills === null && error === null && <LoadingState />}

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Pay from</span>
          <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className={inputClass}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Payment date</span>
          <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Description (12 characters)</span>
          <input value={description} maxLength={12} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </label>
      </div>

      {bankDetails === null && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
          <h3 className="section-title m-0">Bank account details</h3>
          <p className="text-sm text-[var(--muted)] m-0">Your bank issues the three-letter code and six-digit user ID when it sets you up for ABA uploads.</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">BSB</span>
              <input value={newBsb} onChange={(e) => setNewBsb(e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Account number</span>
              <input value={newAccount} onChange={(e) => setNewAccount(e.target.value)} autoComplete="off" className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Account name</span>
              <input value={newName} maxLength={32} onChange={(e) => setNewName(e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Bank code</span>
              <input value={newInstitution} maxLength={3} onChange={(e) => setNewInstitution(e.target.value.toUpperCase())} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">User ID</span>
              <input value={newUserId} maxLength={6} onChange={(e) => setNewUserId(e.target.value)} className={inputClass} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={newBalancing} onChange={(e) => setNewBalancing(e.target.checked)} />
              My bank requires a balancing line
            </label>
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void saveBank()}>
              Save bank details
            </button>
          </div>
        </div>
      )}
      {bankDetails !== null && bankDetails !== undefined && (
        <p className="text-sm text-[var(--muted)] m-0">
          BSB {bankDetails.bsb}, account ending {bankDetails.accountNumberLast3}, {bankDetails.financialInstitution} user {bankDetails.apcaUserId}
        </p>
      )}

      {bills !== null && bills.length === 0 && <p className="text-sm text-[var(--muted)] m-0">No approved expenses are waiting to be paid.</p>}
      {bills !== null && bills.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[40rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 w-10" />
                <th className="p-3 font-medium">Vendor</th>
                <th className="p-3 font-medium">Reference</th>
                <th className="p-3 font-medium">Due</th>
                <th className="p-3 font-medium text-right">Amount due</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} aria-label={`Pay ${b.vendorReference}`} />
                  </td>
                  <td className="p-3">{b.vendorName}</td>
                  <td className="p-3">{b.vendorReference}</td>
                  <td className="p-3">{formatDate(b.dueDate)}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(b.amountDueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {missing.map(([vendorId, name]) => (
        <VendorDetailsForm
          key={vendorId}
          vendorName={name}
          onSave={async (body) => {
            const res = await saveVendorBankDetails(vendorId, body);
            setVendorDetails((current) => [...current.filter((d) => d.vendorId !== vendorId), res.details]);
          }}
        />
      ))}

      {recentlyChanged.length > 0 && (
        <p className="status status--warn m-0">
          Bank details changed in the last {RECENT_CHANGE_DAYS} days for {recentlyChanged.map(([, name]) => name).join(', ')}. Confirm them with the supplier by phone before paying: changed bank details are a common payment fraud.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy || chosen.length === 0 || missing.length > 0 || !bankDetails || description.trim() === ''}
          onClick={() => setConfirming(true)}
        >
          Pay {formatCents(total)} and download ABA
        </button>
      </div>

      {batches.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="section-title m-0">Earlier pay runs</h3>
          {batches.map((batch) => (
            <div key={batch.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
              <span>
                {formatDate(batch.paymentDate)}, {batch.description}: {formatCents(batch.totalCents)} to {batch.paymentCount} supplier(s)
              </span>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => {
                  downloadPayRunAba(batch.id).catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : 'Could not download this file');
                  });
                }}
              >
                Download ABA
              </button>
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Record these payments?"
          body={`This records ${formatCents(total)} paid to ${String(chosenVendors.length)} supplier(s) on ${formatDate(paymentDate)}. No money moves until you upload the file to your bank. A pay run you don't go ahead with needs its payments voided.`}
          confirmLabel="Record and download"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void submit()}
        />
      )}
    </section>
  );
}
