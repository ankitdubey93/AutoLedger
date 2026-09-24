import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  createStockCodeScheme,
  fetchStockCategories,
  fetchStockCategory,
  fetchStockCodePresets,
  fetchStockCodeSchemes,
  previewStockCodePattern,
  updateStockCodeScheme,
  type StockAttributeDefinition,
  type StockCategory,
  type StockCodeScheme,
  type StockCodeSchemePreset,
} from '../../services/fetchServices';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

interface PreviewResult {
  valid: boolean;
  example?: string | undefined;
  scopeKey?: string | undefined;
  error?: string | undefined;
}

/**
 * StockLedger's item-code schemes: a builder that inserts pattern tokens
 * (`{CAT}`, `{YYYY}`, `{YY}`, `{ATTR:key:n}`, `{SEQ:n}`), a debounced live
 * preview against the real parser/renderer, ready-made presets, and the
 * list of saved schemes with a default-swap action per row.
 */
export default function StockCodeSchemesPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN';

  const [schemes, setSchemes] = useState<StockCodeScheme[]>([]);
  const [categories, setCategories] = useState<StockCategory[]>([]);
  const [presets, setPresets] = useState<StockCodeSchemePreset[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [pattern, setPattern] = useState('');
  const [previewCategoryId, setPreviewCategoryId] = useState('');
  const [previewCategoryAttributes, setPreviewCategoryAttributes] = useState<StockAttributeDefinition[]>([]);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);

  const [attrFormOpen, setAttrFormOpen] = useState(false);
  const [attrFormKey, setAttrFormKey] = useState('');
  const [attrFormLength, setAttrFormLength] = useState('3');

  const [seqFormOpen, setSeqFormOpen] = useState(false);
  const [seqFormWidth, setSeqFormWidth] = useState('5');

  const [schemeName, setSchemeName] = useState('');
  const [schemeIsDefault, setSchemeIsDefault] = useState(false);

  function reload() {
    setError(null);
    Promise.all([fetchStockCodeSchemes(true), fetchStockCategories(), fetchStockCodePresets()])
      .then(([schemesRes, categoriesRes, presetsRes]) => {
        setSchemes(schemesRes.codeSchemes);
        setCategories(categoriesRes.categories);
        setPresets(presetsRes.presets);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load code schemes'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (previewCategoryId === '') {
      setPreviewCategoryAttributes([]);
      return;
    }
    fetchStockCategory(previewCategoryId)
      .then((res) => setPreviewCategoryAttributes(res.attributes.filter((a) => a.appliesTo === 'ITEM')))
      .catch(() => setPreviewCategoryAttributes([]));
  }, [previewCategoryId]);

  useEffect(() => {
    if (pattern.trim() === '') {
      setPreviewResult(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      previewStockCodePattern({
        pattern,
        categoryId: previewCategoryId === '' ? null : previewCategoryId,
        attributes: {},
      })
        .then((res) => setPreviewResult({ valid: res.valid, example: res.example, scopeKey: res.scopeKey, error: res.error }))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not preview the pattern'));
    }, 300);
    return () => clearTimeout(timer);
  }, [pattern, previewCategoryId]);

  function appendToken(token: string) {
    setPattern((p) => p + token);
  }

  function handleInsertAttribute() {
    if (attrFormKey === '') return;
    appendToken(`{ATTR:${attrFormKey}:${attrFormLength}}`);
    setAttrFormOpen(false);
  }

  function handleInsertSequence() {
    appendToken(`{SEQ:${seqFormWidth}}`);
    setSeqFormOpen(false);
  }

  function handleUsePreset(preset: StockCodeSchemePreset) {
    setPattern(preset.pattern);
  }

  async function handleSave() {
    setError(null);
    try {
      await createStockCodeScheme({ name: schemeName, pattern, isDefault: schemeIsDefault });
      setSchemeName('');
      setSchemeIsDefault(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the code scheme');
    }
  }

  async function handleMakeDefault(scheme: StockCodeScheme) {
    setError(null);
    try {
      await updateStockCodeScheme(scheme.id, { isDefault: true });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the default scheme');
    }
  }

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-lg font-semibold text-[var(--text)]">Item codes</h1>

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      <section aria-label="Saved schemes" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Saved schemes</h2>
        <ul className="space-y-1">
          {schemes.map((scheme) => (
            <li key={scheme.id} className="flex items-center gap-2 text-sm">
              <span className="text-[var(--text)]">{scheme.name}</span>
              <code className="text-[var(--muted)]">{scheme.pattern}</code>
              <span className="text-[var(--muted)]">example {scheme.example}</span>
              {scheme.isDefault ? (
                <span className="text-xs rounded-full bg-[var(--panel)] px-2 py-0.5 text-[var(--muted)]">default</span>
              ) : canWrite ? (
                <button type="button" onClick={() => void handleMakeDefault(scheme)} className="text-xs text-[var(--muted)]">
                  Make default
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {canWrite ? (
        <section aria-label="Builder" className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--text)]">Builder</h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => appendToken('{CAT}')} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]">
              Category
            </button>
            <button type="button" onClick={() => appendToken('{YYYY}')} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]">
              Year (YYYY)
            </button>
            <button type="button" onClick={() => appendToken('{YY}')} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]">
              Year (YY)
            </button>
            <button type="button" onClick={() => setAttrFormOpen(true)} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]">
              Attribute…
            </button>
            <button type="button" onClick={() => setSeqFormOpen(true)} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]">
              Sequence…
            </button>
            <button type="button" onClick={() => appendToken('-')} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]">
              -
            </button>
            <button type="button" onClick={() => appendToken('/')} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]">
              /
            </button>
          </div>

          {attrFormOpen ? (
            <div className="flex flex-wrap items-end gap-2">
              <select aria-label="Attribute key" value={attrFormKey} onChange={(e) => setAttrFormKey(e.target.value)} className={`${inputClass} w-40`}>
                <option value="">Choose an attribute</option>
                {previewCategoryAttributes.map((a) => (
                  <option key={a.id} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
              <label className="text-sm text-[var(--text)]">
                Length
                <input
                  aria-label="Attribute length"
                  type="number"
                  min={1}
                  max={10}
                  value={attrFormLength}
                  onChange={(e) => setAttrFormLength(e.target.value)}
                  className={`${inputClass} w-16 ml-1`}
                />
              </label>
              <button type="button" onClick={handleInsertAttribute} className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white">
                Insert
              </button>
            </div>
          ) : null}

          {seqFormOpen ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm text-[var(--text)]">
                Width
                <input
                  aria-label="Sequence width"
                  type="number"
                  min={3}
                  max={8}
                  value={seqFormWidth}
                  onChange={(e) => setSeqFormWidth(e.target.value)}
                  className={`${inputClass} w-16 ml-1`}
                />
              </label>
              <button type="button" onClick={handleInsertSequence} className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white">
                Insert
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm text-[var(--text)] flex-1 min-w-[12rem]">
              Pattern
              <input
                aria-label="Pattern"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                className={`${inputClass} w-full mt-1`}
              />
            </label>
            <select aria-label="Preview category" value={previewCategoryId} onChange={(e) => setPreviewCategoryId(e.target.value)} className={`${inputClass} w-40`}>
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </select>
          </div>

          {previewResult !== null ? (
            previewResult.valid ? (
              <p className="text-sm text-[var(--text)]">
                Example: <strong>{previewResult.example}</strong>
                {previewResult.scopeKey !== undefined ? (
                  <span className="text-[var(--muted)]"> — Numbering restarts per: {previewResult.scopeKey}</span>
                ) : null}
              </p>
            ) : (
              <p role="alert" className="text-sm text-[var(--bad)]">
                {previewResult.error}
              </p>
            )
          ) : null}

          <div className="flex flex-wrap items-end gap-2">
            <input
              aria-label="Scheme name"
              placeholder="Scheme name"
              value={schemeName}
              onChange={(e) => setSchemeName(e.target.value)}
              className={`${inputClass} w-48`}
            />
            <label className="flex items-center gap-1.5 text-sm text-[var(--text)]">
              <input type="checkbox" checked={schemeIsDefault} onChange={(e) => setSchemeIsDefault(e.target.checked)} />
              Make default
            </label>
            <button type="button" onClick={() => void handleSave()} className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white">
              Save
            </button>
          </div>
        </section>
      ) : null}

      <section aria-label="Presets" className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Presets</h2>
        <ul className="space-y-1">
          {presets.map((preset) => (
            <li key={preset.name} className="flex items-center gap-2 text-sm">
              <span className="text-[var(--text)]">{preset.name}</span>
              <code className="text-[var(--muted)]">{preset.pattern}</code>
              <span className="text-[var(--muted)]">{preset.description}</span>
              {canWrite ? (
                <button type="button" onClick={() => handleUsePreset(preset)} className="text-xs text-[var(--muted)]">
                  Use this
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
