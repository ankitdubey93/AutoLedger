import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import AttributeFields from './AttributeFields';
import { parseQuantityToMilli } from '../../utils/quantity';
import { parseCentsInput } from '../../utils/money';
import {
  fetchStockCategory,
  fetchStockItemLots,
  fetchStockItemSerials,
  fetchStockItems,
  fetchStockLocations,
  postStockAdjustment,
  postStockIssue,
  postStockReceipt,
  postStockTransfer,
  type StockAttributeDefinition,
  type StockItem,
  type StockLocation,
  type StockLot,
  type StockSerial,
} from '../../services/fetchServices';

const inputClass = 'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

type Tab = 'RECEIVE' | 'ISSUE' | 'TRANSFER' | 'ADJUST';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface LineState {
  key: string;
  item: StockItem | null;
  itemSearch: string;
  itemResults: StockItem[];
  quantityText: string;
  quantityError: string | null;
  unitCostText: string;
  direction: 'IN' | 'OUT';
  lotNumber: string;
  manufacturedOn: string;
  expiresOn: string;
  lotId: string;
  availableLots: StockLot[];
  serialNumbersText: string;
  serialCosts: Record<string, string>;
  serialAttributes: Record<string, Record<string, string | boolean>>;
  serialAttributeDefs: StockAttributeDefinition[];
  availableSerials: StockSerial[];
  selectedSerialIds: string[];
}

function emptyLine(): LineState {
  return {
    key: Math.random().toString(36).slice(2),
    item: null,
    itemSearch: '',
    itemResults: [],
    quantityText: '',
    quantityError: null,
    unitCostText: '',
    direction: 'IN',
    lotNumber: '',
    manufacturedOn: '',
    expiresOn: '',
    lotId: '',
    availableLots: [],
    serialNumbersText: '',
    serialCosts: {},
    serialAttributes: {},
    serialAttributeDefs: [],
    availableSerials: [],
    selectedSerialIds: [],
  };
}

/**
 * StockLedger's movement entry: receive, issue, transfer, adjust — one
 * form, four tabs, because every tab shares the item picker and the
 * per-tracking-mode line inputs (QUANTITY/LOT/SERIAL). Quantity and money
 * are parsed with the same string-math parsers the rest of the client
 * uses (`utils/quantity.ts`, `utils/money.ts`) — never `parseFloat`.
 */
export default function StockMovementPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';

  const [tab, setTab] = useState<Tab>('RECEIVE');
  const [occurredOn, setOccurredOn] = useState(todayIsoDate());
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [locationId, setLocationId] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [lines, setLines] = useState<LineState[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ movementGroupId: string; count: number } | null>(null);

  useEffect(() => {
    fetchStockLocations()
      .then((res) => setLocations(res.locations))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load locations'));
  }, []);

  const activeLocations = locations.filter((l) => l.isActive);
  const inboundLocationOptions = tab === 'ADJUST' ? locations : activeLocations;

  function updateLine(key: string, patch: Partial<LineState>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((current) => [...current, emptyLine()]);
  }

  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  }

  function handleItemSearchChange(line: LineState, q: string) {
    updateLine(line.key, { itemSearch: q });
    if (q.trim() === '') {
      updateLine(line.key, { itemResults: [] });
      return;
    }
    fetchStockItems({ q })
      .then((res) => updateLine(line.key, { itemResults: res.items }))
      .catch(() => undefined);
  }

  function selectItem(line: LineState, item: StockItem) {
    updateLine(line.key, {
      item,
      itemSearch: '',
      itemResults: [],
      quantityText: '',
      quantityError: null,
      lotId: '',
      availableLots: [],
      selectedSerialIds: [],
      availableSerials: [],
      serialAttributeDefs: [],
    });

    const currentLocationId = tab === 'ISSUE' || tab === 'ADJUST' ? locationId : tab === 'TRANSFER' ? fromLocationId : locationId;

    if (item.tracking === 'LOT' && tab !== 'RECEIVE') {
      fetchStockItemLots(item.id)
        .then((res) => {
          const first = res.lots[0];
          updateLine(line.key, { availableLots: res.lots, lotId: first !== undefined ? first.id : '' });
        })
        .catch(() => undefined);
    }

    if (item.tracking === 'SERIAL') {
      if (tab === 'RECEIVE') {
        fetchStockCategory(item.categoryId)
          .then((res) => updateLine(line.key, { serialAttributeDefs: res.attributes.filter((a) => a.appliesTo === 'SERIAL') }))
          .catch(() => undefined);
      } else if (tab === 'ISSUE' || tab === 'TRANSFER') {
        fetchStockItemSerials(item.id)
          .then((res) => {
            const eligible = res.serials.filter(
              (s) => (s.status === 'AVAILABLE' || s.status === 'BOOKED') && s.locationCode === locationForCode(currentLocationId),
            );
            updateLine(line.key, { availableSerials: eligible });
          })
          .catch(() => undefined);
      }
    }
  }

  function locationForCode(id: string): string | undefined {
    return locations.find((l) => l.id === id)?.code;
  }

  function handleQuantityChange(line: LineState, text: string) {
    if (line.item === null) return;
    const parsed = parseQuantityToMilli(text, line.item.uomDecimalPlaces);
    updateLine(line.key, {
      quantityText: text,
      quantityError: text.trim() !== '' && parsed === null ? `Too many decimal places for ${line.item.uomCode}` : null,
    });
  }

  function toggleSerialSelected(line: LineState, serialId: string) {
    updateLine(line.key, {
      selectedSerialIds: line.selectedSerialIds.includes(serialId)
        ? line.selectedSerialIds.filter((id) => id !== serialId)
        : [...line.selectedSerialIds, serialId],
    });
  }

  const hasQuantityError = lines.some((l) => l.quantityError !== null);

  async function handleSubmit() {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      if (tab === 'RECEIVE') {
        const receiptLines = lines
          .filter((l) => l.item !== null)
          .map((l) => {
            const item = l.item as StockItem;
            if (item.tracking === 'SERIAL') {
              const serialNumbers = l.serialNumbersText
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              const totalMilli = serialNumbers.length * 1000;
              return {
                itemId: item.id,
                quantityMilli: totalMilli,
                unitCostCents: parseCentsInput(l.unitCostText) ?? 0,
                lot: null,
                serials: serialNumbers.map((serialNumber) => ({
                  serialNumber,
                  costCents: l.serialCosts[serialNumber] !== undefined ? parseCentsInput(l.serialCosts[serialNumber] as string) : null,
                  attributes: l.serialAttributes[serialNumber] ?? {},
                })),
              };
            }
            return {
              itemId: item.id,
              quantityMilli: parseQuantityToMilli(l.quantityText, item.uomDecimalPlaces) ?? 0,
              unitCostCents: parseCentsInput(l.unitCostText) ?? 0,
              lot: item.tracking === 'LOT' ? { lotNumber: l.lotNumber, manufacturedOn: l.manufacturedOn === '' ? null : l.manufacturedOn, expiresOn: l.expiresOn === '' ? null : l.expiresOn } : null,
              serials: null,
            };
          });
        const res = await postStockReceipt({ occurredOn, reference: reference === '' ? null : reference, locationId, lines: receiptLines });
        setResult({ movementGroupId: res.movementGroupId, count: res.movements.length });
      } else if (tab === 'ISSUE' || tab === 'TRANSFER') {
        const outboundLines = lines
          .filter((l) => l.item !== null)
          .map((l) => {
            const item = l.item as StockItem;
            return {
              itemId: item.id,
              quantityMilli:
                item.tracking === 'SERIAL' ? l.selectedSerialIds.length * 1000 : parseQuantityToMilli(l.quantityText, item.uomDecimalPlaces) ?? 0,
              lotId: item.tracking === 'LOT' ? (l.lotId === '' ? null : l.lotId) : null,
              serialIds: item.tracking === 'SERIAL' ? l.selectedSerialIds : null,
            };
          });
        if (tab === 'ISSUE') {
          const res = await postStockIssue({ occurredOn, reference: reference === '' ? null : reference, locationId, lines: outboundLines });
          setResult({ movementGroupId: res.movementGroupId, count: res.movements.length });
        } else {
          const res = await postStockTransfer({
            occurredOn,
            reference: reference === '' ? null : reference,
            fromLocationId,
            toLocationId,
            lines: outboundLines,
          });
          setResult({ movementGroupId: res.movementGroupId, count: res.movements.length });
        }
      } else {
        const adjustmentLines = lines
          .filter((l) => l.item !== null)
          .map((l) => {
            const item = l.item as StockItem;
            return {
              itemId: item.id,
              direction: l.direction,
              quantityMilli: parseQuantityToMilli(l.quantityText, item.uomDecimalPlaces) ?? 0,
              lotId: item.tracking === 'LOT' ? (l.lotId === '' ? null : l.lotId) : null,
              unitCostCents: l.unitCostText.trim() === '' ? null : parseCentsInput(l.unitCostText),
            };
          });
        const res = await postStockAdjustment({ occurredOn, reason, locationId, lines: adjustmentLines });
        setResult({ movementGroupId: res.movementGroupId, count: res.movements.length });
      }
      setLines([emptyLine()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the movement');
    } finally {
      setSubmitting(false);
    }
  }

  if (!canWrite) {
    return <p className="text-sm text-[var(--muted)]">You do not have permission to post stock movements.</p>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">Movements</h1>

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <p className="text-sm text-[var(--good)]">
          Posted {result.count} movements (group {result.movementGroupId})
        </p>
      ) : null}

      <div role="tablist" className="flex gap-2">
        {(['RECEIVE', 'ISSUE', 'TRANSFER', 'ADJUST'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={[
              'px-3 py-1.5 text-sm rounded-md',
              tab === t ? 'bg-[var(--panel)] text-[var(--text)] font-medium' : 'text-[var(--muted)]',
            ].join(' ')}
          >
            {t === 'RECEIVE' ? 'Receive' : t === 'ISSUE' ? 'Issue' : t === 'TRANSFER' ? 'Transfer' : 'Adjust'}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-sm text-[var(--text)]">
          Date
          <input
            aria-label="Date"
            type="date"
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
            className={`${inputClass} block mt-1`}
          />
        </label>

        {tab === 'ADJUST' ? (
          <label className="text-sm text-[var(--text)]">
            Reason *
            <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} block mt-1`} />
          </label>
        ) : (
          <label className="text-sm text-[var(--text)]">
            Reference
            <input aria-label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} className={`${inputClass} block mt-1`} />
          </label>
        )}

        {tab === 'TRANSFER' ? (
          <>
            <label className="text-sm text-[var(--text)]">
              From
              <select aria-label="From location" value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} className={`${inputClass} block mt-1`}>
                <option value="">Choose a location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.path}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-[var(--text)]">
              To
              <select aria-label="To location" value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} className={`${inputClass} block mt-1`}>
                <option value="">Choose a location</option>
                {activeLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.path}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="text-sm text-[var(--text)]">
            Location
            <select aria-label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)} className={`${inputClass} block mt-1`}>
              <option value="">Choose a location</option>
              {inboundLocationOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.path}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="space-y-4">
        {lines.map((line) => (
          <div key={line.key} className="border border-[var(--border)] rounded-md p-3 space-y-2">
            {line.item === null ? (
              <div>
                <input
                  aria-label="Search item"
                  placeholder="Search item by code or name"
                  value={line.itemSearch}
                  onChange={(e) => handleItemSearchChange(line, e.target.value)}
                  className={`${inputClass} w-full`}
                />
                {line.itemResults.length > 0 ? (
                  <ul className="mt-1 border border-[var(--border)] rounded-md divide-y divide-[var(--border)]">
                    {line.itemResults.map((result) => (
                      <li key={result.id}>
                        <button
                          type="button"
                          onClick={() => selectItem(line, result)}
                          className="w-full text-left px-2.5 py-1.5 text-sm text-[var(--text)]"
                        >
                          {result.code} — {result.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[var(--text)]">
                    {line.item.code} — {line.item.name} ({line.item.tracking})
                  </span>
                  <button type="button" onClick={() => updateLine(line.key, { item: null })} className="text-xs text-[var(--muted)]">
                    Change
                  </button>
                </div>

                {tab === 'ADJUST' ? (
                  <label className="flex items-center gap-2 text-sm text-[var(--text)]">
                    Direction
                    <select
                      aria-label={`Direction for ${line.item.code}`}
                      value={line.direction}
                      onChange={(e) => updateLine(line.key, { direction: e.target.value as 'IN' | 'OUT' })}
                      className={inputClass}
                    >
                      <option value="IN">IN</option>
                      <option value="OUT">OUT</option>
                    </select>
                  </label>
                ) : null}

                {line.item.tracking !== 'SERIAL' ? (
                  <div className="flex flex-wrap gap-3 items-end">
                    <label className="text-sm text-[var(--text)]">
                      Quantity
                      <input
                        aria-label="Quantity"
                        value={line.quantityText}
                        onChange={(e) => handleQuantityChange(line, e.target.value)}
                        className={`${inputClass} block mt-1 w-28`}
                      />
                    </label>
                    {tab === 'RECEIVE' || (tab === 'ADJUST' && line.direction === 'IN') ? (
                      <label className="text-sm text-[var(--text)]">
                        Unit cost
                        <input
                          aria-label="Unit cost"
                          value={line.unitCostText}
                          onChange={(e) => updateLine(line.key, { unitCostText: e.target.value })}
                          className={`${inputClass} block mt-1 w-28`}
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}

                {line.quantityError !== null ? (
                  <p role="alert" className="text-sm text-[var(--bad)]">
                    {line.quantityError}
                  </p>
                ) : null}

                {line.item.tracking === 'LOT' && tab === 'RECEIVE' ? (
                  <div className="flex flex-wrap gap-3 items-end">
                    <label className="text-sm text-[var(--text)]">
                      Lot number
                      <input aria-label="Lot number" value={line.lotNumber} onChange={(e) => updateLine(line.key, { lotNumber: e.target.value })} className={`${inputClass} block mt-1`} />
                    </label>
                    <label className="text-sm text-[var(--text)]">
                      Manufactured
                      <input aria-label="Manufactured on" type="date" value={line.manufacturedOn} onChange={(e) => updateLine(line.key, { manufacturedOn: e.target.value })} className={`${inputClass} block mt-1`} />
                    </label>
                    <label className="text-sm text-[var(--text)]">
                      Expires
                      <input aria-label="Expires on" type="date" value={line.expiresOn} onChange={(e) => updateLine(line.key, { expiresOn: e.target.value })} className={`${inputClass} block mt-1`} />
                    </label>
                  </div>
                ) : null}

                {line.item.tracking === 'LOT' && tab !== 'RECEIVE' ? (
                  <label className="text-sm text-[var(--text)] block">
                    Lot
                    <select aria-label="Lot" value={line.lotId} onChange={(e) => updateLine(line.key, { lotId: e.target.value })} className={`${inputClass} block mt-1`}>
                      {line.availableLots.map((lot) => (
                        <option key={lot.id} value={lot.id}>
                          {lot.lotNumber} {lot.expiresOn !== null ? `(exp ${lot.expiresOn})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {line.item.tracking === 'SERIAL' && tab === 'RECEIVE' ? (
                  <div className="space-y-2">
                    <label className="text-sm text-[var(--text)] block">
                      Serial numbers (one per line)
                      <textarea
                        aria-label="Serial numbers"
                        value={line.serialNumbersText}
                        onChange={(e) => updateLine(line.key, { serialNumbersText: e.target.value })}
                        className={`${inputClass} block mt-1 w-full h-20`}
                      />
                    </label>
                    <label className="text-sm text-[var(--text)]">
                      Unit cost (fallback)
                      <input aria-label="Unit cost" value={line.unitCostText} onChange={(e) => updateLine(line.key, { unitCostText: e.target.value })} className={`${inputClass} block mt-1 w-28`} />
                    </label>
                    {line.serialNumbersText
                      .split('\n')
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0)
                      .map((serialNumber) => (
                        <div key={serialNumber} className="border-t border-[var(--border)] pt-2">
                          <p className="text-sm text-[var(--text)]">{serialNumber}</p>
                          <label className="text-sm text-[var(--text)]">
                            Cost
                            <input
                              aria-label={`Cost for ${serialNumber}`}
                              value={line.serialCosts[serialNumber] ?? ''}
                              onChange={(e) =>
                                updateLine(line.key, { serialCosts: { ...line.serialCosts, [serialNumber]: e.target.value } })
                              }
                              className={`${inputClass} block mt-1 w-28`}
                            />
                          </label>
                          {line.serialAttributeDefs.length > 0 ? (
                            <AttributeFields
                              definitions={line.serialAttributeDefs}
                              value={line.serialAttributes[serialNumber] ?? {}}
                              onChange={(next) =>
                                updateLine(line.key, { serialAttributes: { ...line.serialAttributes, [serialNumber]: next } })
                              }
                              idPrefix={`serial-${serialNumber}`}
                            />
                          ) : null}
                        </div>
                      ))}
                  </div>
                ) : null}

                {line.item.tracking === 'SERIAL' && (tab === 'ISSUE' || tab === 'TRANSFER') ? (
                  <div className="space-y-1">
                    <p className="text-sm text-[var(--text)]">Serials</p>
                    {line.availableSerials.map((serial) => (
                      <label key={serial.id} className="flex items-center gap-1.5 text-sm text-[var(--text)]">
                        <input
                          type="checkbox"
                          aria-label={`Select ${serial.serialNumber}`}
                          checked={line.selectedSerialIds.includes(serial.id)}
                          onChange={() => toggleSerialSelected(line, serial.id)}
                        />
                        {serial.serialNumber}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            {lines.length > 1 ? (
              <button type="button" onClick={() => removeLine(line.key)} className="text-xs text-[var(--muted)]">
                Remove line
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <button type="button" onClick={addLine} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]">
        Add line
      </button>

      <div>
        <button
          type="button"
          disabled={submitting || hasQuantityError}
          onClick={() => void handleSubmit()}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Post
        </button>
      </div>
    </div>
  );
}
