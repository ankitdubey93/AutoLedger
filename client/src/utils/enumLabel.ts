/**
 * Server enums are SCREAMING_SNAKE identifiers (`RAW_MATERIAL`, `ON_HOLD`,
 * `RECLASS_OUT`); people read sentence case ("Raw material"). A few values
 * read better as a phrase than as the word itself and get an explicit label.
 */
const SPECIAL: Record<string, string> = {
  QUANTITY: 'Quantity only',
  LOT: 'Lot tracked',
  SERIAL: 'Serialized',
  RECLASS_OUT: 'Reclass out',
  RECLASS_IN: 'Reclass in',
};

export function humanizeEnum(value: string): string {
  const special = SPECIAL[value];
  if (special !== undefined) return special;
  const words = value.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
