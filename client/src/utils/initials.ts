/** Two-letter initials for an avatar chip — falls back to the email when there is no name. */
export function initials(name: string | null, email: string): string {
  const source = name !== null && name.trim() !== '' ? name : email;
  const parts = source.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}
