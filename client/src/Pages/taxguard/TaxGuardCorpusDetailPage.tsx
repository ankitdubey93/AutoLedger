import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getCorpusChunks,
  getCorpusDocument,
  type TaxGuardChunk,
  type TaxGuardCorpusDocument,
} from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';

/** One corpus document's chunks, in ordinal order, each showing its citation and heading. */
export default function TaxGuardCorpusDetailPage() {
  const { id } = useParams<{ id: string }>();
  const base = useAppBasePath();
  const [doc, setDoc] = useState<TaxGuardCorpusDocument | null>(null);
  const [chunks, setChunks] = useState<TaxGuardChunk[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === undefined) return;
    let ignore = false;
    setError(null);
    Promise.all([getCorpusDocument(id), getCorpusChunks(id)])
      .then(([docRes, chunksRes]) => {
        if (ignore) return;
        setDoc(docRes.corpusDocument);
        setChunks(chunksRes.chunks);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load this corpus document');
      });
    return () => {
      ignore = true;
    };
  }, [id]);

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/corpus`} label="Back to corpus" />

      {error !== null && <p className="status status--bad">{error}</p>}

      {doc !== null && (
        <>
          <header>
            <h2 className="text-lg font-semibold m-0">{doc.title}</h2>
            <p className="text-sm text-[var(--muted)] m-0 mt-1">
              {doc.jurisdiction}
              {doc.actYear !== null && ` — ${String(doc.actYear)}`} · {doc.chunkCount} chunks · {doc.status}
            </p>
          </header>

          {doc.status === 'FAILED' && doc.errorMessage !== null && (
            <p className="status status--bad">{doc.errorMessage}</p>
          )}

          <div className="flex flex-col gap-3">
            {chunks.map((chunk) => (
              <div key={chunk.id} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
                <p className="text-sm font-medium m-0">{chunk.citation}</p>
                {chunk.heading !== null && <p className="text-sm text-[var(--muted)] m-0 mt-0.5">{chunk.heading}</p>}
                <p className="text-sm m-0 mt-2 whitespace-pre-wrap">{chunk.content}</p>
              </div>
            ))}
            {chunks.length === 0 && doc.status === 'READY' && (
              <p className="text-sm text-[var(--muted)]">No chunks were extracted from this document.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
