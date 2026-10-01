import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Plus } from 'lucide-react';
import { INVENTORY_BASE } from '../../routes/paths';
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
import { humanizeEnum } from '../../utils/enumLabel';
import PageHeader from '../../components/ui/PageHeader';
import EmptyState from '../../components/ui/EmptyState';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { inputClass } from '../../components/ui/formClasses';
import { useCan } from '../../context/AuthContext';

const NESTED_KINDS: readonly StockLocationKind[] = ['ZONE', 'BIN'];

/**
 * Inventory's location hierarchy: warehouse/store/site at the top, zone
 * and bin nested inside. The kind select is limited to what the server
 * would accept for the chosen parent (guardrails rule 16's client-side
 * counterpart of `locationService.createLocation`'s own check).
 */
export default function InventoryLocationsPage() {
  const can = useCan();
  // Phase 38c — the permission the server checks on these routes.
  const canWrite = can('inventory.configure');
  const navigate = useNavigate();
  const base = INVENTORY_BASE;

  const [locations, setLocations] = useState<StockLocation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<string>('');

  useEffect(() => {
    fetchStockSettings()
      .then((res) => setDefaultLocationId(res.settings.defaultLocationId ?? ''))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the default location'));
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

  const activeLocations = (locations ?? []).filter((l) => l.isActive);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        as="h2"
        icon={MapPin}
        title="Locations"
        subtitle="Where stock is kept: warehouses, stores and sites, with zones and bins inside them."
      />

      {error !== null && (
        <p role="alert" className="status status--bad">
          {error}
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm max-w-sm">
        <span className="text-[var(--muted)]">Default location for invoices and bills</span>
        <select
          value={defaultLocationId}
          disabled={!canWrite}
          onChange={(e) => void handleDefaultLocation(e.target.value)}
          className={inputClass}
        >
          <option value="">None — choose on every line</option>
          {activeLocations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.path}
            </option>
          ))}
        </select>
      </label>

      {locations === null && error === null && <SkeletonRows count={3} />}

      {locations !== null && locations.length === 0 && (
        <EmptyState icon={MapPin} title="No locations yet" body="Add a warehouse, store or site below." />
      )}

      {locations !== null && locations.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Kind</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((location) => (
                <tr key={location.id} className="border-t border-[var(--border)]">
                  <td className="p-3 font-mono text-xs" style={{ paddingLeft: `${12 + (location.depth - 1) * 20}px` }}>
                    {location.code}
                  </td>
                  <td className="p-3" title={location.path}>
                    {location.name}
                  </td>
                  <td className="p-3 text-[var(--muted)]">{humanizeEnum(location.kind)}</td>
                  <td className="p-3 text-[var(--muted)]">{location.isActive ? 'Active' : 'Inactive'}</td>
                  <td className="p-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handlePrintLabel(location)}
                        className="px-2 py-1 rounded-md text-xs text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer"
                      >
                        Print label
                      </button>
                      {canWrite && (
                        <button
                          type="button"
                          onClick={() => void handleToggle(location)}
                          className="px-2 py-1 rounded-md text-xs text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer"
                        >
                          {location.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
          className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
        >
          <p className="m-0 text-sm font-semibold">New location</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm w-28">
              <span className="text-[var(--muted)]">Code</span>
              <input required value={code} onChange={(e) => setCode(e.target.value)} placeholder="WH2" className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
              <span className="text-[var(--muted)]">Name</span>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Overflow warehouse" className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm w-48">
              <span className="text-[var(--muted)]">Inside</span>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={inputClass}>
                <option value="">Top level</option>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.path}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm w-36">
              <span className="text-[var(--muted)]">Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as StockLocationKind)} className={inputClass}>
                {availableKinds.map((k) => (
                  <option key={k} value={k}>
                    {humanizeEnum(k)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Plus size={15} aria-hidden="true" /> Add location
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
