import { useState } from 'react';
import { ApiRequestError, askQuestion, type TaxGuardJurisdiction, type TaxGuardQuestion } from '../../services/fetchServices';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

const JURISDICTIONS: TaxGuardJurisdiction[] = ['IN', 'US', 'UK', 'CA', 'AU', 'OTHER'];

/**
 * Ask a tax question and get a cited answer. A 422 (no matching corpus)
 * renders a clean empty state, never a raw error — the posture
 * UniteconPvmPage established and BoardDeckBvaPage followed. A 503 (no
 * answer provider configured) renders its own explanatory state.
 */
export default function TaxGuardAskPage() {
  const [questionText, setQuestionText] = useState('');
  const [jurisdiction, setJurisdiction] = useState<TaxGuardJurisdiction>('IN');
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState<TaxGuardQuestion | null>(null);
  const [needsCorpus, setNeedsCorpus] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk() {
    if (questionText.trim().length < 3) return;
    setAsking(true);
    setError(null);
    setNeedsCorpus(false);
    setNotConfigured(false);
    try {
      const res = await askQuestion({ questionText: questionText.trim(), jurisdiction });
      setQuestion(res.question);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 422) {
        setNeedsCorpus(true);
        setQuestion(null);
      } else if (err instanceof ApiRequestError && err.status === 503) {
        setNotConfigured(true);
        setQuestion(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not get an answer');
      }
    } finally {
      setAsking(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Ask TaxGuard</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Answers are grounded in the corpus's own text and cited to a section.
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div className="flex flex-col gap-2 max-w-2xl">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Jurisdiction</span>
          <select
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value as TaxGuardJurisdiction)}
            className={`${inputClass} w-40`}
          >
            {JURISDICTIONS.map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Question</span>
          <textarea
            value={questionText}
            onChange={(e) => setQuestionText(e.target.value)}
            rows={4}
            className={inputClass}
          />
        </label>
        <button
          type="button"
          className="btn w-fit"
          disabled={asking || questionText.trim().length < 3}
          onClick={handleAsk}
        >
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {needsCorpus && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">
            No source material yet — add a tax act to the corpus first.
          </p>
        </div>
      )}

      {notConfigured && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">Answering is not configured on this server.</p>
        </div>
      )}

      {question !== null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-4">
          <p className="text-sm m-0 whitespace-pre-wrap">{question.answerText}</p>
          {question.citations.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-[var(--border)] pt-3">
              <p className="text-xs text-[var(--muted)] m-0 uppercase tracking-wide">Sources</p>
              <ol className="text-sm m-0 pl-5 flex flex-col gap-1">
                {question.citations.map((citation, i) => (
                  <li key={citation.chunkId}>
                    [{i + 1}] {citation.citation} — {citation.corpusDocumentTitle}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
