/**
 * A minimal class-name joiner: filters falsy values and joins with a space.
 * Rule 14 (no dependency before the phase that needs it) rules out adding
 * `clsx`/`classnames` for something this small.
 */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter((value): value is string => Boolean(value)).join(' ');
}
