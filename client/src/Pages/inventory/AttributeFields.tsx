import type { StockAttributeDefinition } from '../../services/fetchServices';

interface AttributeFieldsProps {
  definitions: StockAttributeDefinition[];
  value: Record<string, string | boolean>;
  onChange: (next: Record<string, string | boolean>) => void;
  idPrefix: string;
}

const textInputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/**
 * Renders one input per active custom-field definition, keyed by the
 * definition's `key`. A NUMBER value stays a string end to end — never
 * `Number(...)`'d here — mirroring `utils/stockAttributes.ts`'s server-side
 * contract that a NUMBER attribute is a canonical decimal string, not a
 * float.
 */
export default function AttributeFields({ definitions, value, onChange, idPrefix }: AttributeFieldsProps) {
  function setField(key: string, fieldValue: string | boolean) {
    onChange({ ...value, [key]: fieldValue });
  }

  return (
    <div className="space-y-3">
      {definitions.map((def) => {
        const inputId = `${idPrefix}-${def.key}`;
        const labelText = `${def.label}${def.isRequired ? ' *' : ''}`;

        if (def.dataType === 'BOOLEAN') {
          const checked = value[def.key] === true;
          return (
            <div key={def.key}>
              <label htmlFor={inputId} className="flex items-center gap-1.5 text-sm text-[var(--text)]">
                <input
                  id={inputId}
                  type="checkbox"
                  checked={checked}
                  required={def.isRequired}
                  onChange={(e) => setField(def.key, e.target.checked)}
                />
                {labelText}
              </label>
            </div>
          );
        }

        if (def.dataType === 'SELECT') {
          const current = typeof value[def.key] === 'string' ? (value[def.key] as string) : '';
          return (
            <div key={def.key}>
              <label htmlFor={inputId} className="block text-sm text-[var(--text)] mb-1">
                {labelText}
              </label>
              <select
                id={inputId}
                value={current}
                required={def.isRequired}
                onChange={(e) => setField(def.key, e.target.value)}
                className={textInputClass}
              >
                <option value=""></option>
                {(def.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        const current = typeof value[def.key] === 'string' ? (value[def.key] as string) : '';
        return (
          <div key={def.key}>
            <label htmlFor={inputId} className="block text-sm text-[var(--text)] mb-1">
              {labelText}
            </label>
            <input
              id={inputId}
              type={def.dataType === 'DATE' ? 'date' : 'text'}
              inputMode={def.dataType === 'NUMBER' ? 'decimal' : undefined}
              required={def.isRequired}
              value={current}
              onChange={(e) => setField(def.key, e.target.value)}
              className={textInputClass}
            />
          </div>
        );
      })}
    </div>
  );
}
