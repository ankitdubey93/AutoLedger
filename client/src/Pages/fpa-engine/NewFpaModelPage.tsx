import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createFpaModel } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/** Coerces a `<input type="month">` value ('YYYY-MM') to the first of that month. */
function firstOfMonth(monthValue: string): string {
  return monthValue === '' ? '' : `${monthValue}-01`;
}

export default function NewFpaModelPage() {
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startsOnMonth, setStartsOnMonth] = useState('');
  const [actualsThroughMonth, setActualsThroughMonth] = useState('');
  const [horizonMonths, setHorizonMonths] = useState('12');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startsOn = firstOfMonth(startsOnMonth);
  const actualsThrough = firstOfMonth(actualsThroughMonth);

  // The same rule the server enforces (migration 033's CHECK) — checked
  // client-side too so the user sees the actual failure before a round trip,
  // with the identical message the server would return.
  const actualsThroughInvalid =
    startsOn !== '' && actualsThrough !== '' && actualsThrough >= startsOn;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (actualsThroughInvalid) {
      setError('actualsThrough must be before startsOn');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const horizon = Number(horizonMonths);
      const res = await createFpaModel({
        name,
        description: description.trim() === '' ? null : description.trim(),
        startsOn,
        horizonMonths: horizon,
        actualsThrough,
      });
      navigate(`${base}/${res.model.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the model');
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 max-w-xl">
      <BackLink to={base} label="Back to models" />
      <h2 className="text-lg font-semibold m-0">New model</h2>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Name</span>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </label>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
            <span className="text-[var(--muted)]">Actuals through (last closed month)</span>
            <input
              type="month"
              required
              value={actualsThroughMonth}
              onChange={(e) => setActualsThroughMonth(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
            <span className="text-[var(--muted)]">Projection starts</span>
            <input
              type="month"
              required
              value={startsOnMonth}
              onChange={(e) => setStartsOnMonth(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm max-w-40">
          <span className="text-[var(--muted)]">Horizon (months)</span>
          <input
            type="number"
            required
            min={1}
            max={60}
            value={horizonMonths}
            onChange={(e) => setHorizonMonths(e.target.value)}
            className={inputClass}
          />
        </label>

        {actualsThroughInvalid && (
          <p className="status status--bad m-0">actualsThrough must be before startsOn</p>
        )}
        {error !== null && <p className="status status--bad m-0">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || name.trim() === '' || startsOn === '' || actualsThrough === '' || actualsThroughInvalid}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Creating…' : 'Create model'}
          </button>
        </div>
      </form>
    </section>
  );
}
