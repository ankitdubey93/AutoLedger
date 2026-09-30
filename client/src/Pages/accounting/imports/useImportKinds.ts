import { useEffect, useState } from 'react';
import { getMigrationImportKinds, type ImportKindMeta } from '../../../services/fetchServices';

export function useImportKinds(): { kinds: ImportKindMeta[] | null; error: string | null } {
  const [kinds, setKinds] = useState<ImportKindMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;

    getMigrationImportKinds(controller.signal)
      .then((res) => {
        if (!ignore) {
          setKinds(res.kinds);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (ignore || (err instanceof Error && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : 'Could not load import settings');
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, []);

  return { kinds, error };
}
