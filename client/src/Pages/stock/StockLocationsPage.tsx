import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useAppBasePath } from '../../apps/useAppBasePath';
import {
  STOCK_TOP_LEVEL_LOCATION_KINDS,
  createStockLocation,
  fetchStockLocations,
  fetchStockSettings,
  updateStockLocation,
  updateStockSettings,
  type StockLocation,
  type StockLocationKind,
} from '../../services/fetchServices';

const inputClass = 'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';
const NESTED_KINDS: readonly StockLocationKind[] = ['ZONE', 'BIN'];

/**
 * StockLedger's location hierarchy: warehouse/store/site at the top, zone
 * and bin nested inside. The kind select is limited to what the server
 * would accept for the chosen parent (guardrails rule 16's client-side
 * counterpart of `locationService.createLocation`'s own check).
 */
export default function StockLocationsPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN';
  const navigate = useNavigate();
  const base = useAppBasePath();

  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<string>('');

  useEffect(() => {
    fetchStockSettings()
      .then((res) => setDefaultLocationId(res.settings.defaultLocationId ?? ''))
      .catch(() => undefined);
  }, []);

  async function handleDefaultLocation(next: string) {
    setError(null);
    try {
      await updateStockSettings({ defaultLocationId: next === '' ? null : next });
      setDefaultLocationId(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the default location');
    }
  }

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [kind, setKind] = useState<StockLocationKind>('WAREHOUSE');

  function reload() {
    setError(null);
    fetchStockLocations(true)
      .then((res) => setLocations(res.locations))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load locations'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const availableKinds = parentId === '' ? STOCK_TOP_LEVEL_LOCATION_KINDS : NESTED_KINDS;

  useEffect(() => {
    if (!(availableKinds as readonly string[]).includes(kind)) {
      setKind(availableKinds[0] as StockLocationKind);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId]);

  async function handleCreate() {
    setError(null);
    try {
      await createStockLocation({ code, name, kind, parentId: parentId === '' ? null : parentId });
      setCode('');
      setName('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the location');
    }
  }

  async function handleToggle(location: StockLocation) {
    setError(null);
    try {
      await updateStockLocation(location.id, { isActive: !location.isActive });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the location');
    }
  }

  function handlePrintLabel(location: StockLocation) {
    navigate(`${base}/labels`, { state: { targets: [{ kind: 'LOCATION', id: location.id, copies: 1 }] } });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">Locations</h1>

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      <div>
        <label htmlFor="default-location" className="block text-sm text-[var(--text)] mb-1">
          Default location for invoices and bills
        </label>
        <select
          id="default-location"
          value={defaultLocationId}
          disabled={!canWrite}
          onChange={(e) => void handleDefaultLocation(e.target.value)}
          className={inputClass}
        >
          <option value="">None — choose on every line</option>
          {locations
            .filter((l) => l.isActive)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.path}
              </option>
            ))}
        </select>
      </div>

      <ul className="space-y-1">
        {locations.map((location) => (
          <li
            key={location.id}
            className="flex items-center justify-between text-sm"
            style={{ paddingLeft: `${(location.depth - 1) * 16}px` }}
          >
            <span title={location.path} className={location.isActive ? 'text-[var(--text)]' : 'text-[var(--muted)] line-through'}>
              {location.code} — {location.name} ({location.kind})
            </span>
            <span className="flex gap-2">
              <button type="button" onClick={() => handlePrintLabel(location)} className="text-xs text-[var(--muted)]">
                Print label
              </button>
              {canWrite ? (
                <button type="button" onClick={() => void handleToggle(location)} className="text-xs text-[var(--muted)]">
                  {location.isActive ? 'Deactivate' : 'Activate'}
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      {canWrite ? (
        <div className="flex flex-wrap gap-2 items-end">
          <input
            aria-label="Location code"
            placeholder="Code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${inputClass} w-28`}
          />
          <input
            aria-label="Location name"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${inputClass} w-40`}
          />
          <select
            aria-label="Parent location"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className={`${inputClass} w-40`}
          >
            <option value="">Top level</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.path}
              </option>
            ))}
          </select>
          <select
            aria-label="Location kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as StockLocationKind)}
            className={`${inputClass} w-32`}
          >
            {availableKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white"
          >
            Add location
          </button>
        </div>
      ) : null}
    </div>
  );
}
