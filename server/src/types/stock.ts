/**
 * StockLedger types — Phase 28.
 *
 * App-prefixed (`Stock*`), mirroring `types/ledger-core.ts` and
 * `types/unitecon.ts`. The `as const` array + type guard idiom copies
 * `types/onboarding.ts`: `as const` keeps each member a string literal so the
 * derived union type is real, not widened to `string`.
 */

export const STOCK_INDUSTRY_KEYS = [
  'GENERAL', 'RETAIL', 'WHOLESALE_DISTRIBUTION', 'MANUFACTURING', 'FOOD_BEVERAGE',
  'PHARMA_HEALTHCARE', 'APPAREL_FOOTWEAR', 'ELECTRONICS', 'AUTOMOTIVE', 'REAL_ESTATE',
] as const;
export type StockIndustryKey = (typeof STOCK_INDUSTRY_KEYS)[number];

export function isStockIndustryKey(value: string): value is StockIndustryKey {
  return (STOCK_INDUSTRY_KEYS as readonly string[]).includes(value);
}

// Ind AS 2 / IAS 2 inventory classes, plus PROPERTY_UNIT for a developer's unsold units.
export const STOCK_ITEM_TYPES = [
  'RAW_MATERIAL', 'COMPONENT', 'WORK_IN_PROGRESS', 'FINISHED_GOOD', 'TRADING_GOOD',
  'CONSUMABLE', 'PACKAGING', 'SPARE_PART', 'PROPERTY_UNIT',
] as const;
export type StockItemType = (typeof STOCK_ITEM_TYPES)[number];

export function isStockItemType(value: string): value is StockItemType {
  return (STOCK_ITEM_TYPES as readonly string[]).includes(value);
}

export const STOCK_TRACKING_MODES = ['QUANTITY', 'LOT', 'SERIAL'] as const;
export type StockTrackingMode = (typeof STOCK_TRACKING_MODES)[number];

export function isStockTrackingMode(value: string): value is StockTrackingMode {
  return (STOCK_TRACKING_MODES as readonly string[]).includes(value);
}

export const STOCK_ATTRIBUTE_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT'] as const;
export type StockAttributeType = (typeof STOCK_ATTRIBUTE_TYPES)[number];

export function isStockAttributeType(value: string): value is StockAttributeType {
  return (STOCK_ATTRIBUTE_TYPES as readonly string[]).includes(value);
}

export const STOCK_ATTRIBUTE_SCOPES = ['ITEM', 'SERIAL'] as const;
export type StockAttributeScope = (typeof STOCK_ATTRIBUTE_SCOPES)[number];

export function isStockAttributeScope(value: string): value is StockAttributeScope {
  return (STOCK_ATTRIBUTE_SCOPES as readonly string[]).includes(value);
}

export const STOCK_LOCATION_KINDS = ['WAREHOUSE', 'STORE', 'SITE', 'ZONE', 'BIN'] as const;
export type StockLocationKind = (typeof STOCK_LOCATION_KINDS)[number];
export const STOCK_TOP_LEVEL_LOCATION_KINDS = ['WAREHOUSE', 'STORE', 'SITE'] as const;

export function isStockLocationKind(value: string): value is StockLocationKind {
  return (STOCK_LOCATION_KINDS as readonly string[]).includes(value);
}

export const STOCK_MOVEMENT_TYPES = [
  'RECEIPT', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export const STOCK_INBOUND_MOVEMENT_TYPES = ['RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN'] as const;

export function isStockMovementType(value: string): value is StockMovementType {
  return (STOCK_MOVEMENT_TYPES as readonly string[]).includes(value);
}

export const STOCK_SERIAL_STATUSES = ['AVAILABLE', 'ON_HOLD', 'BOOKED', 'ISSUED'] as const;
export type StockSerialStatus = (typeof STOCK_SERIAL_STATUSES)[number];

export function isStockSerialStatus(value: string): value is StockSerialStatus {
  return (STOCK_SERIAL_STATUSES as readonly string[]).includes(value);
}

/**
 * The one FSM transition table for serials (rule 10). MANUAL = POST /serials/:id/status;
 * MOVEMENT = only a stock movement may cause it (issue → ISSUED, re-receipt → AVAILABLE).
 */
export const STOCK_SERIAL_TRANSITIONS: Readonly<
  Record<StockSerialStatus, readonly { to: StockSerialStatus; via: 'MANUAL' | 'MOVEMENT' }[]>
> = {
  AVAILABLE: [
    { to: 'ON_HOLD', via: 'MANUAL' },
    { to: 'BOOKED', via: 'MANUAL' },
    { to: 'ISSUED', via: 'MOVEMENT' },
  ],
  ON_HOLD: [
    { to: 'AVAILABLE', via: 'MANUAL' },
    { to: 'BOOKED', via: 'MANUAL' },
  ],
  BOOKED: [
    { to: 'AVAILABLE', via: 'MANUAL' },
    { to: 'ISSUED', via: 'MOVEMENT' },
  ],
  ISSUED: [{ to: 'AVAILABLE', via: 'MOVEMENT' }],
};

export function canTransitionSerial(
  from: StockSerialStatus,
  to: StockSerialStatus,
  via: 'MANUAL' | 'MOVEMENT',
): boolean {
  return STOCK_SERIAL_TRANSITIONS[from].some((t) => t.to === to && t.via === via);
}

export const STOCK_LABEL_KINDS = ['ITEM', 'LOT', 'SERIAL', 'LOCATION'] as const;
export type StockLabelKind = (typeof STOCK_LABEL_KINDS)[number];

/** NUMBER values are canonical decimal strings ("1250.50"), never JS floats. */
export type StockAttributeValue = string | boolean;
export type StockAttributes = Record<string, StockAttributeValue>;

export interface StockSettings {
  configured: boolean;
  industryProfile: StockIndustryKey | null;
  suggestedProfile: StockIndustryKey;
  updatedAt: string | null;
}
export interface StockUom {
  id: string;
  code: string;
  name: string;
  decimalPlaces: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockCategory {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  path: string;
  depth: number;
  itemType: StockItemType;
  defaultTracking: StockTrackingMode;
  defaultUomId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockAttributeDefinition {
  id: string;
  categoryId: string;
  appliesTo: StockAttributeScope;
  key: string;
  label: string;
  dataType: StockAttributeType;
  options: string[] | null;
  decimalPlaces: number | null;
  isRequired: boolean;
  sortOrder: number;
  isActive: boolean;
}
export interface StockCodeScheme {
  id: string;
  name: string;
  pattern: string;
  isDefault: boolean;
  isActive: boolean;
  example: string;
  createdAt: string;
  updatedAt: string;
}
export interface StockLocation {
  id: string;
  code: string;
  name: string;
  kind: StockLocationKind;
  parentId: string | null;
  path: string;
  depth: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  categoryId: string;
  categoryName: string;
  itemType: StockItemType;
  tracking: StockTrackingMode;
  uomId: string;
  uomCode: string;
  uomDecimalPlaces: number;
  codeSchemeId: string | null;
  barcode: string | null;
  attributes: StockAttributes;
  reorderPointMilli: number | null;
  onHandQuantityMilli: number;
  onHandValueCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface StockLot {
  id: string;
  itemId: string;
  lotNumber: string;
  manufacturedOn: string | null;
  expiresOn: string | null;
  onHandQuantityMilli: number;
  createdAt: string;
}
export interface StockSerial {
  id: string;
  itemId: string;
  serialNumber: string;
  status: StockSerialStatus;
  locationId: string | null;
  locationCode: string | null;
  costCents: number;
  statusNote: string | null;
  attributes: StockAttributes;
  createdAt: string;
  updatedAt: string;
}
export interface StockMovement {
  id: string;
  movementGroupId: string;
  movementType: StockMovementType;
  itemId: string;
  itemCode: string;
  locationId: string;
  locationCode: string;
  lotId: string | null;
  lotNumber: string | null;
  serialId: string | null;
  serialNumber: string | null;
  quantityMilli: number;
  valueCents: number;
  runningLocationQuantityMilli: number;
  reference: string | null;
  reason: string | null;
  occurredOn: string;
  createdAt: string;
}
export interface StockBalance {
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string;
  locationId: string;
  locationCode: string;
  locationPath: string;
  lotId: string | null;
  lotNumber: string | null;
  expiresOn: string | null;
  quantityMilli: number;
  valueCents: number;
  averageUnitCostCents: number | null;
}
export interface StockSummary {
  activeItemCount: number;
  totalValueCents: number;
  lowStockItemCount: number;
  expiringLotCount: number;
  locationCount: number;
}
export interface StockLabel {
  kind: StockLabelKind;
  id: string;
  code: string;
  title: string;
  subtitle: string;
  payload: string;
  qrSvg: string;
  copies: number;
}
export interface StockLookupMatch {
  kind: StockLabelKind;
  id: string;
  itemId: string | null;
  code: string;
  title: string;
}
