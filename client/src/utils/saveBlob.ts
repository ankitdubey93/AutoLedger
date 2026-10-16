/**
 * Saves a Blob as a file: an object URL on a detached anchor, revoked in a
 * `finally` as soon as the click has fired so the URL never outlives the save.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
