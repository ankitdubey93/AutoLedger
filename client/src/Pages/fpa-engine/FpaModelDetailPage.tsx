import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { GitCompareArrows, LineChart, Star, Trash2 } from 'lucide-react';
import {
  deleteFpaAssumption,
  deleteFpaModel,
  deleteFpaScenario,
  getFpaModel,
  listAccounts,
  listFpaAssumptions,
  updateFpaModel,
  updateFpaScenario,
  upsertFpaAssumption,
  createFpaScenario,
  type Account,
  type FpaAssumption,
  type FpaAssumptionKind,
  type FpaModelDetail,
  type FpaModelStatus,
  type FpaScenario,
  type FpaScenarioKind,
} from '../../services/fetchServices';
import { formatRate, parseRateInput, parseCentsInput, formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/** DRAFT <-> ACTIVE <-> ARCHIVED, ARCHIVED -> ACTIVE. Mirrors FPA_MODEL_TRANSITIONS. */
function nextStatuses(status: FpaModelStatus): FpaModelStatus[] {
  if (status === 'DRAFT') return ['ACTIVE', 'ARCHIVED'];
  if (status === 'ACTIVE') return ['DRAFT', 'ARCHIVED'];
  return ['ACTIVE']; // ARCHIVED
}

export default function FpaModelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [model, setModel] = useState<FpaModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingDeleteModel, setPendingDeleteModel] = useState(false);
  const [deletingModel, setDeletingModel] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [assumptions, setAssumptions] = useState<FpaAssumption[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [pendingDeleteScenario, setPendingDeleteScenario] = useState<FpaScenario | null>(null);
  const [pendingDeleteAssumption, setPendingDeleteAssumption] = useState<FpaAssumption | null>(null);

  const [showScenarioForm, setShowScenarioForm] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioKind, setScenarioKind] = useState<FpaScenarioKind>('CUSTOM');
  const [scenarioDso, setScenarioDso] = useState('0');
  const [scenarioDpo, setScenarioDpo] = useState('0');
  const [scenarioTax, setScenarioTax] = useState('0');
  const [scenarioBusy, setScenarioBusy] = useState(false);

  const [assumptionAccountId, setAssumptionAccountId] = useState('');
  const [assumptionKind, setAssumptionKind] = useState<FpaAssumptionKind>('GROWTH_BPS');
  const [assumptionValue, setAssumptionValue] = useState('');
  const [assumptionBusy, setAssumptionBusy] = useState(false);

  useEffect(() => {
    if (id === undefined) return;
    let ignore = false;
    getFpaModel(id)
      .then((res) => {
        if (ignore) return;
        setModel(res.model);
        setSelectedScenarioId((current) => current ?? res.model.scenarios.find((s) => s.isDefault)?.id ?? res.model.scenarios[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the model');
      });
    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts.filter((a) => a.isPostable && a.isActive && (a.type === 'Revenue' || a.type === 'Expense')));
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [id, reloadToken]);

  useEffect(() => {
    if (selectedScenarioId === null) return;
    let ignore = false;
    setAssumptions(null);
    listFpaAssumptions(selectedScenarioId)
      .then((res) => {
        if (!ignore) setAssumptions(res.assumptions);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load assumptions');
      });
    return () => {
      ignore = true;
    };
  }, [selectedScenarioId, reloadToken]);

  if (id === undefined) return null;

  async function handleStatusChange(status: FpaModelStatus) {
    if (id === undefined) return;
    setStatusBusy(true);
    try {
      await updateFpaModel(id, { status });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change status');
    } finally {
      setStatusBusy(false);
    }
  }

  async function confirmDeleteModel() {
    if (id === undefined) return;
    setDeletingModel(true);
    try {
      await deleteFpaModel(id);
      navigate(base);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the model');
      setDeletingModel(false);
      setPendingDeleteModel(false);
    }
  }

  async function handleSetDefault(scenarioId: string) {
    try {
      await updateFpaScenario(scenarioId, { isDefault: true });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not set the default scenario');
    }
  }

  async function confirmDeleteScenario() {
    if (pendingDeleteScenario === null) return;
    try {
      await deleteFpaScenario(pendingDeleteScenario.id);
      setPendingDeleteScenario(null);
      if (selectedScenarioId === pendingDeleteScenario.id) setSelectedScenarioId(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the scenario');
      setPendingDeleteScenario(null);
    }
  }

  async function handleCreateScenario(event: React.FormEvent) {
    event.preventDefault();
    if (id === undefined) return;
    setScenarioBusy(true);
    try {
      await createFpaScenario(id, {
        name: scenarioName,
        kind: scenarioKind,
        dsoDays: Number(scenarioDso),
        dpoDays: Number(scenarioDpo),
        taxRateBps: parseRateInput(scenarioTax) ?? 0,
      });
      setShowScenarioForm(false);
      setScenarioName('');
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the scenario');
    } finally {
      setScenarioBusy(false);
    }
  }

  async function handleUpsertAssumption(event: React.FormEvent) {
    event.preventDefault();
    if (selectedScenarioId === null || assumptionAccountId === '') return;
    setAssumptionBusy(true);
    try {
      if (assumptionKind === 'GROWTH_BPS') {
        const bps = parseRateInput(assumptionValue);
        if (bps === null) throw new Error('Enter a growth rate, e.g. 5.00 for 5%');
        await upsertFpaAssumption(selectedScenarioId, assumptionAccountId, { kind: 'GROWTH_BPS', growthBps: bps });
      } else if (assumptionKind === 'FIXED_CENTS') {
        const cents = parseCentsInput(assumptionValue);
        if (cents === null) throw new Error('Enter a fixed amount, e.g. 2500.00');
        await upsertFpaAssumption(selectedScenarioId, assumptionAccountId, { kind: 'FIXED_CENTS', fixedCents: cents });
      } else {
        const bps = parseRateInput(assumptionValue);
        if (bps === null) throw new Error('Enter a percentage, e.g. 30.00 for 30%');
        await upsertFpaAssumption(selectedScenarioId, assumptionAccountId, {
          kind: 'PERCENT_OF_REVENUE_BPS',
          percentOfRevenueBps: bps,
        });
      }
      setAssumptionValue('');
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the assumption');
    } finally {
      setAssumptionBusy(false);
    }
  }

  async function confirmDeleteAssumption() {
    if (pendingDeleteAssumption === null || selectedScenarioId === null) return;
    try {
      await deleteFpaAssumption(selectedScenarioId, pendingDeleteAssumption.accountId);
      setPendingDeleteAssumption(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the assumption');
      setPendingDeleteAssumption(null);
    }
  }

  if (model === null) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={base} label="Back to models" />
        {error !== null ? <p className="status status--bad">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={base} label="Back to models" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{model.name}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {model.status} · starts {model.startsOn} · {model.horizonMonths} month horizon · actuals through{' '}
            {model.actualsThrough}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`${base}/compare/${model.id}`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline border border-[var(--border)] text-[var(--text)]"
          >
            <GitCompareArrows size={15} aria-hidden="true" /> Compare scenarios
          </Link>
          {nextStatuses(model.status).map((next) => (
            <button
              key={next}
              type="button"
              disabled={statusBusy}
              onClick={() => void handleStatusChange(next)}
              className="btn btn--ghost"
            >
              {next === 'ACTIVE' ? 'Activate' : next === 'ARCHIVED' ? 'Archive' : 'Set to Draft'}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPendingDeleteModel(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-rose-500/10 text-rose-400"
          >
            <Trash2 size={15} aria-hidden="true" /> Delete
          </button>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[44rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Scenario</th>
              <th className="p-3 font-medium">Kind</th>
              <th className="p-3 font-medium">DSO</th>
              <th className="p-3 font-medium">DPO</th>
              <th className="p-3 font-medium">Tax rate</th>
              <th className="p-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {model.scenarios.map((scenario) => (
              <tr
                key={scenario.id}
                className={[
                  'border-t border-[var(--border)]',
                  scenario.id === selectedScenarioId ? 'bg-[var(--bg)]' : '',
                ].join(' ')}
              >
                <td className="p-3">
                  <button
                    type="button"
                    onClick={() => setSelectedScenarioId(scenario.id)}
                    className="border-0 bg-transparent cursor-pointer p-0 text-[var(--text)] font-medium flex items-center gap-1.5"
                  >
                    {scenario.isDefault && <Star size={13} aria-hidden="true" className="text-amber-400" />}
                    {scenario.name}
                  </button>
                </td>
                <td className="p-3 text-[var(--muted)]">{scenario.kind}</td>
                <td className="p-3">{scenario.dsoDays}d</td>
                <td className="p-3">{scenario.dpoDays}d</td>
                <td className="p-3">{formatRate(scenario.taxRateBps)}%</td>
                <td className="p-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      to={`${base}/scenarios/${scenario.id}`}
                      className="flex items-center gap-1 text-xs no-underline text-[var(--text)]"
                    >
                      <LineChart size={13} aria-hidden="true" /> Projection
                    </Link>
                    {!scenario.isDefault && (
                      <button type="button" onClick={() => void handleSetDefault(scenario.id)} className="btn btn--ghost">
                        Set default
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={scenario.isDefault}
                      onClick={() => setPendingDeleteScenario(scenario)}
                      className="btn btn--ghost disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        {!showScenarioForm ? (
          <button type="button" onClick={() => setShowScenarioForm(true)} className="btn btn--ghost">
            Add scenario
          </button>
        ) : (
          <form
            onSubmit={(e) => void handleCreateScenario(e)}
            className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 max-w-md"
          >
            <h3 className="text-sm font-semibold m-0">New scenario</h3>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Name</span>
              <input
                type="text"
                required
                value={scenarioName}
                onChange={(e) => setScenarioName(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Kind</span>
              <select
                value={scenarioKind}
                onChange={(e) => setScenarioKind(e.target.value as FpaScenarioKind)}
                className={inputClass}
              >
                <option value="UPSIDE">Upside</option>
                <option value="DOWNSIDE">Downside</option>
                <option value="CUSTOM">Custom</option>
              </select>
            </label>
            <div className="flex gap-3">
              <label className="flex flex-col gap-1 text-sm flex-1">
                <span className="text-[var(--muted)]">DSO days</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={scenarioDso}
                  onChange={(e) => setScenarioDso(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm flex-1">
                <span className="text-[var(--muted)]">DPO days</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={scenarioDpo}
                  onChange={(e) => setScenarioDpo(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm flex-1">
                <span className="text-[var(--muted)]">Tax rate %</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={scenarioTax}
                  onChange={(e) => setScenarioTax(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={scenarioBusy || scenarioName.trim() === ''}
                className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
              >
                {scenarioBusy ? 'Saving…' : 'Save scenario'}
              </button>
              <button type="button" onClick={() => setShowScenarioForm(false)} className="btn btn--ghost">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {selectedScenarioId !== null && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold m-0">Assumptions</h3>
          <p className="text-xs text-[var(--muted)] m-0">
            An account with no assumption below flat-lines its last posted actual for the whole horizon.
          </p>

          {assumptions === null && <p className="muted">Loading…</p>}

          {assumptions !== null && assumptions.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[36rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Account</th>
                    <th className="p-3 font-medium">Kind</th>
                    <th className="p-3 font-medium">Value</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assumptions.map((a) => (
                    <tr key={a.id} className="border-t border-[var(--border)]">
                      <td className="p-3">
                        {a.accountCode} {a.accountName}
                      </td>
                      <td className="p-3 text-[var(--muted)]">{a.kind}</td>
                      <td className="p-3 font-mono">
                        {a.kind === 'GROWTH_BPS' && `${formatRate(a.growthBps ?? 0)}%`}
                        {a.kind === 'FIXED_CENTS' && formatCents(a.fixedCents ?? 0)}
                        {a.kind === 'PERCENT_OF_REVENUE_BPS' && `${formatRate(a.percentOfRevenueBps ?? 0)}%`}
                      </td>
                      <td className="p-3 text-right">
                        <button type="button" onClick={() => setPendingDeleteAssumption(a)} className="btn btn--ghost">
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form
            onSubmit={(e) => void handleUpsertAssumption(e)}
            className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
          >
            <label className="flex flex-col gap-1 text-sm min-w-48">
              <span className="text-[var(--muted)]">Account</span>
              <select
                required
                value={assumptionAccountId}
                onChange={(e) => setAssumptionAccountId(e.target.value)}
                className={inputClass}
              >
                <option value="" disabled>
                  Select an account
                </option>
                {(accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-40">
              <span className="text-[var(--muted)]">Kind</span>
              <select
                value={assumptionKind}
                onChange={(e) => setAssumptionKind(e.target.value as FpaAssumptionKind)}
                className={inputClass}
              >
                <option value="GROWTH_BPS">Growth %/month</option>
                <option value="FIXED_CENTS">Fixed amount</option>
                <option value="PERCENT_OF_REVENUE_BPS">% of revenue</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-32">
              <span className="text-[var(--muted)]">
                {assumptionKind === 'FIXED_CENTS' ? 'Amount' : 'Percentage'}
              </span>
              <input
                type="text"
                required
                inputMode="decimal"
                placeholder={assumptionKind === 'FIXED_CENTS' ? '2500.00' : '5.00'}
                value={assumptionValue}
                onChange={(e) => setAssumptionValue(e.target.value)}
                className={inputClass}
              />
            </label>
            <button
              type="submit"
              disabled={assumptionBusy || assumptionAccountId === '' || assumptionValue.trim() === ''}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              {assumptionBusy ? 'Saving…' : 'Save assumption'}
            </button>
          </form>
        </div>
      )}

      {pendingDeleteModel && (
        <ConfirmDialog
          title="Delete this model?"
          body={<p className="m-0">{model.name} and every one of its scenarios and assumptions will be removed.</p>}
          confirmLabel="Delete"
          tone="danger"
          busy={deletingModel}
          onConfirm={() => void confirmDeleteModel()}
          onCancel={() => setPendingDeleteModel(false)}
        />
      )}

      {pendingDeleteScenario !== null && (
        <ConfirmDialog
          title="Delete this scenario?"
          body={<p className="m-0">{pendingDeleteScenario.name} and its assumptions will be removed.</p>}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => void confirmDeleteScenario()}
          onCancel={() => setPendingDeleteScenario(null)}
        />
      )}

      {pendingDeleteAssumption !== null && (
        <ConfirmDialog
          title="Delete this assumption?"
          body={
            <p className="m-0">
              {pendingDeleteAssumption.accountCode} {pendingDeleteAssumption.accountName} will flat-line its last
              posted actual instead.
            </p>
          }
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => void confirmDeleteAssumption()}
          onCancel={() => setPendingDeleteAssumption(null)}
        />
      )}
    </section>
  );
}
