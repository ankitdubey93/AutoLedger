import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  createUniteconProductLine,
  deleteUniteconProductLine,
  fetchUniteconProductLines,
  fetchUniteconSettings,
  listAccounts,
  updateUniteconProductLine,
  updateUniteconSettings,
  type Account,
  type UniteconProductLine,
  type UniteconSettings,
} from '../../services/fetchServices';
import { useAuth } from '../../context/AuthContext';
import ConfirmDialog from '../../components/ConfirmDialog';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/**
 * UnitEcon's configuration: the gross-margin assumption LTV uses, which
 * accounts count as customer-acquisition spend for CAC, and the product
 * lines PVM decomposes.
 *
 * Writing settings and deleting a product line need OWNER/ADMIN
 * (grossMarginBps and the acquisition set reprice every LTV and CAC figure
 * in the app; a delete drops a dimension from every historical PVM report).
 * For anyone else those controls are HIDDEN, not merely disabled — the
 * posture ForecasterBudgetPage established.
 */
export default function UniteconSettingsPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN';

  const [settings, setSettings] = useState<UniteconSettings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [productLines, setProductLines] = useState<UniteconProductLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [marginInput, setMarginInput] = useState('70.00');
  const [acquisitionIds, setAcquisitionIds] = useState<string[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);

  const [newProductAccountId, setNewProductAccountId] = useState('');
  const [newProductName, setNewProductName] = useState('');
  const [newProductUnit, setNewProductUnit] = useState('');
  const [creatingProduct, setCreatingProduct] = useState(false);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function reload() {
    setError(null);
    Promise.all([fetchUniteconSettings(), listAccounts(), fetchUniteconProductLines(true)])
      .then(([settingsRes, accountsRes, productLinesRes]) => {
        setSettings(settingsRes.settings);
        setMarginInput((settingsRes.settings.grossMarginBps / 100).toFixed(2));
        setAcquisitionIds(settingsRes.settings.acquisitionAccountIds);
        setAccounts(accountsRes.accounts);
        setProductLines(productLinesRes.productLines);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load settings'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const expenseAccounts = accounts.filter((a) => a.type === 'Expense' && a.isPostable);
  const revenueAccounts = accounts.filter((a) => a.type === 'Revenue' && a.isPostable);

  async function handleSaveSettings() {
    const grossMarginBps = Math.round(Number(marginInput) * 100);
    if (!Number.isFinite(grossMarginBps) || grossMarginBps < 0 || grossMarginBps > 10000) {
      setError('Gross margin must be between 0% and 100%');
      return;
    }
    setSavingSettings(true);
    setError(null);
    try {
      const res = await updateUniteconSettings({ grossMarginBps, acquisitionAccountIds: acquisitionIds });
      setSettings(res.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleCreateProductLine() {
    if (newProductAccountId === '' || newProductName.trim() === '') return;
    setCreatingProduct(true);
    setError(null);
    try {
      await createUniteconProductLine({
        revenueAccountId: newProductAccountId,
        name: newProductName.trim(),
        unitLabel: newProductUnit.trim(),
      });
      setNewProductAccountId('');
      setNewProductName('');
      setNewProductUnit('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create product line');
    } finally {
      setCreatingProduct(false);
    }
  }

  async function handleToggleActive(line: UniteconProductLine) {
    setError(null);
    try {
      await updateUniteconProductLine(line.id, { isActive: !line.isActive });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update product line');
    }
  }

  async function handleConfirmDelete() {
    if (pendingDeleteId === null) return;
    setDeleting(true);
    try {
      await deleteUniteconProductLine(pendingDeleteId);
      setPendingDeleteId(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete product line');
    } finally {
      setDeleting(false);
    }
  }

  const pendingDeleteLine = productLines.find((l) => l.id === pendingDeleteId) ?? null;

  return (
    <section className="flex flex-col gap-8">
      <header>
        <h2 className="text-lg font-semibold m-0">UnitEcon settings</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          The gross-margin assumption, acquisition-spend accounts, and product-line dimensions every report
          reads.
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {settings === null && error === null && <p className="muted">Loading…</p>}

      {settings !== null && canWrite && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-4">
          <h3 className="text-sm font-semibold m-0">Unit economics</h3>

          <label className="flex flex-col gap-1 max-w-xs">
            <span className="text-xs text-[var(--muted)]">Gross margin %</span>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={marginInput}
              onChange={(e) => setMarginInput(e.target.value)}
              className={inputClass}
            />
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-[var(--muted)] px-0">Acquisition-spend accounts (Expense)</legend>
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-[var(--border)] rounded-md p-2">
              {expenseAccounts.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acquisitionIds.includes(a.id)}
                    onChange={(e) =>
                      setAcquisitionIds((prev) =>
                        e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id),
                      )
                    }
                  />
                  {a.code} {a.name}
                </label>
              ))}
              {expenseAccounts.length === 0 && (
                <p className="text-xs text-[var(--muted)] m-0">No Expense accounts found.</p>
              )}
            </div>
          </fieldset>

          <div>
            <button type="button" className="btn" disabled={savingSettings} onClick={handleSaveSettings}>
              {savingSettings ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-4">
        <h3 className="text-sm font-semibold m-0">Product lines</h3>
        <p className="text-xs text-[var(--muted)] m-0">
          Each product line maps one Revenue account to a PVM dimension. There is no SKU-level breakdown —
          PVM decomposes at revenue-account grain.
        </p>

        {canWrite && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">Revenue account</span>
              <select
                value={newProductAccountId}
                onChange={(e) => setNewProductAccountId(e.target.value)}
                className={inputClass}
              >
                <option value="">Select…</option>
                {revenueAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">Name</span>
              <input
                type="text"
                value={newProductName}
                onChange={(e) => setNewProductName(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--muted)]">Unit label</span>
              <input
                type="text"
                value={newProductUnit}
                onChange={(e) => setNewProductUnit(e.target.value)}
                className={inputClass}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={creatingProduct || newProductAccountId === '' || newProductName.trim() === ''}
              onClick={handleCreateProductLine}
            >
              {creatingProduct ? 'Adding…' : 'Add product line'}
            </button>
          </div>
        )}

        {productLines.length === 0 ? (
          <p className="text-sm text-[var(--muted)] m-0">No product lines configured yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-2 font-medium">Account</th>
                <th className="p-2 font-medium">Name</th>
                <th className="p-2 font-medium">Unit</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2 font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {productLines.map((line) => (
                <tr key={line.id} className="border-t border-[var(--border)]">
                  <td className="p-2">
                    {line.revenueAccountCode} {line.revenueAccountName}
                  </td>
                  <td className="p-2">{line.name}</td>
                  <td className="p-2">{line.unitLabel === '' ? '—' : line.unitLabel}</td>
                  <td className="p-2">{line.isActive ? 'Active' : 'Inactive'}</td>
                  <td className="p-2">
                    {canWrite && (
                      <div className="flex items-center gap-2">
                        <button type="button" className="btn btn--ghost" onClick={() => handleToggleActive(line)}>
                          {line.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${line.name}`}
                          className="btn btn--ghost"
                          onClick={() => setPendingDeleteId(line.id)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pendingDeleteLine !== null && (
        <ConfirmDialog
          title="Delete product line?"
          body={
            <>
              Deleting <strong>{pendingDeleteLine.name}</strong> removes this dimension from every historical
              PVM report. This cannot be undone.
            </>
          }
          confirmLabel="Delete"
          tone="danger"
          busy={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </section>
  );
}
