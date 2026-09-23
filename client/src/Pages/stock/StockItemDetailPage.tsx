import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useAppBasePath } from '../../apps/useAppBasePath';
import AttributeFields from './AttributeFields';
import BackLink from '../../components/BackLink';
import { formatQuantityMilli } from '../../utils/quantity';
import { formatCents } from '../../utils/money';
import {
  changeStockSerialStatus,
  fetchStockBalances,
  fetchStockItem,
  fetchStockItemLots,
  fetchStockItemSerials,
  fetchStockMovements,
  updateStockItem,
  type StockAttributeDefinition,
  type StockBalance,
  type StockItem,
  type StockLot,
  type StockMovement,
  type StockSerial,
  type StockSerialStatus,
} from '../../services/fetchServices';

/**
 * One item, in full: its custom fields (editable), where it's on hand,
 * its lots or serials depending on tracking mode, and its movement
 * history. Serial rows expose only the FSM transitions actually available
 * from their current status (`types/stock.ts`'s `canTransitionSerial` on
 * the server; this mirrors it for which buttons to show, not to enforce —
 * the server is still the one source of truth).
 */
export default function StockItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';
  const navigate = useNavigate();
  const base = useAppBasePath();

  const [item, setItem] = useState<StockItem | null>(null);
  const [attributeDefs, setAttributeDefs] = useState<StockAttributeDefinition[]>([]);
  const [attributes, setAttributes] = useState<Record<string, string | boolean>>({});
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [lots, setLots] = useState<StockLot[]>([]);
  const [serials, setSerials] = useState<StockSerial[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedSerialIds, setSelectedSerialIds] = useState<string[]>([]);

  function reload() {
    if (id === undefined) return;
    setError(null);
    fetchStockItem(id)
      .then((res) => {
        setItem(res.item);
        setAttributeDefs(res.attributes);
        setAttributes(res.item.attributes);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the item'));
    fetchStockBalances({ itemId: id })
      .then((res) => setBalances(res.balances))
      .catch(() => undefined);
    fetchStockMovements({ itemId: id })
      .then((res) => setMovements(res.movements))
      .catch(() => undefined);
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (item === null || id === undefined) return;
    if (item.tracking === 'LOT') {
      fetchStockItemLots(id)
        .then((res) => setLots(res.lots))
        .catch(() => undefined);
    } else if (item.tracking === 'SERIAL') {
      fetchStockItemSerials(id)
        .then((res) => setSerials(res.serials))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.tracking, id]);

  async function handleSaveAttributes() {
    if (id === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const res = await updateStockItem(id, { attributes });
      setItem(res.item);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save attributes');
    } finally {
      setSaving(false);
    }
  }

  async function handleSerialAction(serial: StockSerial, status: Exclude<StockSerialStatus, 'ISSUED'>) {
    setError(null);
    const note = status === 'BOOKED' ? window.prompt('Note for this booking (optional):') : null;
    try {
      await changeStockSerialStatus(serial.id, { status, note: note ?? null });
      if (id !== undefined) {
        fetchStockItemSerials(id)
          .then((res) => setSerials(res.serials))
          .catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the serial status');
    }
  }

  function printItemLabel() {
    if (id === undefined) return;
    navigate(`${base}/labels`, { state: { targets: [{ kind: 'ITEM', id, copies: 1 }] } });
  }

  function printSelectedSerialLabels() {
    navigate(`${base}/labels`, {
      state: { targets: selectedSerialIds.map((sid) => ({ kind: 'SERIAL', id: sid, copies: 1 })) },
    });
  }

  function toggleSerialSelected(sid: string) {
    setSelectedSerialIds((current) => (current.includes(sid) ? current.filter((x) => x !== sid) : [...current, sid]));
  }

  if (error !== null && item === null) {
    return (
      <p role="alert" className="text-sm text-[var(--bad)]">
        {error}
      </p>
    );
  }
  if (item === null) {
    return <p>Loading…</p>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <BackLink to={`${base}/items`} label="Items" />

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">
            {item.code} — {item.name}
          </h1>
          <p className="text-sm text-[var(--muted)]">
            {item.itemType} · {item.tracking}
            {item.barcode !== null ? ` · ${item.barcode}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={printItemLabel}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
        >
          Print label
        </button>
      </div>

      <section aria-label="Custom fields" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Custom fields</h2>
        <AttributeFields definitions={attributeDefs} value={attributes} onChange={setAttributes} idPrefix="item-detail-attr" />
        {canWrite ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSaveAttributes()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            Save
          </button>
        ) : null}
      </section>

      <section aria-label="On hand" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">On hand</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              <th className="pr-3 py-1">Location</th>
              <th className="pr-3 py-1">Lot</th>
              <th className="pr-3 py-1">Quantity</th>
              <th className="pr-3 py-1">Value</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => (
              <tr key={`${b.locationId}-${b.lotId ?? ''}`} className="border-t border-[var(--border)]">
                <td className="pr-3 py-1 text-[var(--text)]">{b.locationPath}</td>
                <td className="pr-3 py-1 text-[var(--muted)]">{b.lotNumber ?? '—'}</td>
                <td className="pr-3 py-1 text-[var(--text)]">
                  {formatQuantityMilli(b.quantityMilli)} {b.uomCode}
                </td>
                <td className="pr-3 py-1 text-[var(--text)]">{formatCents(b.valueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {item.tracking === 'LOT' ? (
        <section aria-label="Lots" className="space-y-2">
          <h2 className="text-sm font-medium text-[var(--text)]">Lots</h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="pr-3 py-1">Lot</th>
                <th className="pr-3 py-1">Expires</th>
                <th className="pr-3 py-1">On hand</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <tr key={lot.id} className="border-t border-[var(--border)]">
                  <td className="pr-3 py-1 text-[var(--text)]">{lot.lotNumber}</td>
                  <td className="pr-3 py-1 text-[var(--muted)]">{lot.expiresOn ?? 'No expiry'}</td>
                  <td className="pr-3 py-1 text-[var(--text)]">{formatQuantityMilli(lot.onHandQuantityMilli)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {item.tracking === 'SERIAL' ? (
        <section aria-label="Serials" className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[var(--text)]">Serials</h2>
            {selectedSerialIds.length > 0 ? (
              <button type="button" onClick={printSelectedSerialLabels} className="text-xs text-[var(--muted)]">
                Print labels for selected
              </button>
            ) : null}
          </div>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="pr-2 py-1"></th>
                <th className="pr-3 py-1">Serial</th>
                <th className="pr-3 py-1">Status</th>
                <th className="pr-3 py-1">Location</th>
                <th className="pr-3 py-1">Cost</th>
                <th className="pr-3 py-1">Attributes</th>
                {canWrite ? <th className="pr-3 py-1">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {serials.map((serial) => (
                <tr key={serial.id} className="border-t border-[var(--border)]">
                  <td className="pr-2 py-1">
                    <input
                      type="checkbox"
                      aria-label={`Select ${serial.serialNumber}`}
                      checked={selectedSerialIds.includes(serial.id)}
                      onChange={() => toggleSerialSelected(serial.id)}
                    />
                  </td>
                  <td className="pr-3 py-1 text-[var(--text)]">{serial.serialNumber}</td>
                  <td className="pr-3 py-1 text-[var(--muted)]">{serial.status}</td>
                  <td className="pr-3 py-1 text-[var(--muted)]">{serial.locationCode ?? '—'}</td>
                  <td className="pr-3 py-1 text-[var(--text)]">{formatCents(serial.costCents)}</td>
                  <td className="pr-3 py-1 text-[var(--muted)]">
                    {Object.values(serial.attributes)
                      .map((v) => String(v))
                      .join(', ')}
                  </td>
                  {canWrite ? (
                    <td className="pr-3 py-1 space-x-2">
                      {serial.status === 'AVAILABLE' ? (
                        <>
                          <button type="button" onClick={() => void handleSerialAction(serial, 'ON_HOLD')} className="text-xs text-[var(--muted)]">
                            Hold
                          </button>
                          <button type="button" onClick={() => void handleSerialAction(serial, 'BOOKED')} className="text-xs text-[var(--muted)]">
                            Book
                          </button>
                        </>
                      ) : null}
                      {serial.status === 'ON_HOLD' || serial.status === 'BOOKED' ? (
                        <button type="button" onClick={() => void handleSerialAction(serial, 'AVAILABLE')} className="text-xs text-[var(--muted)]">
                          Release
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section aria-label="Movement history" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Movement history</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              <th className="pr-3 py-1">Date</th>
              <th className="pr-3 py-1">Type</th>
              <th className="pr-3 py-1">Location</th>
              <th className="pr-3 py-1">Quantity</th>
              <th className="pr-3 py-1">Running qty</th>
              <th className="pr-3 py-1">Value</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id} className="border-t border-[var(--border)]">
                <td className="pr-3 py-1 text-[var(--muted)]">{m.occurredOn}</td>
                <td className="pr-3 py-1 text-[var(--text)]">{m.movementType}</td>
                <td className="pr-3 py-1 text-[var(--muted)]">{m.locationCode}</td>
                <td className="pr-3 py-1 text-[var(--text)]">{formatQuantityMilli(m.quantityMilli)}</td>
                <td className="pr-3 py-1 text-[var(--muted)]">{formatQuantityMilli(m.runningLocationQuantityMilli)}</td>
                <td className="pr-3 py-1 text-[var(--text)]">{formatCents(m.valueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
