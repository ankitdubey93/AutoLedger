import { useEffect, useState } from 'react';
import { downloadDocument } from '../services/fetchServices';

/**
 * A Document Vault file as a same-origin `blob:` URL, safe to use as an
 * `<img src>`.
 *
 * Why not a plain `/api/v1/documents/:id/file` path: the API lives at
 * `VITE_API_BASE_URL`, a different origin from the page, and the access cookie
 * is short-lived with no refresh path for a bare `<img>` request.
 * `downloadDocument` goes through the auto-refreshing fetch, so the bytes are
 * fetched with a valid session and handed to the DOM as an object URL.
 *
 * Returns `null` while `documentId` is `null`, while loading, and when the
 * download fails — a missing logo must never break a page or a print.
 *
 * The URL is revoked in the effect cleanup, which runs on unmount and again
 * before the effect re-runs for a new id. A response that lands after cleanup is
 * dropped (`cancelled`), and if a blob was already turned into a URL by then it
 * is revoked rather than leaked.
 */
export function useDocumentObjectUrl(documentId: string | null): string | null {
  // The URL is keyed by the id it was made for, so a stale URL from a previous id
  // can never be returned for a new one while the new download is in flight.
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    if (documentId === null) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    downloadDocument(documentId)
      .then(({ blob }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ id: documentId, url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setLoaded(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId]);

  return documentId !== null && loaded !== null && loaded.id === documentId ? loaded.url : null;
}
