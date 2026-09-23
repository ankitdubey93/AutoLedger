import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppBasePath } from '../../apps/useAppBasePath';
import AttributeFields from './AttributeFields';
import { parseQuantityToMilli } from '../../utils/quantity';
import {
  createStockItem,
  fetchStockCategories,
  fetchStockCategory,
  fetchStockCodeSchemes,
  fetchStockUoms,
  previewStockCodePattern,
  type StockAttributeDefinition,
  type StockCategory,
  type StockCodeScheme,
  type StockTrackingMode,
  type StockUom,
} from '../../services/fetchServices';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/**
 * StockLedger's new-item form. Choosing a category loads its ITEM custom
 * fields and pre-fills the unit and tracking mode from the category's own
 * defaults (both stay editable — a category default is a starting point,
 * not a lock). Code is either generated live from a chosen scheme or typed
 * by hand; the scheme preview re-runs 300ms after the pattern-relevant
 * inputs settle, mirroring `StockCodeSchemesPage`'s own debounce.
 */
export default function StockNewItemPage() {
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [categories, setCategories] = useState<StockCategory[]>([]);
  const [uoms, setUoms] = useState<StockUom[]>([]);
  const [codeSchemes, setCodeSchemes] = useState<StockCodeScheme[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categoryAttributeDefs, setCategoryAttributeDefs] = useState<StockAttributeDefinition[]>([]);
  const [attributes, setAttributes] = useState<Record<string, string | boolean>>({});
  const [uomId, setUomId] = useState('');
  const [tracking, setTracking] = useState<StockTrackingMode>('QUANTITY');

  const [codeMode, setCodeMode] = useState<'generate' | 'manual'>('generate');
  const [codeSchemeId, setCodeSchemeId] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [preview, setPreview] = useState<{ valid: boolean; example?: string | undefined; error?: string | undefined } | null>(
    null,
  );

  const [barcode, setBarcode] = useState('');
  const [reorderPointText, setReorderPointText] = useState('');

  useEffect(() => {
    Promise.all([fetchStockCategories(), fetchStockUoms(), fetchStockCodeSchemes()])
      .then(([categoriesRes, uomsRes, schemesRes]) => {
        setCategories(categoriesRes.categories);
        setUoms(uomsRes.uoms);
        setCodeSchemes(schemesRes.codeSchemes);
        const defaultScheme = schemesRes.codeSchemes.find((s) => s.isDefault);
        if (defaultScheme !== undefined) setCodeSchemeId(defaultScheme.id);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load setup data'));
  }, []);

  useEffect(() => {
    if (categoryId === '') {
      setCategoryAttributeDefs([]);
      return;
    }
    fetchStockCategory(categoryId)
      .then((res) => {
        setCategoryAttributeDefs(res.attributes.filter((a) => a.appliesTo === 'ITEM'));
        setUomId(res.category.defaultUomId ?? '');
        setTracking(res.category.defaultTracking);
        setAttributes({});
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the category'));
  }, [categoryId]);

  useEffect(() => {
    if (codeMode !== 'generate' || categoryId === '' || codeSchemeId === '') {
      setPreview(null);
      return undefined;
    }
    const scheme = codeSchemes.find((s) => s.id === codeSchemeId);
    if (scheme === undefined) return undefined;

    const timer = setTimeout(() => {
      previewStockCodePattern({ pattern: scheme.pattern, categoryId, attributes })
        .then((res) => setPreview({ valid: res.valid, example: res.example, error: res.error }))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [codeMode, categoryId, codeSchemeId, attributes, codeSchemes]);

  const uomDecimalPlaces = uoms.find((u) => u.id === uomId)?.decimalPlaces ?? 3;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const reorderPointMilli =
      reorderPointText.trim() === '' ? null : parseQuantityToMilli(reorderPointText, uomDecimalPlaces);
    if (reorderPointText.trim() !== '' && reorderPointMilli === null) {
      setError(`Reorder point allows at most ${uomDecimalPlaces} decimal places`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await createStockItem({
        name,
        description: description.trim() === '' ? null : description,
        categoryId,
        uomId: uomId === '' ? null : uomId,
        tracking,
        code: codeMode === 'manual' ? manualCode.toUpperCase() : null,
        codeSchemeId: codeMode === 'generate' ? codeSchemeId : null,
        barcode: barcode.trim() === '' ? null : barcode.trim(),
        attributes,
        reorderPointMilli,
      });
      navigate(`${base}/items/${res.item.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the item');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="max-w-xl space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">New item</h1>

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      <div>
        <label htmlFor="new-item-name" className="block text-sm text-[var(--text)] mb-1">
          Name *
        </label>
        <input id="new-item-name" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </div>

      <div>
        <label htmlFor="new-item-description" className="block text-sm text-[var(--text)] mb-1">
          Description
        </label>
        <textarea
          id="new-item-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${inputClass} h-16`}
        />
      </div>

      <div>
        <label htmlFor="new-item-category" className="block text-sm text-[var(--text)] mb-1">
          Category *
        </label>
        <select
          id="new-item-category"
          required
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose a category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.path}
            </option>
          ))}
        </select>
      </div>

      {categoryId !== '' ? (
        <div className="flex flex-wrap gap-4">
          <div>
            <label htmlFor="new-item-uom" className="block text-sm text-[var(--text)] mb-1">
              Unit of measure
            </label>
            <select id="new-item-uom" value={uomId} onChange={(e) => setUomId(e.target.value)} className={inputClass}>
              <option value="">Choose a unit</option>
              {uoms.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-item-tracking" className="block text-sm text-[var(--text)] mb-1">
              Tracking
            </label>
            <select
              id="new-item-tracking"
              value={tracking}
              onChange={(e) => setTracking(e.target.value as StockTrackingMode)}
              className={inputClass}
            >
              <option value="QUANTITY">QUANTITY</option>
              <option value="LOT">LOT</option>
              <option value="SERIAL">SERIAL</option>
            </select>
          </div>
        </div>
      ) : null}

      {categoryAttributeDefs.length > 0 ? (
        <AttributeFields definitions={categoryAttributeDefs} value={attributes} onChange={setAttributes} idPrefix="new-item-attr" />
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm text-[var(--text)]">Item code</legend>
        <label className="flex items-center gap-1.5 text-sm text-[var(--text)]">
          <input type="radio" name="codeMode" checked={codeMode === 'generate'} onChange={() => setCodeMode('generate')} />
          Generate from scheme
        </label>
        {codeMode === 'generate' ? (
          <div className="ml-5 space-y-1">
            <select
              aria-label="Code scheme"
              value={codeSchemeId}
              onChange={(e) => setCodeSchemeId(e.target.value)}
              className={inputClass}
            >
              {codeSchemes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.pattern})
                </option>
              ))}
            </select>
            {preview !== null ? (
              preview.valid ? (
                <p className="text-sm text-[var(--text)]">
                  Preview: <strong>{preview.example}</strong>
                </p>
              ) : (
                <p role="alert" className="text-sm text-[var(--bad)]">
                  {preview.error}
                </p>
              )
            ) : null}
          </div>
        ) : null}

        <label className="flex items-center gap-1.5 text-sm text-[var(--text)]">
          <input type="radio" name="codeMode" checked={codeMode === 'manual'} onChange={() => setCodeMode('manual')} />
          Enter manually
        </label>
        {codeMode === 'manual' ? (
          <div className="ml-5">
            <input
              aria-label="Item code"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              onBlur={() => setManualCode((c) => c.toUpperCase())}
              className={inputClass}
            />
          </div>
        ) : null}
      </fieldset>

      <div>
        <label htmlFor="new-item-barcode" className="block text-sm text-[var(--text)] mb-1">
          Barcode
        </label>
        <input id="new-item-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} className={inputClass} />
      </div>

      <div>
        <label htmlFor="new-item-reorder" className="block text-sm text-[var(--text)] mb-1">
          Reorder point
        </label>
        <input
          id="new-item-reorder"
          value={reorderPointText}
          onChange={(e) => setReorderPointText(e.target.value)}
          className={inputClass}
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        Create item
      </button>
    </form>
  );
}
