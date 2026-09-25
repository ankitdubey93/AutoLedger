import type {
  StockAttributeScope,
  StockAttributeType,
  StockIndustryKey,
  StockItemType,
  StockLocationKind,
  StockTrackingMode,
} from '../types/inventory.js';

/**
 * Inventory (Phase 28) — the ten industry starting points offered on
 * `POST /inventory/setup`. Applying one (`setupService.applyIndustryProfile`)
 * COPIES its units, categories, custom fields, code schemes and a default
 * location into the org's own tables — after that the org owns and can
 * edit every row. This file only ever *seeds*; it is never read at
 * request time for anything but the seed itself and the suggestion.
 *
 * `as const satisfies readonly StockIndustryProfile[]` on the array below
 * mirrors `config/modules.ts`: `satisfies` checks every entry against the
 * interface while `as const` keeps literal fields (like `key`) narrowed to
 * their own string literal type rather than widening to `string`.
 */

export interface ProfileUom {
  code: string;
  name: string;
  decimalPlaces: 0 | 1 | 2 | 3;
}

export interface ProfileAttribute {
  key: string;
  label: string;
  appliesTo: StockAttributeScope;
  dataType: StockAttributeType;
  options: readonly string[] | null;
  decimalPlaces: number | null;
  isRequired: boolean;
}

export interface ProfileCategory {
  code: string;
  name: string;
  itemType: StockItemType;
  defaultTracking: StockTrackingMode;
  defaultUomCode: string;
  attributes: readonly ProfileAttribute[];
}

export interface StockIndustryProfile {
  key: StockIndustryKey;
  name: string;
  description: string;
  industryKeywords: readonly string[];
  defaultLocation: { code: string; name: string; kind: Extract<StockLocationKind, 'WAREHOUSE' | 'STORE' | 'SITE'> };
  uoms: readonly ProfileUom[];
  categories: readonly ProfileCategory[];
  codeSchemes: readonly { name: string; pattern: string; isDefault: boolean }[];
}

/**
 * Attribute labels are the key in sentence case with underscores replaced
 * by spaces, except for these overrides — abbreviations and compound units
 * that sentence-casing alone would render badly (HSN code, not Hsn code).
 */
const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  hsn_code: 'HSN code',
  rera_number: 'RERA number',
  imei: 'IMEI',
  gsm: 'GSM',
  oem: 'OEM',
  carpet_area_sqft: 'Carpet area (sq ft)',
  plot_area_sqft: 'Plot area (sq ft)',
  shelf_life_days: 'Shelf life (days)',
};

function labelFor(key: string): string {
  const override = LABEL_OVERRIDES[key];
  if (override !== undefined) return override;
  const sentence = key.split('_').join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

interface AttrOptions {
  scope?: StockAttributeScope;
  required?: boolean;
  options?: readonly string[];
  decimalPlaces?: number;
}

/** Builds one custom-field definition. ITEM scope and optional are the defaults. */
function attr(key: string, dataType: StockAttributeType, opts: AttrOptions = {}): ProfileAttribute {
  return {
    key,
    label: labelFor(key),
    appliesTo: opts.scope ?? 'ITEM',
    dataType,
    options: opts.options ?? null,
    decimalPlaces: opts.decimalPlaces ?? null,
    isRequired: opts.required ?? false,
  };
}

function uom(code: string, name: string, decimalPlaces: 0 | 1 | 2 | 3): ProfileUom {
  return { code, name, decimalPlaces };
}

function scheme(name: string, pattern: string, isDefault: boolean): { name: string; pattern: string; isDefault: boolean } {
  return { name, pattern, isDefault };
}

/** Added to every org's palette on top of whatever a profile's own `uoms` contribute. */
export const COMMON_UOMS: readonly ProfileUom[] = [
  uom('EA', 'Each', 0),
  uom('BOX', 'Box', 0),
  uom('KG', 'Kilogram', 3),
  uom('G', 'Gram', 0),
  uom('L', 'Litre', 3),
  uom('ML', 'Millilitre', 0),
  uom('M', 'Metre', 3),
];

export const CODE_SCHEME_PRESETS: readonly { name: string; pattern: string; description: string }[] = [
  { name: 'Category + number', pattern: '{CAT}-{SEQ:5}', description: 'Short category code, then a running number per category' },
  { name: 'Category + year', pattern: '{CAT}-{YY}-{SEQ:4}', description: 'Numbering restarts each year within each category' },
  { name: 'Plain number', pattern: '{SEQ:6}', description: 'One running number for everything' },
  { name: 'Brand + number', pattern: '{ATTR:brand:3}-{SEQ:5}', description: 'First three letters of the brand attribute' },
  { name: 'Style-color-size', pattern: '{CAT}-{ATTR:color:3}-{ATTR:size:3}-{SEQ:4}', description: 'One code per variant (apparel, footwear)' },
  { name: 'Grade-coded', pattern: '{CAT}-{ATTR:grade:4}-{SEQ:4}', description: 'Raw materials by grade' },
  { name: 'Project + category', pattern: '{ATTR:project:4}-{CAT}-{SEQ:3}', description: 'Real estate, per project' },
];

const FACING_OPTIONS = [
  'North', 'South', 'East', 'West', 'North-East', 'North-West', 'South-East', 'South-West',
] as const;

export const STOCK_INDUSTRY_PROFILES = [
  {
    key: 'RETAIL',
    name: 'Retail store',
    description: 'Shops and supermarkets selling finished goods to consumers.',
    industryKeywords: ['retail', 'shop', 'store', 'supermarket', 'grocery', 'boutique', 'kirana'],
    defaultLocation: { code: 'STORE-1', name: 'Main store', kind: 'STORE' },
    uoms: [uom('PACK', 'Pack', 0), uom('DOZ', 'Dozen', 0)],
    categories: [
      {
        code: 'MER',
        name: 'Merchandise',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [attr('brand', 'TEXT'), attr('variant', 'TEXT'), attr('shelf_life_days', 'NUMBER', { decimalPlaces: 0 })],
      },
      {
        code: 'PKG',
        name: 'Packaging & bags',
        itemType: 'PACKAGING',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
      {
        code: 'CON',
        name: 'Store consumables',
        itemType: 'CONSUMABLE',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
    ],
    codeSchemes: [scheme('Category + number', '{CAT}-{SEQ:5}', true), scheme('Category + year', '{CAT}-{YY}-{SEQ:4}', false)],
  },
  {
    key: 'WHOLESALE_DISTRIBUTION',
    name: 'Wholesale & distribution',
    description: 'Traders and distributors buying and reselling in bulk.',
    industryKeywords: ['wholesale', 'distribut', 'trading', 'trader', 'import', 'export', 'stockist'],
    defaultLocation: { code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE' },
    uoms: [uom('CTN', 'Carton', 0), uom('DOZ', 'Dozen', 0), uom('TON', 'Tonne', 3)],
    categories: [
      {
        code: 'TRD',
        name: 'Trading goods',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'CTN',
        attributes: [attr('brand', 'TEXT'), attr('hsn_code', 'TEXT'), attr('pack_size', 'TEXT')],
      },
      {
        code: 'PKG',
        name: 'Packaging',
        itemType: 'PACKAGING',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
    ],
    codeSchemes: [scheme('Category + number', '{CAT}-{SEQ:5}', true), scheme('Brand + number', '{ATTR:brand:3}-{SEQ:5}', false)],
  },
  {
    key: 'MANUFACTURING',
    name: 'Manufacturing',
    description: 'Factories converting raw materials into finished goods.',
    industryKeywords: ['manufactur', 'factory', 'production', 'fabricat', 'industrial', 'engineering', 'plant'],
    defaultLocation: { code: 'MAIN', name: 'Main plant store', kind: 'WAREHOUSE' },
    uoms: [uom('TON', 'Tonne', 3), uom('SET', 'Set', 0), uom('ROLL', 'Roll', 0), uom('SQM', 'Square metre', 2)],
    categories: [
      {
        code: 'RM',
        name: 'Raw materials',
        itemType: 'RAW_MATERIAL',
        defaultTracking: 'LOT',
        defaultUomCode: 'KG',
        attributes: [attr('grade', 'TEXT', { required: true }), attr('specification', 'TEXT'), attr('hsn_code', 'TEXT')],
      },
      {
        code: 'CMP',
        name: 'Components',
        itemType: 'COMPONENT',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [attr('part_number', 'TEXT', { required: true }), attr('drawing_rev', 'TEXT')],
      },
      {
        code: 'WIP',
        name: 'Work in progress',
        itemType: 'WORK_IN_PROGRESS',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
      {
        code: 'FG',
        name: 'Finished goods',
        itemType: 'FINISHED_GOOD',
        defaultTracking: 'LOT',
        defaultUomCode: 'EA',
        attributes: [attr('model', 'TEXT')],
      },
      {
        code: 'PKG',
        name: 'Packaging material',
        itemType: 'PACKAGING',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
      {
        code: 'SPR',
        name: 'Stores & spares',
        itemType: 'SPARE_PART',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [attr('machine', 'TEXT')],
      },
      {
        code: 'CON',
        name: 'Consumables',
        itemType: 'CONSUMABLE',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
    ],
    codeSchemes: [
      scheme('Category + number', '{CAT}-{SEQ:5}', true),
      scheme('Category + year', '{CAT}-{YY}-{SEQ:4}', false),
      scheme('Grade-coded', '{CAT}-{ATTR:grade:4}-{SEQ:4}', false),
    ],
  },
  {
    key: 'FOOD_BEVERAGE',
    name: 'Food & beverage',
    description: 'Food producers, restaurants and caterers with perishable stock.',
    industryKeywords: ['food', 'beverage', 'restaurant', 'bakery', 'cafe', 'catering', 'dairy', 'fmcg', 'hotel'],
    defaultLocation: { code: 'MAIN', name: 'Main store room', kind: 'WAREHOUSE' },
    uoms: [uom('BTL', 'Bottle', 0), uom('PACK', 'Pack', 0)],
    categories: [
      {
        code: 'ING',
        name: 'Ingredients',
        itemType: 'RAW_MATERIAL',
        defaultTracking: 'LOT',
        defaultUomCode: 'KG',
        attributes: [
          attr('storage', 'SELECT', { required: true, options: ['Ambient', 'Chilled', 'Frozen'] }),
          attr('allergens', 'TEXT'),
        ],
      },
      {
        code: 'FG',
        name: 'Finished products',
        itemType: 'FINISHED_GOOD',
        defaultTracking: 'LOT',
        defaultUomCode: 'EA',
        attributes: [
          attr('storage', 'SELECT', { required: true, options: ['Ambient', 'Chilled', 'Frozen'] }),
          attr('shelf_life_days', 'NUMBER', { required: true, decimalPlaces: 0 }),
        ],
      },
      {
        code: 'PKG',
        name: 'Packaging',
        itemType: 'PACKAGING',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
    ],
    codeSchemes: [scheme('Category + number', '{CAT}-{SEQ:5}', true)],
  },
  {
    key: 'PHARMA_HEALTHCARE',
    name: 'Pharma & healthcare',
    description: 'Chemists, distributors and hospitals with batch- and expiry-tracked stock.',
    industryKeywords: ['pharma', 'medical', 'chemist', 'hospital', 'clinic', 'healthcare', 'drug', 'diagnostic'],
    defaultLocation: { code: 'MAIN', name: 'Main store', kind: 'WAREHOUSE' },
    uoms: [uom('STRIP', 'Strip', 0), uom('BTL', 'Bottle', 0), uom('VIAL', 'Vial', 0)],
    categories: [
      {
        code: 'MED',
        name: 'Medicines',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'LOT',
        defaultUomCode: 'STRIP',
        attributes: [
          attr('generic_name', 'TEXT', { required: true }),
          attr('strength', 'TEXT'),
          attr('dosage_form', 'SELECT', {
            required: true,
            options: ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 'Drops', 'Other'],
          }),
          attr('schedule', 'SELECT', { required: true, options: ['OTC', 'G', 'H', 'H1', 'X'] }),
          attr('manufacturer', 'TEXT'),
        ],
      },
      {
        code: 'SUR',
        name: 'Surgical & consumables',
        itemType: 'CONSUMABLE',
        defaultTracking: 'LOT',
        defaultUomCode: 'EA',
        attributes: [attr('sterile', 'BOOLEAN')],
      },
      {
        code: 'EQP',
        name: 'Equipment',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'SERIAL',
        defaultUomCode: 'EA',
        attributes: [attr('model', 'TEXT', { required: true }), attr('warranty_until', 'DATE', { scope: 'SERIAL' })],
      },
    ],
    codeSchemes: [scheme('Category + number', '{CAT}-{SEQ:5}', true)],
  },
  {
    key: 'APPAREL_FOOTWEAR',
    name: 'Apparel & footwear',
    description: 'Clothing and footwear sold in size and colour variants.',
    industryKeywords: ['apparel', 'garment', 'clothing', 'fashion', 'textile', 'footwear', 'shoe'],
    defaultLocation: { code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE' },
    uoms: [uom('PAIR', 'Pair', 0)],
    categories: [
      {
        code: 'APP',
        name: 'Apparel',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [
          attr('size', 'SELECT', { required: true, options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] }),
          attr('color', 'TEXT', { required: true }),
          attr('fabric', 'TEXT'),
          attr('style_number', 'TEXT'),
        ],
      },
      {
        code: 'FTW',
        name: 'Footwear',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'PAIR',
        attributes: [
          attr('size', 'SELECT', { required: true, options: ['5', '6', '7', '8', '9', '10', '11', '12'] }),
          attr('color', 'TEXT', { required: true }),
        ],
      },
      {
        code: 'FAB',
        name: 'Fabric & trims',
        itemType: 'RAW_MATERIAL',
        defaultTracking: 'LOT',
        defaultUomCode: 'M',
        attributes: [attr('gsm', 'NUMBER', { decimalPlaces: 0 }), attr('color', 'TEXT')],
      },
    ],
    codeSchemes: [
      scheme('Category + number', '{CAT}-{SEQ:5}', true),
      scheme('Style-color-size', '{CAT}-{ATTR:color:3}-{ATTR:size:3}-{SEQ:4}', false),
    ],
  },
  {
    key: 'ELECTRONICS',
    name: 'Electronics & appliances',
    description: 'Devices tracked by serial or IMEI, plus accessories and spares.',
    industryKeywords: ['electronic', 'mobile', 'computer', 'appliance', 'gadget', 'electrical'],
    defaultLocation: { code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE' },
    uoms: [],
    categories: [
      {
        code: 'DEV',
        name: 'Devices',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'SERIAL',
        defaultUomCode: 'EA',
        attributes: [
          attr('brand', 'TEXT', { required: true }),
          attr('model', 'TEXT', { required: true }),
          attr('imei', 'TEXT', { scope: 'SERIAL' }),
          attr('warranty_until', 'DATE', { scope: 'SERIAL' }),
        ],
      },
      {
        code: 'ACC',
        name: 'Accessories',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [attr('brand', 'TEXT'), attr('compatible_with', 'TEXT')],
      },
      {
        code: 'SPR',
        name: 'Spare parts',
        itemType: 'SPARE_PART',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [attr('part_number', 'TEXT')],
      },
    ],
    codeSchemes: [scheme('Category + number', '{CAT}-{SEQ:5}', true), scheme('Brand + number', '{ATTR:brand:3}-{SEQ:5}', false)],
  },
  {
    key: 'AUTOMOTIVE',
    name: 'Automotive',
    description: 'Vehicle dealers and parts sellers; each vehicle is tracked by chassis number.',
    industryKeywords: ['automotive', 'automobile', 'vehicle', 'dealership', 'auto parts', 'garage', 'motor'],
    defaultLocation: { code: 'MAIN', name: 'Main yard', kind: 'WAREHOUSE' },
    uoms: [],
    categories: [
      {
        code: 'VEH',
        name: 'Vehicles',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'SERIAL',
        defaultUomCode: 'EA',
        attributes: [
          attr('make', 'TEXT', { required: true }),
          attr('model', 'TEXT', { required: true }),
          attr('variant', 'TEXT'),
          attr('fuel', 'SELECT', { required: true, options: ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'] }),
          attr('chassis_number', 'TEXT', { scope: 'SERIAL', required: true }),
          attr('engine_number', 'TEXT', { scope: 'SERIAL' }),
          attr('color', 'TEXT', { scope: 'SERIAL' }),
          attr('model_year', 'NUMBER', { scope: 'SERIAL', decimalPlaces: 0 }),
        ],
      },
      {
        code: 'PRT',
        name: 'Spare parts',
        itemType: 'SPARE_PART',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [attr('part_number', 'TEXT', { required: true }), attr('oem', 'TEXT')],
      },
      {
        code: 'LUB',
        name: 'Lubricants & fluids',
        itemType: 'CONSUMABLE',
        defaultTracking: 'LOT',
        defaultUomCode: 'L',
        attributes: [attr('grade', 'TEXT')],
      },
    ],
    codeSchemes: [scheme('Category + number', '{CAT}-{SEQ:5}', true)],
  },
  {
    key: 'REAL_ESTATE',
    name: 'Real estate',
    description: 'Developers holding units, plots and construction materials; each unit is tracked individually.',
    industryKeywords: ['real estate', 'realty', 'property', 'developer', 'construction', 'builder', 'infrastructure'],
    defaultLocation: { code: 'SITE-1', name: 'Project site', kind: 'SITE' },
    uoms: [uom('UNIT', 'Unit', 0), uom('SQFT', 'Square foot', 2), uom('SQM', 'Square metre', 2), uom('BAG', 'Bag', 0), uom('TON', 'Tonne', 3)],
    categories: [
      {
        code: 'RES',
        name: 'Residential units',
        itemType: 'PROPERTY_UNIT',
        defaultTracking: 'SERIAL',
        defaultUomCode: 'UNIT',
        attributes: [
          attr('project', 'TEXT', { required: true }),
          attr('configuration', 'SELECT', {
            required: true,
            options: ['Studio', '1 BHK', '2 BHK', '3 BHK', '4 BHK', 'Villa', 'Penthouse'],
          }),
          attr('rera_number', 'TEXT'),
          attr('tower', 'TEXT', { scope: 'SERIAL', required: true }),
          attr('floor', 'NUMBER', { scope: 'SERIAL', required: true, decimalPlaces: 0 }),
          attr('carpet_area_sqft', 'NUMBER', { scope: 'SERIAL', required: true, decimalPlaces: 2 }),
          attr('facing', 'SELECT', { scope: 'SERIAL', options: FACING_OPTIONS }),
          attr('parking_slots', 'NUMBER', { scope: 'SERIAL', decimalPlaces: 0 }),
        ],
      },
      {
        code: 'COM',
        name: 'Commercial units',
        itemType: 'PROPERTY_UNIT',
        defaultTracking: 'SERIAL',
        defaultUomCode: 'UNIT',
        attributes: [
          attr('project', 'TEXT', { required: true }),
          attr('unit_kind', 'SELECT', { required: true, options: ['Office', 'Shop', 'Showroom', 'Warehouse'] }),
          attr('tower', 'TEXT', { scope: 'SERIAL' }),
          attr('floor', 'NUMBER', { scope: 'SERIAL', decimalPlaces: 0 }),
          attr('carpet_area_sqft', 'NUMBER', { scope: 'SERIAL', required: true, decimalPlaces: 2 }),
        ],
      },
      {
        code: 'PLT',
        name: 'Plots',
        itemType: 'PROPERTY_UNIT',
        defaultTracking: 'SERIAL',
        defaultUomCode: 'UNIT',
        attributes: [
          attr('project', 'TEXT', { required: true }),
          attr('plot_area_sqft', 'NUMBER', { scope: 'SERIAL', required: true, decimalPlaces: 2 }),
          attr('facing', 'SELECT', { scope: 'SERIAL', options: FACING_OPTIONS }),
          attr('corner', 'BOOLEAN', { scope: 'SERIAL' }),
        ],
      },
      {
        code: 'MAT',
        name: 'Construction materials',
        itemType: 'RAW_MATERIAL',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'BAG',
        attributes: [attr('grade', 'TEXT')],
      },
    ],
    codeSchemes: [
      scheme('Category + number', '{CAT}-{SEQ:4}', true),
      scheme('Project + category', '{ATTR:project:4}-{CAT}-{SEQ:3}', false),
    ],
  },
  {
    key: 'GENERAL',
    name: 'General business',
    description: 'A neutral starting point you shape yourself.',
    industryKeywords: [],
    defaultLocation: { code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE' },
    uoms: [],
    categories: [
      {
        code: 'GEN',
        name: 'General goods',
        itemType: 'TRADING_GOOD',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [attr('brand', 'TEXT')],
      },
      {
        code: 'CON',
        name: 'Consumables',
        itemType: 'CONSUMABLE',
        defaultTracking: 'QUANTITY',
        defaultUomCode: 'EA',
        attributes: [],
      },
    ],
    codeSchemes: [scheme('Category + number', '{CAT}-{SEQ:5}', true), scheme('Plain number', '{SEQ:6}', false)],
  },
] as const satisfies readonly StockIndustryProfile[];

export function getIndustryProfile(key: StockIndustryKey): StockIndustryProfile {
  const profile = (STOCK_INDUSTRY_PROFILES as readonly StockIndustryProfile[]).find((p) => p.key === key);
  if (profile === undefined) throw new Error(`Unknown industry profile "${key}"`);
  return profile;
}

/**
 * Lower-cases `industry`; the first profile (array order) with a keyword
 * that `industry` includes wins; else 'GENERAL'. `null` → 'GENERAL'
 * directly, without scanning (GENERAL carries no keywords of its own and is
 * last in array order regardless, so this is a fast path, not a different
 * rule).
 */
export function suggestIndustryProfile(industry: string | null): StockIndustryKey {
  if (industry === null) return 'GENERAL';
  const lower = industry.toLowerCase();
  for (const profile of STOCK_INDUSTRY_PROFILES as readonly StockIndustryProfile[]) {
    if (profile.industryKeywords.some((keyword) => lower.includes(keyword))) return profile.key;
  }
  return 'GENERAL';
}
