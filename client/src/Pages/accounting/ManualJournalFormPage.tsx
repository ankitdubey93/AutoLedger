import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  createManualJournal,
  getManualJournal,
  listAccounts,
  postManualJournal,
  updateManualJournal,
  type Account,
  type ManualJournal,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import BackLink from '../../components/BackLink';
import PlaceholderPicker from '../../components/placeholders/PlaceholderPicker';
import PlaceholderHints from '../../components/placeholders/PlaceholderHints';
import ManualJournalLinesEditor, {
  editorTotals,
  emptyLine,
  toInputLines,
  type EditorLine,
} from '../../components/ManualJournalLinesEditor';
import { usePlaceholderTarget } from '../../utils/usePlaceholderTarget';
import { useOrganizationName } from '../../context/OrgContext';

/**
 * Create or edit a manual journal (Phase 44).
 *
 * Three submit paths with distinct endings: Save draft and Post hand off to the
 * detail page; Save & add another posts, then resets the form in place (date
 * kept) so a run of similar entries can be keyed without leaving. Edit mode
 * (`:journalId`) only exists for a DRAFT or a repeating TEMPLATE — a posted
 * journal is immutable (guardrails rule 6), so it is voided, never edited.
 * `?copyFrom=<id>` seeds a new journal from an existing one, using the narration
 * as written (`narrationTemplate`), a one-shot seed latched by `seeded`.
 */

function today(): string {
  // Local calendar date, not toISOString() (which converts to UTC).
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

function twoEmptyLines(): EditorLine[] {
  return [emptyLine(), emptyLine()];
}

function toEditorLines(journal: ManualJournal): EditorLine[] {
  return journal.lines.map((line) => ({
    description: line.description ?? '',
    accountId: line.accountId ?? '',
    debit: line.debitCents > 0 ? formatCents(line.debitCents) : '',
    credit: line.creditCents > 0 ? formatCents(line.creditCents) : '',
  }));
}

type SubmitKind = 'draft' | 'post' | 'another';

export default function ManualJournalFormPage() {
  const navigate = useNavigate();
  const { journalId } = useParams();
  const [params] = useSearchParams();
  const copyFrom = params.get('copyFrom');
  const editing = journalId !== undefined;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entryDate, setEntryDate] = useState(today);
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<EditorLine[]>(twoEmptyLines);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [loaded, setLoaded] = useState<ManualJournal | null>(null);
  const [posted, setPosted] = useState<{ id: string; narration: string } | null>(null);

  const organisationName = useOrganizationName();
  const placeholderTarget = usePlaceholderTarget('narration');

  useEffect(() => {
    let ignore = false;
    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load accounts');
      });
    return () => {
      ignore = true;
    };
  }, []);

  const sourceId = editing ? journalId : copyFrom;

  useEffect(() => {
    if (sourceId === null || seeded) return;
    let ignore = false;

    getManualJournal(sourceId)
      .then((res) => {
        if (ignore) return;
        const source = res.journal;
        setEntryDate(source.entryDate);
        setNarration(source.narrationTemplate ?? source.narration);
        setLines(toEditorLines(source));
        if (editing) setLoaded(source);
        setSeeded(true);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : 'Could not load the journal');
        setSeeded(true);
      });

    return () => {
      ignore = true;
    };
  }, [sourceId, seeded, editing]);

  const totals = editorTotals(lines);
  const inputLines = toInputLines(lines);
  const linesComplete =
    inputLines.length > 0 &&
    inputLines.every((l) => l.accountId !== null && (l.debitCents > 0) !== (l.creditCents > 0));
  const canSave = narration.trim() !== '' && entryDate !== '' && !totals.malformed && !busy;
  const canPost = canSave && linesComplete && totals.balanced && totals.debits > 0;

  async function submit(kind: SubmitKind) {
    setBusy(true);
    setError(null);
    setPosted(null);

    const body = { narration: narration.trim(), entryDate, lines: inputLines };

    try {
      if (editing) {
        const { journal } = await updateManualJournal(journalId, body);
        if (kind === 'post') await postManualJournal(journal.id);
        void navigate(`/manual-journals/${journal.id}`);
        return;
      }

      const { journal } = await createManualJournal({
        ...body,
        action: kind === 'draft' ? 'draft' : 'post',
      });

      if (kind === 'another') {
        setPosted({ id: journal.id, narration: body.narration });
        setNarration('');
        setLines(twoEmptyLines());
        setBusy(false);
        return;
      }
      void navigate(`/manual-journals/${journal.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the journal');
      setBusy(false);
    }
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';
  const primaryClass =
    'px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const secondaryClass =
    'px-4 py-2 rounded-md text-sm font-medium border border-[var(--border)] cursor-pointer bg-transparent text-[var(--text)] hover:bg-[var(--panel)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  if (editing && loaded !== null && loaded.status !== 'DRAFT' && loaded.status !== 'TEMPLATE') {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to="/manual-journals" label="Back to manual journals" />
        <p className="status status--bad">
          This journal is {loaded.status} and can&apos;t be edited.
        </p>
      </section>
    );
  }

  const isTemplate = loaded?.status === 'TEMPLATE';

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/manual-journals" label="Back to manual journals" />

      <form
        onSubmit={(event) => {
          event.preventDefault();
        }}
        className="flex flex-col gap-4"
      >
        <header>
          <h2 className="text-lg font-semibold m-0">
            {editing
              ? isTemplate
                ? 'Edit repeating journal template'
                : 'Edit draft journal'
              : copyFrom === null
                ? 'New manual journal'
                : 'New manual journal (copy)'}
          </h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Save a draft to keep working, or post it to the ledger. A posted journal can&apos;t be
            edited — void it to reverse it.
          </p>
        </header>

        {posted !== null && (
          <p className="status status--good">
            Posted “{posted.narration}”.{' '}
            <Link to={`/manual-journals/${posted.id}`}>View it</Link>
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Date</span>
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              required
              className={inputClass}
            />
          </label>
          <div className="flex flex-col gap-1 text-sm flex-1 min-w-56">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="journal-narration" className="text-[var(--muted)]">
                Narration
              </label>
              <PlaceholderPicker surface="JOURNAL" onInsert={placeholderTarget.insert} />
            </div>
            <input
              id="journal-narration"
              type="text"
              {...placeholderTarget.bind('narration', setNarration)}
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              placeholder="Accrued rent [Month]"
              maxLength={500}
              required
              className={inputClass}
            />
            <PlaceholderHints
              text={narration}
              surface="JOURNAL"
              {...(entryDate === '' ? {} : { preview: { date: entryDate, organisationName } })}
            />
          </div>
        </div>

        <ManualJournalLinesEditor lines={lines} onChange={setLines} accounts={accounts} />

        <div className="flex items-center gap-3 flex-wrap">
          {isTemplate ? (
            <button
              type="button"
              disabled={!canPost}
              onClick={() => void submit('draft')}
              className={primaryClass}
            >
              {busy ? 'Saving…' : 'Save template'}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={!canSave}
                onClick={() => void submit('draft')}
                className={secondaryClass}
              >
                Save draft
              </button>
              {!editing && (
                <button
                  type="button"
                  disabled={!canPost}
                  onClick={() => void submit('another')}
                  className={secondaryClass}
                >
                  Save &amp; add another
                </button>
              )}
              <button
                type="button"
                disabled={!canPost}
                onClick={() => void submit('post')}
                className={primaryClass}
              >
                {busy ? 'Posting…' : 'Post'}
              </button>
            </>
          )}
        </div>

        {error !== null && <p className="status status--bad">{error}</p>}
      </form>
    </section>
  );
}
