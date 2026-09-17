import { useEffect, useState } from 'react';
import { listAccounts, type Account, type CreateDriveFolderInput, type DriveFolderPurpose } from '../../services/fetchServices';

/**
 * Add-a-folder form for the Drive integration. Purpose decides which app
 * receives the folder's files (driveIntakeDispatcher, server-side); a
 * BANK_STATEMENT folder additionally needs the ledger account and date
 * format bankImportService's own manual form asks for.
 */

export interface DriveFolderFormProps {
  busy: boolean;
  onSubmit: (input: CreateDriveFolderInput) => void;
}

export default function DriveFolderForm({ busy, onSubmit }: DriveFolderFormProps) {
  const [purpose, setPurpose] = useState<DriveFolderPurpose>('VENDOR_BILL');
  const [folder, setFolder] = useState('');
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [ledgerAccountId, setLedgerAccountId] = useState('');
  const [dateFormat, setDateFormat] = useState<'ISO' | 'DMY' | 'MDY'>('ISO');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (purpose !== 'BANK_STATEMENT' || accounts !== null) return;
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts);
      })
      .catch(() => {
        if (!ignore) setAccounts([]);
      });
    return () => {
      ignore = true;
    };
  }, [purpose, accounts]);

  const bankAccounts = (accounts ?? []).filter((a) => a.isPostable && a.type === 'Asset');

  function handleSubmit() {
    setFormError(null);
    if (folder.trim() === '') {
      setFormError('Paste a Google Drive folder link or ID');
      return;
    }
    if (purpose === 'BANK_STATEMENT' && ledgerAccountId === '') {
      setFormError('Choose the bank account this folder\'s statements belong to');
      return;
    }

    onSubmit({
      purpose,
      folder: folder.trim(),
      ledgerAccountId: purpose === 'BANK_STATEMENT' ? ledgerAccountId : null,
      dateFormat: purpose === 'BANK_STATEMENT' ? dateFormat : null,
      columnMap: null,
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">What's in this folder?</span>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="drive-folder-purpose"
              checked={purpose === 'VENDOR_BILL'}
              onChange={() => setPurpose('VENDOR_BILL')}
            />
            Vendor bills (AP-Flow)
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="drive-folder-purpose"
              checked={purpose === 'BANK_STATEMENT'}
              onChange={() => setPurpose('BANK_STATEMENT')}
            />
            Bank statements (LedgerCore)
          </label>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Google Drive folder link</span>
        <input
          type="text"
          placeholder="Paste a Google Drive folder link"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          className="bg-[var(--panel)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
        />
      </label>

      {purpose === 'BANK_STATEMENT' && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Bank account</span>
            <select
              value={ledgerAccountId}
              onChange={(e) => setLedgerAccountId(e.target.value)}
              className="bg-[var(--panel)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
            >
              <option value="">Choose an account…</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Statement date format</span>
            <select
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value as 'ISO' | 'DMY' | 'MDY')}
              className="bg-[var(--panel)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] max-w-[10rem]"
            >
              <option value="ISO">ISO (2026-06-01)</option>
              <option value="DMY">DMY (01/06/2026)</option>
              <option value="MDY">MDY (06/01/2026)</option>
            </select>
          </label>
        </>
      )}

      {formError !== null && <p className="status status--bad">{formError}</p>}

      <button type="button" disabled={busy} onClick={handleSubmit} className="btn self-start">
        Add folder
      </button>
    </div>
  );
}
