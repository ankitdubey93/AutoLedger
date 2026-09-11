import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { LineChart, ListChecks, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import {
  createForecasterDriver,
  createForecasterForecastLine,
  createForecasterHeadcountRole,
  deleteForecasterDriver,
  deleteForecasterForecastLine,
  deleteForecasterHeadcountRole,
  deleteForecasterPlan,
  getForecasterPlan,
  listAccounts,
  listForecasterDriverValues,
  listForecasterDrivers,
  listForecasterForecastLines,
  listForecasterHeadcountRoles,
  rollForecasterPlan,
  setForecasterDriverValues,
  updateForecasterPlan,
  type Account,
  type ForecasterCreateLineBody,
  type ForecasterDriver,
  type ForecasterDriverKind,
  type ForecasterDriverValue,
  type ForecasterForecastLine,
  type ForecasterHeadcountRole,
  type ForecasterLineKind,
  type ForecasterPlan,
  type ForecasterPlanStatus,
} from '../../services/fetchServices';
import { formatCents, parseCentsInput, parseRateInput, formatRate } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/** DRAFT <-> ACTIVE <-> ARCHIVED, ARCHIVED -> ACTIVE. Mirrors FORECASTER_PLAN_TRANSITIONS. */
function nextStatuses(status: ForecasterPlanStatus): ForecasterPlanStatus[] {
  if (status === 'DRAFT') return ['ACTIVE', 'ARCHIVED'];
  if (status === 'ACTIVE') return ['DRAFT', 'ARCHIVED'];
  return ['ACTIVE']; // ARCHIVED
}

/** The plan's month starts, 'YYYY-MM-01', built with Date.UTC — mirrors planService.planMonths. */
function planMonthList(startsOn: string, horizonMonths: number): string[] {
  const [yearStr, monthStr] = startsOn.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const months: string[] = [];
  for (let k = 0; k < horizonMonths; k++) {
    const d = new Date(Date.UTC(year, month - 1 + k, 1));
    months.push(d.toISOString().slice(0, 10));
  }
  return months;
}

export default function ForecasterPlanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [plan, setPlan] = useState<ForecasterPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [statusBusy, setStatusBusy] = useState(false);
  const [pendingDeletePlan, setPendingDeletePlan] = useState(false);
  const [deletingPlan, setDeletingPlan] = useState(false);
  const [pendingRoll, setPendingRoll] = useState(false);
  const [rolling, setRolling] = useState(false);

  const [drivers, setDrivers] = useState<ForecasterDriver[] | null>(null);
  const [driverValues, setDriverValues] = useState<Record<string, ForecasterDriverValue[]>>({});
  const [roles, setRoles] = useState<ForecasterHeadcountRole[] | null>(null);
  const [lines, setLines] = useState<ForecasterForecastLine[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);

  const [showDriverForm, setShowDriverForm] = useState(false);
  const [driverName, setDriverName] = useState('');
  const [driverUnitLabel, setDriverUnitLabel] = useState('');
  const [driverKind, setDriverKind] = useState<ForecasterDriverKind>('COUNT');
  const [driverBusy, setDriverBusy] = useState(false);
  const [pendingDeleteDriver, setPendingDeleteDriver] = useState<ForecasterDriver | null>(null);
  const [gridDrafts, setGridDrafts] = useState<Record<string, Record<string, string>>>({});
  const [gridSaving, setGridSaving] = useState<string | null>(null);

  const [showRoleForm, setShowRoleForm] = useState(false);
  const [roleTitle, setRoleTitle] = useState('');
  const [roleAccountId, setRoleAccountId] = useState('');
  const [roleStartsOnMonth, setRoleStartsOnMonth] = useState('');
  const [roleEndsOnMonth, setRoleEndsOnMonth] = useState('');
  const [roleFteCount, setRoleFteCount] = useState('1');
  const [roleAnnualSalary, setRoleAnnualSalary] = useState('');
  const [roleLoadingBps, setRoleLoadingBps] = useState('0');
  const [roleBusy, setRoleBusy] = useState(false);
  const [pendingDeleteRole, setPendingDeleteRole] = useState<ForecasterHeadcountRole | null>(null);

  const [showLineForm, setShowLineForm] = useState(false);
  const [lineLabel, setLineLabel] = useState('');
  const [lineAccountId, setLineAccountId] = useState('');
  const [lineKind, setLineKind] = useState<ForecasterLineKind>('DRIVER_PRODUCT');
  const [lineQuantityDriverId, setLineQuantityDriverId] = useState('');
  const [lineRateDriverId, setLineRateDriverId] = useState('');
  const [lineSourceDriverId, setLineSourceDriverId] = useState('');
  const [linePercentBps, setLinePercentBps] = useState('');
  const [lineFixedCents, setLineFixedCents] = useState('');
  const [lineBusy, setLineBusy] = useState(false);
  const [pendingDeleteLine, setPendingDeleteLine] = useState<ForecasterForecastLine | null>(null);

  useEffect(() => {
    if (id === undefined) return;
    let ignore = false;

    getForecasterPlan(id)
      .then((res) => {
        if (!ignore) setPlan(res.plan);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the plan');
      });

    listForecasterDrivers(id)
      .then((res) => {
        if (ignore) return;
        setDrivers(res.drivers);
        Promise.all(res.drivers.map((d) => listForecasterDriverValues(d.id)))
          .then((all) => {
            if (ignore) return;
            const map: Record<string, ForecasterDriverValue[]> = {};
            res.drivers.forEach((d, i) => {
              map[d.id] = all[i]?.values ?? [];
            });
            setDriverValues(map);
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);

    listForecasterHeadcountRoles(id)
      .then((res) => {
        if (!ignore) setRoles(res.roles);
      })
      .catch(() => undefined);

    listForecasterForecastLines(id)
      .then((res) => {
        if (!ignore) setLines(res.lines);
      })
      .catch(() => undefined);

    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts.filter((a) => a.isPostable && a.isActive));
      })
      .catch(() => undefined);

    return () => {
      ignore = true;
    };
  }, [id, reloadToken]);

  if (id === undefined) return null;

  async function handleStatusChange(status: ForecasterPlanStatus) {
    if (id === undefined) return;
    setStatusBusy(true);
    try {
      await updateForecasterPlan(id, { status });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change status');
    } finally {
      setStatusBusy(false);
    }
  }

  async function confirmDeletePlan() {
    if (id === undefined) return;
    setDeletingPlan(true);
    try {
      await deleteForecasterPlan(id);
      navigate(base);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the plan');
      setDeletingPlan(false);
      setPendingDeletePlan(false);
    }
  }

  async function confirmRoll() {
    if (id === undefined) return;
    setRolling(true);
    try {
      await rollForecasterPlan(id);
      setPendingRoll(false);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not roll the plan forward');
    } finally {
      setRolling(false);
    }
  }

  async function handleCreateDriver(event: React.FormEvent) {
    event.preventDefault();
    if (id === undefined) return;
    setDriverBusy(true);
    try {
      await createForecasterDriver(id, { name: driverName, unitLabel: driverUnitLabel, kind: driverKind });
      setShowDriverForm(false);
      setDriverName('');
      setDriverUnitLabel('');
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the driver');
    } finally {
      setDriverBusy(false);
    }
  }

  async function confirmDeleteDriver() {
    if (pendingDeleteDriver === null) return;
    try {
      await deleteForecasterDriver(pendingDeleteDriver.id);
      setPendingDeleteDriver(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the driver');
      setPendingDeleteDriver(null);
    }
  }

  async function handleSaveDriverValues(driver: ForecasterDriver, months: string[]) {
    const drafts = gridDrafts[driver.id] ?? {};
    const values = months
      .filter((m) => (drafts[m] ?? '').trim() !== '')
      .map((m) => {
        const raw = drafts[m] ?? '0';
        const parsed = driver.kind === 'CENTS' ? parseCentsInput(raw) : Number(raw);
        return { month: m, value: parsed ?? 0 };
      });
    if (values.length === 0) return;
    setGridSaving(driver.id);
    try {
      await setForecasterDriverValues(driver.id, values);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save driver values');
    } finally {
      setGridSaving(null);
    }
  }

  async function handleCreateRole(event: React.FormEvent) {
    event.preventDefault();
    if (id === undefined) return;
    setRoleBusy(true);
    try {
      const salaryCents = parseCentsInput(roleAnnualSalary);
      if (salaryCents === null || salaryCents < 0) throw new Error('Enter an annual salary, e.g. 120000.00');
      const loadingBps = parseRateInput(roleLoadingBps) ?? 0;
      await createForecasterHeadcountRole(id, {
        title: roleTitle,
        department: null,
        accountId: roleAccountId,
        startsOn: `${roleStartsOnMonth}-01`,
        endsOn: roleEndsOnMonth === '' ? null : `${roleEndsOnMonth}-01`,
        fteCount: Number(roleFteCount),
        annualSalaryCents: salaryCents,
        loadingBps,
      });
      setShowRoleForm(false);
      setRoleTitle('');
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the role');
    } finally {
      setRoleBusy(false);
    }
  }

  async function confirmDeleteRole() {
    if (pendingDeleteRole === null) return;
    try {
      await deleteForecasterHeadcountRole(pendingDeleteRole.id);
      setPendingDeleteRole(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the role');
      setPendingDeleteRole(null);
    }
  }

  async function handleCreateLine(event: React.FormEvent) {
    event.preventDefault();
    if (id === undefined) return;
    setLineBusy(true);
    try {
      let body: ForecasterCreateLineBody;
      if (lineKind === 'DRIVER_PRODUCT') {
        body = {
          kind: 'DRIVER_PRODUCT',
          accountId: lineAccountId,
          label: lineLabel,
          quantityDriverId: lineQuantityDriverId,
          rateDriverId: lineRateDriverId,
        };
      } else if (lineKind === 'DRIVER_PERCENT') {
        const percentBps = parseRateInput(linePercentBps);
        if (percentBps === null) throw new Error('Enter a percentage, e.g. 5.00 for 5%');
        body = {
          kind: 'DRIVER_PERCENT',
          accountId: lineAccountId,
          label: lineLabel,
          sourceDriverId: lineSourceDriverId,
          percentBps,
        };
      } else {
        const fixedCents = parseCentsInput(lineFixedCents);
        if (fixedCents === null) throw new Error('Enter an amount, e.g. 750.00');
        body = { kind: 'FIXED_CENTS', accountId: lineAccountId, label: lineLabel, fixedCents };
      }
      await createForecasterForecastLine(id, body);
      setShowLineForm(false);
      setLineLabel('');
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the forecast line');
    } finally {
      setLineBusy(false);
    }
  }

  async function confirmDeleteLine() {
    if (pendingDeleteLine === null) return;
    try {
      await deleteForecasterForecastLine(pendingDeleteLine.id);
      setPendingDeleteLine(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the forecast line');
      setPendingDeleteLine(null);
    }
  }

  if (plan === null) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={base} label="Back to plans" />
        {error !== null ? <p className="status status--bad">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const months = planMonthList(plan.startsOn, plan.horizonMonths);
  const revenueExpenseAccounts = (accounts ?? []).filter((a) => a.type === 'Revenue' || a.type === 'Expense');
  const expenseAccounts = (accounts ?? []).filter((a) => a.type === 'Expense');
  const countDrivers = (drivers ?? []).filter((d) => d.kind === 'COUNT');
  const centsDrivers = (drivers ?? []).filter((d) => d.kind === 'CENTS');

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={base} label="Back to plans" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{plan.name}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {plan.status} · starts {plan.startsOn} · {plan.horizonMonths} month horizon · actuals through{' '}
            {plan.actualsThrough}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`${base}/plans/${plan.id}/forecast`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline border border-[var(--border)] text-[var(--text)]"
          >
            <LineChart size={15} aria-hidden="true" /> Forecast
          </Link>
          <Link
            to={`${base}/plans/${plan.id}/budget`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline border border-[var(--border)] text-[var(--text)]"
          >
            <ListChecks size={15} aria-hidden="true" /> Budget
          </Link>
          <Link
            to={`${base}/plans/${plan.id}/variance`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline border border-[var(--border)] text-[var(--text)]"
          >
            <ScrollText size={15} aria-hidden="true" /> Variance
          </Link>
          <button
            type="button"
            disabled={plan.status === 'ARCHIVED'}
            onClick={() => setPendingRoll(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw size={15} aria-hidden="true" /> Roll forward
          </button>
          {nextStatuses(plan.status).map((next) => (
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
            onClick={() => setPendingDeletePlan(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-rose-500/10 text-rose-400"
          >
            <Trash2 size={15} aria-hidden="true" /> Delete
          </button>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {/* ---------------------------------------------------------- Drivers */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold m-0">Drivers</h3>
        {drivers === null && <p className="muted">Loading…</p>}
        {drivers !== null && drivers.length > 0 && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium sticky left-0 bg-[var(--panel)]">Driver</th>
                  {months.map((m) => (
                    <th key={m} className="p-2 font-medium text-right whitespace-nowrap">
                      {m.slice(0, 7)}
                    </th>
                  ))}
                  <th className="p-2 font-medium text-right">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((driver) => {
                  const existing = new Map((driverValues[driver.id] ?? []).map((v) => [v.month, v.value]));
                  return (
                    <tr key={driver.id} className="border-t border-[var(--border)]">
                      <td className="p-3 sticky left-0 bg-inherit whitespace-nowrap">
                        <div className="font-medium">{driver.name}</div>
                        <div className="text-xs text-[var(--muted)]">
                          {driver.kind} {driver.unitLabel !== '' && `· ${driver.unitLabel}`}
                        </div>
                      </td>
                      {months.map((m) => (
                        <td key={m} className="p-1.5 text-right">
                          <input
                            type="text"
                            inputMode="decimal"
                            defaultValue={existing.has(m) ? String(existing.get(m)) : ''}
                            onChange={(e) =>
                              setGridDrafts((prev) => ({
                                ...prev,
                                [driver.id]: { ...(prev[driver.id] ?? {}), [m]: e.target.value },
                              }))
                            }
                            className="w-24 bg-[var(--bg)] border border-[var(--border)] rounded px-1.5 py-1 text-xs text-right"
                          />
                        </td>
                      ))}
                      <td className="p-2 text-right">
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            type="button"
                            disabled={gridSaving === driver.id}
                            onClick={() => void handleSaveDriverValues(driver, months)}
                            className="btn btn--ghost"
                          >
                            {gridSaving === driver.id ? '…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteDriver(driver)}
                            className="btn btn--ghost"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!showDriverForm ? (
          <button type="button" onClick={() => setShowDriverForm(true)} className="btn btn--ghost w-fit">
            Add driver
          </button>
        ) : (
          <form
            onSubmit={(e) => void handleCreateDriver(e)}
            className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
          >
            <label className="flex flex-col gap-1 text-sm min-w-40">
              <span className="text-[var(--muted)]">Name</span>
              <input
                type="text"
                required
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-32">
              <span className="text-[var(--muted)]">Unit label</span>
              <input
                type="text"
                value={driverUnitLabel}
                onChange={(e) => setDriverUnitLabel(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-32">
              <span className="text-[var(--muted)]">Kind</span>
              <select
                value={driverKind}
                onChange={(e) => setDriverKind(e.target.value as ForecasterDriverKind)}
                className={inputClass}
              >
                <option value="COUNT">Count</option>
                <option value="CENTS">Cents</option>
                <option value="BPS">Basis points</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={driverBusy || driverName.trim() === ''}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              {driverBusy ? 'Saving…' : 'Save driver'}
            </button>
            <button type="button" onClick={() => setShowDriverForm(false)} className="btn btn--ghost">
              Cancel
            </button>
          </form>
        )}
      </div>

      {/* ---------------------------------------------------------- Headcount */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold m-0">Headcount roles</h3>
        {roles === null && <p className="muted">Loading…</p>}
        {roles !== null && roles.length > 0 && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[44rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Title</th>
                  <th className="p-3 font-medium">Account</th>
                  <th className="p-3 font-medium">Starts</th>
                  <th className="p-3 font-medium">Ends</th>
                  <th className="p-3 font-medium">FTE</th>
                  <th className="p-3 font-medium">Annual salary</th>
                  <th className="p-3 font-medium">Loading</th>
                  <th className="p-3 font-medium text-right">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id} className="border-t border-[var(--border)]">
                    <td className="p-3">{role.title}</td>
                    <td className="p-3 text-[var(--muted)]">
                      {role.accountCode} {role.accountName}
                    </td>
                    <td className="p-3">{role.startsOn}</td>
                    <td className="p-3">{role.endsOn ?? '—'}</td>
                    <td className="p-3">{role.fteCount}</td>
                    <td className="p-3 font-mono">{formatCents(role.annualSalaryCents)}</td>
                    <td className="p-3">{formatRate(role.loadingBps)}%</td>
                    <td className="p-3 text-right">
                      <button type="button" onClick={() => setPendingDeleteRole(role)} className="btn btn--ghost">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!showRoleForm ? (
          <button type="button" onClick={() => setShowRoleForm(true)} className="btn btn--ghost w-fit">
            Add role
          </button>
        ) : (
          <form
            onSubmit={(e) => void handleCreateRole(e)}
            className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
          >
            <label className="flex flex-col gap-1 text-sm min-w-40">
              <span className="text-[var(--muted)]">Title</span>
              <input
                type="text"
                required
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-48">
              <span className="text-[var(--muted)]">Expense account</span>
              <select
                required
                value={roleAccountId}
                onChange={(e) => setRoleAccountId(e.target.value)}
                className={inputClass}
              >
                <option value="" disabled>
                  Select an account
                </option>
                {expenseAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-32">
              <span className="text-[var(--muted)]">Starts</span>
              <input
                type="month"
                required
                value={roleStartsOnMonth}
                onChange={(e) => setRoleStartsOnMonth(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-32">
              <span className="text-[var(--muted)]">Ends (optional)</span>
              <input
                type="month"
                value={roleEndsOnMonth}
                onChange={(e) => setRoleEndsOnMonth(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-20">
              <span className="text-[var(--muted)]">FTE</span>
              <input
                type="number"
                min={1}
                max={1000}
                value={roleFteCount}
                onChange={(e) => setRoleFteCount(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-32">
              <span className="text-[var(--muted)]">Annual salary</span>
              <input
                type="text"
                required
                inputMode="decimal"
                placeholder="120000.00"
                value={roleAnnualSalary}
                onChange={(e) => setRoleAnnualSalary(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-28">
              <span className="text-[var(--muted)]">Loading %</span>
              <input
                type="text"
                inputMode="decimal"
                value={roleLoadingBps}
                onChange={(e) => setRoleLoadingBps(e.target.value)}
                className={inputClass}
              />
            </label>
            <button
              type="submit"
              disabled={roleBusy || roleTitle.trim() === '' || roleAccountId === '' || roleStartsOnMonth === ''}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              {roleBusy ? 'Saving…' : 'Save role'}
            </button>
            <button type="button" onClick={() => setShowRoleForm(false)} className="btn btn--ghost">
              Cancel
            </button>
          </form>
        )}
      </div>

      {/* ---------------------------------------------------------- Forecast lines */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold m-0">Forecast lines</h3>
        {lines === null && <p className="muted">Loading…</p>}
        {lines !== null && lines.length > 0 && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[40rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Label</th>
                  <th className="p-3 font-medium">Account</th>
                  <th className="p-3 font-medium">Kind</th>
                  <th className="p-3 font-medium text-right">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-t border-[var(--border)]">
                    <td className="p-3">{line.label}</td>
                    <td className="p-3 text-[var(--muted)]">
                      {line.accountCode} {line.accountName}
                    </td>
                    <td className="p-3">{line.kind}</td>
                    <td className="p-3 text-right">
                      <button type="button" onClick={() => setPendingDeleteLine(line)} className="btn btn--ghost">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!showLineForm ? (
          <button type="button" onClick={() => setShowLineForm(true)} className="btn btn--ghost w-fit">
            Add forecast line
          </button>
        ) : (
          <form
            onSubmit={(e) => void handleCreateLine(e)}
            className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
          >
            <label className="flex flex-col gap-1 text-sm min-w-40">
              <span className="text-[var(--muted)]">Label</span>
              <input
                type="text"
                required
                value={lineLabel}
                onChange={(e) => setLineLabel(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-48">
              <span className="text-[var(--muted)]">Account</span>
              <select
                required
                value={lineAccountId}
                onChange={(e) => setLineAccountId(e.target.value)}
                className={inputClass}
              >
                <option value="" disabled>
                  Select an account
                </option>
                {revenueExpenseAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm min-w-40">
              <span className="text-[var(--muted)]">Kind</span>
              <select
                value={lineKind}
                onChange={(e) => setLineKind(e.target.value as ForecasterLineKind)}
                className={inputClass}
              >
                <option value="DRIVER_PRODUCT">Quantity x rate</option>
                <option value="DRIVER_PERCENT">Percent of driver</option>
                <option value="FIXED_CENTS">Fixed amount</option>
              </select>
            </label>

            {lineKind === 'DRIVER_PRODUCT' && (
              <>
                <label className="flex flex-col gap-1 text-sm min-w-40">
                  <span className="text-[var(--muted)]">Quantity driver (COUNT)</span>
                  <select
                    required
                    value={lineQuantityDriverId}
                    onChange={(e) => setLineQuantityDriverId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="" disabled>
                      Select a driver
                    </option>
                    {countDrivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm min-w-40">
                  <span className="text-[var(--muted)]">Rate driver (CENTS)</span>
                  <select
                    required
                    value={lineRateDriverId}
                    onChange={(e) => setLineRateDriverId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="" disabled>
                      Select a driver
                    </option>
                    {centsDrivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {lineKind === 'DRIVER_PERCENT' && (
              <>
                <label className="flex flex-col gap-1 text-sm min-w-40">
                  <span className="text-[var(--muted)]">Source driver (CENTS)</span>
                  <select
                    required
                    value={lineSourceDriverId}
                    onChange={(e) => setLineSourceDriverId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="" disabled>
                      Select a driver
                    </option>
                    {centsDrivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm min-w-28">
                  <span className="text-[var(--muted)]">Percent %</span>
                  <input
                    type="text"
                    required
                    inputMode="decimal"
                    placeholder="5.00"
                    value={linePercentBps}
                    onChange={(e) => setLinePercentBps(e.target.value)}
                    className={inputClass}
                  />
                </label>
              </>
            )}

            {lineKind === 'FIXED_CENTS' && (
              <label className="flex flex-col gap-1 text-sm min-w-32">
                <span className="text-[var(--muted)]">Amount</span>
                <input
                  type="text"
                  required
                  inputMode="decimal"
                  placeholder="750.00"
                  value={lineFixedCents}
                  onChange={(e) => setLineFixedCents(e.target.value)}
                  className={inputClass}
                />
              </label>
            )}

            <button
              type="submit"
              disabled={lineBusy || lineLabel.trim() === '' || lineAccountId === ''}
              className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
            >
              {lineBusy ? 'Saving…' : 'Save line'}
            </button>
            <button type="button" onClick={() => setShowLineForm(false)} className="btn btn--ghost">
              Cancel
            </button>
          </form>
        )}
      </div>

      {pendingRoll && (
        <ConfirmDialog
          title="Roll this plan forward one month?"
          body={
            <p className="m-0">
              The plan window shifts forward: the earliest month drops off and a new trailing month is added,
              copying each driver&apos;s last value forward. This cannot be undone from here.
            </p>
          }
          confirmLabel="Roll forward"
          busy={rolling}
          onConfirm={() => void confirmRoll()}
          onCancel={() => setPendingRoll(false)}
        />
      )}

      {pendingDeletePlan && (
        <ConfirmDialog
          title="Delete this plan?"
          body={
            <p className="m-0">
              {plan.name} and every driver, headcount role, forecast line and budget version on it will be removed.
            </p>
          }
          confirmLabel="Delete"
          tone="danger"
          busy={deletingPlan}
          onConfirm={() => void confirmDeletePlan()}
          onCancel={() => setPendingDeletePlan(false)}
        />
      )}

      {pendingDeleteDriver !== null && (
        <ConfirmDialog
          title="Delete this driver?"
          body={<p className="m-0">{pendingDeleteDriver.name} and all of its monthly values will be removed.</p>}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => void confirmDeleteDriver()}
          onCancel={() => setPendingDeleteDriver(null)}
        />
      )}

      {pendingDeleteRole !== null && (
        <ConfirmDialog
          title="Delete this role?"
          body={<p className="m-0">{pendingDeleteRole.title} will be removed from the plan.</p>}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => void confirmDeleteRole()}
          onCancel={() => setPendingDeleteRole(null)}
        />
      )}

      {pendingDeleteLine !== null && (
        <ConfirmDialog
          title="Delete this forecast line?"
          body={<p className="m-0">{pendingDeleteLine.label} will be removed from the plan.</p>}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => void confirmDeleteLine()}
          onCancel={() => setPendingDeleteLine(null)}
        />
      )}
    </section>
  );
}
