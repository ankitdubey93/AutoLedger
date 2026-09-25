import { useEffect, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import TabBar from '../../components/ui/TabBar';
import PageHeader from '../../components/ui/PageHeader';
import {
  STOCK_ATTRIBUTE_TYPES,
  STOCK_ITEM_TYPES,
  STOCK_TRACKING_MODES,
  createStockAttribute,
  createStockCategory,
  createStockUom,
  fetchStockCategories,
  fetchStockCategory,
  fetchStockUoms,
  updateStockAttribute,
  updateStockCategory,
  updateStockUom,
  type StockAttributeDefinition,
  type StockAttributeScope,
  type StockAttributeType,
  type StockCategory,
  type StockItemType,
  type StockTrackingMode,
  type StockUom,
} from '../../services/fetchServices';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

/**
 * Inventory's own catalogue: units of measure, categories (nested up to
 * 3 levels) and, for the selected category, its ITEM and SERIAL custom
 * fields. Writing is catalogue configuration, so every form here is OWNER
 * or ADMIN only, matching the server's own role gate on these routes.
 */
export default function InventoryCatalogueSettingsPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN';

  const [uoms, setUoms] = useState<StockUom[]>([]);
  const [categories, setCategories] = useState<StockCategory[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [uomCode, setUomCode] = useState('');
  const [uomName, setUomName] = useState('');
  const [uomDecimalPlaces, setUomDecimalPlaces] = useState('0');

  const [categoryCode, setCategoryCode] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [categoryItemType, setCategoryItemType] = useState<StockItemType>('TRADING_GOOD');
  const [categoryTracking, setCategoryTracking] = useState<StockTrackingMode>('QUANTITY');
  const [categoryUomId, setCategoryUomId] = useState('');
  const [categoryParentId, setCategoryParentId] = useState('');

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [categoryAttributes, setCategoryAttributes] = useState<StockAttributeDefinition[]>([]);
  const [attributeScope, setAttributeScope] = useState<StockAttributeScope>('ITEM');

  const [attrKey, setAttrKey] = useState('');
  const [attrLabel, setAttrLabel] = useState('');
  const [attrDataType, setAttrDataType] = useState<StockAttributeType>('TEXT');
  const [attrOptions, setAttrOptions] = useState('');
  const [attrDecimalPlaces, setAttrDecimalPlaces] = useState('0');
  const [attrRequired, setAttrRequired] = useState(false);

  function reload() {
    setError(null);
    Promise.all([fetchStockUoms(true), fetchStockCategories(true)])
      .then(([uomsRes, categoriesRes]) => {
        setUoms(uomsRes.uoms);
        setCategories(categoriesRes.categories);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the catalogue'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedCategoryId === null) {
      setCategoryAttributes([]);
      return;
    }
    fetchStockCategory(selectedCategoryId)
      .then((res) => setCategoryAttributes(res.attributes))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load custom fields'));
  }, [selectedCategoryId]);

  async function handleCreateUom() {
    setError(null);
    try {
      await createStockUom({ code: uomCode, name: uomName, decimalPlaces: Number(uomDecimalPlaces) });
      setUomCode('');
      setUomName('');
      setUomDecimalPlaces('0');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the unit of measure');
    }
  }

  async function handleToggleUom(uom: StockUom) {
    setError(null);
    try {
      await updateStockUom(uom.id, { isActive: !uom.isActive });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the unit of measure');
    }
  }

  async function handleCreateCategory() {
    setError(null);
    try {
      await createStockCategory({
        code: categoryCode,
        name: categoryName,
        itemType: categoryItemType,
        defaultTracking: categoryTracking,
        defaultUomId: categoryUomId === '' ? null : categoryUomId,
        parentId: categoryParentId === '' ? null : categoryParentId,
      });
      setCategoryCode('');
      setCategoryName('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the category');
    }
  }

  async function handleToggleCategory(category: StockCategory) {
    setError(null);
    try {
      await updateStockCategory(category.id, { isActive: !category.isActive });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the category');
    }
  }

  function reloadAttributes() {
    if (selectedCategoryId === null) return;
    fetchStockCategory(selectedCategoryId)
      .then((res) => setCategoryAttributes(res.attributes))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load custom fields'));
  }

  async function handleCreateAttribute() {
    if (selectedCategoryId === null) return;
    setError(null);
    try {
      await createStockAttribute(selectedCategoryId, {
        key: attrKey,
        label: attrLabel,
        appliesTo: attributeScope,
        dataType: attrDataType,
        options:
          attrDataType === 'SELECT'
            ? attrOptions
                .split('\n')
                .map((o) => o.trim())
                .filter((o) => o.length > 0)
            : null,
        decimalPlaces: attrDataType === 'NUMBER' ? Number(attrDecimalPlaces) : null,
        isRequired: attrRequired,
        sortOrder: categoryAttributes.filter((a) => a.appliesTo === attributeScope).length,
      });
      setAttrKey('');
      setAttrLabel('');
      setAttrOptions('');
      setAttrRequired(false);
      reloadAttributes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the custom field');
    }
  }

  async function handleToggleAttribute(attribute: StockAttributeDefinition) {
    if (selectedCategoryId === null) return;
    setError(null);
    try {
      await updateStockAttribute(selectedCategoryId, attribute.id, { isActive: !attribute.isActive });
      reloadAttributes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the custom field');
    }
  }

  const visibleAttributes = categoryAttributes.filter((a) => a.appliesTo === attributeScope);
  const selectedCategory = categories.find((c) => c.id === selectedCategoryId) ?? null;

  return (
    <div className="space-y-8">
      <PageHeader as="h1" icon={SettingsIcon} title="Catalogue" />

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      <section aria-label="Units of measure" className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--text)]">Units of measure</h2>
        <ul className="space-y-1">
          {uoms.map((uom) => (
            <li key={uom.id} className="flex items-center justify-between text-sm">
              <span className={uom.isActive ? 'text-[var(--text)]' : 'text-[var(--muted)] line-through'}>
                {uom.code} — {uom.name} ({uom.decimalPlaces} dp)
              </span>
              {canWrite ? (
                <button type="button" onClick={() => void handleToggleUom(uom)} className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--panel-2)] transition-colors">
                  {uom.isActive ? 'Deactivate' : 'Activate'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {canWrite ? (
          <div className="flex flex-wrap gap-2 items-end">
            <input
              aria-label="Unit code"
              placeholder="Code"
              value={uomCode}
              onChange={(e) => setUomCode(e.target.value)}
              className={`${inputClass} w-24`}
            />
            <input
              aria-label="Unit name"
              placeholder="Name"
              value={uomName}
              onChange={(e) => setUomName(e.target.value)}
              className={`${inputClass} w-40`}
            />
            <select
              aria-label="Decimal places"
              value={uomDecimalPlaces}
              onChange={(e) => setUomDecimalPlaces(e.target.value)}
              className={`${inputClass} w-24`}
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n} dp
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleCreateUom()}
              className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white"
            >
              Add unit
            </button>
          </div>
        ) : null}
      </section>

      <section aria-label="Categories" className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--text)]">Categories</h2>
        <ul className="space-y-1">
          {categories.map((category) => (
            <li key={category.id} style={{ paddingLeft: `${(category.depth - 1) * 16}px` }}>
              <button
                type="button"
                title={category.path}
                onClick={() => setSelectedCategoryId(category.id)}
                className={[
                  'text-sm text-left',
                  category.id === selectedCategoryId ? 'font-medium text-[var(--text)]' : 'text-[var(--muted)]',
                  category.isActive ? '' : 'line-through',
                ].join(' ')}
              >
                {category.code} — {category.name}
              </button>
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => void handleToggleCategory(category)}
                  className="ml-2 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--panel-2)] transition-colors"
                >
                  {category.isActive ? 'Deactivate' : 'Activate'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {canWrite ? (
          <div className="flex flex-wrap gap-2 items-end">
            <input
              aria-label="Category code"
              placeholder="Code"
              value={categoryCode}
              onChange={(e) => setCategoryCode(e.target.value)}
              className={`${inputClass} w-24`}
            />
            <input
              aria-label="Category name"
              placeholder="Name"
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              className={`${inputClass} w-40`}
            />
            <select
              aria-label="Item type"
              value={categoryItemType}
              onChange={(e) => setCategoryItemType(e.target.value as StockItemType)}
              className={`${inputClass} w-40`}
            >
              {STOCK_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              aria-label="Default tracking"
              value={categoryTracking}
              onChange={(e) => setCategoryTracking(e.target.value as StockTrackingMode)}
              className={`${inputClass} w-32`}
            >
              {STOCK_TRACKING_MODES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              aria-label="Default unit"
              value={categoryUomId}
              onChange={(e) => setCategoryUomId(e.target.value)}
              className={`${inputClass} w-32`}
            >
              <option value="">No default unit</option>
              {uoms.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code}
                </option>
              ))}
            </select>
            <select
              aria-label="Parent category"
              value={categoryParentId}
              onChange={(e) => setCategoryParentId(e.target.value)}
              className={`${inputClass} w-40`}
            >
              <option value="">Top level</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleCreateCategory()}
              className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white"
            >
              Add category
            </button>
          </div>
        ) : null}
      </section>

      <section aria-label="Custom fields" className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--text)]">
          Custom fields{selectedCategory !== null ? ` — ${selectedCategory.name}` : ''}
        </h2>
        {selectedCategory === null ? (
          <p className="text-sm text-[var(--muted)]">Choose a category above to see or edit its custom fields.</p>
        ) : (
          <>
            <TabBar
              ariaLabel="Custom field scope"
              variant="buttons"
              active={attributeScope}
              onChange={(id) => setAttributeScope(id as StockAttributeScope)}
              items={[
                { id: 'ITEM', label: 'Item fields' },
                { id: 'SERIAL', label: 'Serial fields' },
              ]}
            />
            <ul className="space-y-1">
              {visibleAttributes.map((attribute) => (
                <li key={attribute.id} className="flex items-center justify-between text-sm">
                  <span className={attribute.isActive ? 'text-[var(--text)]' : 'text-[var(--muted)] line-through'}>
                    {attribute.label} ({attribute.dataType}
                    {attribute.isRequired ? ', required' : ''})
                  </span>
                  {canWrite ? (
                    <button
                      type="button"
                      onClick={() => void handleToggleAttribute(attribute)}
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--panel-2)] transition-colors"
                    >
                      {attribute.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {canWrite ? (
              <div className="flex flex-wrap gap-2 items-end">
                <input
                  aria-label="Field key"
                  placeholder="key"
                  value={attrKey}
                  onChange={(e) => setAttrKey(e.target.value)}
                  className={`${inputClass} w-28`}
                />
                <input
                  aria-label="Field label"
                  placeholder="Label"
                  value={attrLabel}
                  onChange={(e) => setAttrLabel(e.target.value)}
                  className={`${inputClass} w-32`}
                />
                <select
                  aria-label="Field type"
                  value={attrDataType}
                  onChange={(e) => setAttrDataType(e.target.value as StockAttributeType)}
                  className={`${inputClass} w-28`}
                >
                  {STOCK_ATTRIBUTE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {attrDataType === 'SELECT' ? (
                  <textarea
                    aria-label="Options (one per line)"
                    placeholder={'One option per line'}
                    value={attrOptions}
                    onChange={(e) => setAttrOptions(e.target.value)}
                    className={`${inputClass} w-40 h-16`}
                  />
                ) : null}
                {attrDataType === 'NUMBER' ? (
                  <select
                    aria-label="Field decimal places"
                    value={attrDecimalPlaces}
                    onChange={(e) => setAttrDecimalPlaces(e.target.value)}
                    className={`${inputClass} w-24`}
                  >
                    {[0, 1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n} dp
                      </option>
                    ))}
                  </select>
                ) : null}
                <label className="flex items-center gap-1.5 text-sm text-[var(--text)]">
                  <input type="checkbox" checked={attrRequired} onChange={(e) => setAttrRequired(e.target.checked)} />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => void handleCreateAttribute()}
                  className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white"
                >
                  Add field
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
