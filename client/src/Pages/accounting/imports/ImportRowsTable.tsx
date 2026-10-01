import { Fragment, useState } from 'react';
import type {
  AccountType,
  ImportEditFieldMeta,
  ImportKindMeta,
  MigrationImportRow,
  MigrationRowStatus,
} from '../../../services/fetchServices';
import { formatCents, parseCentsInput } from '../../../utils/money';

/**
 * The review table of a staged import (Phase 36a). Columns and editors come
 * from the kind's `editFields` metadata, so one component serves every kind.
 */

const ACCOUNT_TYPES: AccountType[] = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
const STATUS_LABEL: Record<MigrationRowStatus, string> = { VALID: 'Valid', INVALID: 'Invalid', EXCLUDED: 'Excluded' };

const cellInputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-sm text-[var(--text)] w-full';

function fieldValue(row: MigrationImportRow, field: ImportEditFieldMeta): unknown {
  const record: Record<string, unknown> = { ...row };
  return record[field.key];
}

function editText(row: MigrationImportRow, field: ImportEditFieldMeta, isData: boolean): string {
  if (isData) return row.raw[field.key] ?? '';
  const v = fieldValue(row, field);
  if (field.input === 'money') return typeof v === 'number' && v > 0 ? formatCents(v) : '';
  return typeof v === 'string' ? v : '';
}

function displayText(row: MigrationImportRow, field: ImportEditFieldMeta, isData: boolean): string {
  const text = editText(row, field, isData);
  return text === '' ? '—' : text;
}

export default function ImportRowsTable({
  meta,
  rows,
  readOnly,
  savingRowId,
  onSave,
  onError,
  onSetGroupStatus,
}: {
  meta: ImportKindMeta;
  rows: MigrationImportRow[];
  readOnly: boolean;
  savingRowId: string | null;
  onSave: (row: MigrationImportRow, body: Record<string, string | number | null | Record<string, string | null>>) => void;
  onError: (message: string) => void;
  onSetGroupStatus?: (rowIds: string[], status: 'VALID' | 'EXCLUDED') => void;
}) {
  // Only rows the user has touched hold an edit; the rest read from the row.
  const isData = meta.storage === 'data';
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});

  function currentText(row: MigrationImportRow, field: ImportEditFieldMeta): string {
    return edits[row.id]?.[field.key] ?? editText(row, field, isData);
  }

  function setText(row: MigrationImportRow, field: ImportEditFieldMeta, text: string) {
    setEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], [field.key]: text } }));
  }

  function save(row: MigrationImportRow) {
    if (isData) {
      const values: Record<string, string | null> = {};
      for (const field of meta.editFields) {
        const trimmed = currentText(row, field).trim();
        values[field.key] = trimmed === '' ? null : trimmed;
      }
      onSave(row, { values });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      return;
    }
    const body: Record<string, string | number | null> = {};
    for (const field of meta.editFields) {
      const text = currentText(row, field);
      if (field.input === 'money') {
        const cents = parseCentsInput(text);
        if (cents === null) {
          onError(`${field.label} must be a valid amount`);
          return;
        }
        body[field.key] = cents;
      } else if (field.input === 'accountType') {
        if (text !== '') body[field.key] = text;
      } else {
        const trimmed = text.trim();
        if (trimmed === '') {
          if (field.nullable) body[field.key] = null;
        } else {
          body[field.key] = trimmed;
        }
      }
    }
    onSave(row, body);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
  }

  const grouped = meta.groupHeaderFields.length > 0;
  // Runs of consecutive rows sharing a group key; a null key is its own run.
  const runStartsAt = new Map<string, MigrationImportRow[]>();
  if (grouped) {
    let current: MigrationImportRow[] | null = null;
    let currentKey: string | null = null;
    for (const row of rows) {
      if (current === null || row.groupKey === null || row.groupKey !== currentKey) {
        current = [row];
        currentKey = row.groupKey;
        runStartsAt.set(row.id, current);
      } else {
        current.push(row);
      }
    }
  }

  function groupHeader(run: MigrationImportRow[]) {
    const first = run[0];
    if (first === undefined) return null;
    const title = meta.groupHeaderFields
      .map((field) => (first.raw[field] ?? '').trim())
      .filter((text) => text !== '')
      .join(' · ');
    const allExcluded = run.every((r) => r.status === 'EXCLUDED');
    const action = allExcluded ? 'Include' : 'Exclude';
    return (
      <tr key={`group-${first.id}`} className="border-t border-[var(--border)] bg-[var(--bg)]">
        <td colSpan={meta.editFields.length + (readOnly ? 3 : 4)} className="p-2">
          <span className="flex items-center justify-between gap-2">
            <span>
              <strong>{title}</strong>
              {` — ${String(run.length)} line${run.length === 1 ? '' : 's'}`}
            </span>
            {!readOnly && onSetGroupStatus !== undefined && (
              <button
                type="button"
                aria-label={`${action} group ${title}`}
                className="btn btn--ghost"
                onClick={() => onSetGroupStatus(run.map((r) => r.id), allExcluded ? 'VALID' : 'EXCLUDED')}
              >
                {action}
              </button>
            )}
          </span>
        </td>
      </tr>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[50rem]">
        <thead>
          <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
            <th className="p-2 font-medium">Row</th>
            {meta.editFields.map((field) => (
              <th key={field.key} className="p-2 font-medium">
                {field.label}
              </th>
            ))}
            <th className="p-2 font-medium">Status</th>
            <th className="p-2 font-medium">Errors</th>
            {!readOnly && <th className="p-2 font-medium" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.id}>
            {runStartsAt.has(row.id) && groupHeader(runStartsAt.get(row.id) ?? [])}
            <tr className="border-t border-[var(--border)] align-top">
              <td className="p-2">{row.rowNumber}</td>
              {meta.editFields.map((field) => (
                <td key={field.key} className="p-2">
                  {readOnly ? (
                    displayText(row, field, isData)
                  ) : field.input === 'enum' ? (
                    <select
                      aria-label={`${field.label}, row ${String(row.rowNumber)}`}
                      value={currentText(row, field)}
                      onChange={(e) => setText(row, field, e.target.value)}
                      className={cellInputClass}
                    >
                      <option value="">—</option>
                      {(field.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : field.input === 'accountType' ? (
                    <select
                      aria-label={`${field.label}, row ${String(row.rowNumber)}`}
                      value={currentText(row, field)}
                      onChange={(e) => setText(row, field, e.target.value)}
                      className={cellInputClass}
                    >
                      <option value="">—</option>
                      {ACCOUNT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  ) : field.input === 'money' ? (
                    <input
                      inputMode="decimal"
                      aria-label={`${field.label}, row ${String(row.rowNumber)}`}
                      value={currentText(row, field)}
                      onChange={(e) => setText(row, field, e.target.value)}
                      className={cellInputClass}
                    />
                  ) : (
                    <input
                      type="text"
                      aria-label={`${field.label}, row ${String(row.rowNumber)}`}
                      value={currentText(row, field)}
                      maxLength={field.maxLength ?? undefined}
                      onChange={(e) => setText(row, field, e.target.value)}
                      className={cellInputClass}
                    />
                  )}
                </td>
              ))}
              <td className="p-2">
                <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  {STATUS_LABEL[row.status]}
                </span>
              </td>
              <td className="p-2 text-xs text-[var(--bad)]">{row.errors.length === 0 ? '—' : row.errors.join('; ')}</td>
              {!readOnly && (
                <td className="p-2">
                  <button
                    type="button"
                    aria-label={`Save row ${String(row.rowNumber)}`}
                    disabled={savingRowId === row.id}
                    onClick={() => save(row)}
                    className="btn btn--ghost"
                  >
                    {savingRowId === row.id ? 'Saving…' : 'Save'}
                  </button>
                </td>
              )}
            </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
