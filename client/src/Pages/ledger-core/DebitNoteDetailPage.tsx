import NoteDetailPage from './notes/NoteDetailPage';
import { DEBIT_NOTE_KIND } from './notes/noteKinds';

/** One debit note (Phase 26) — see notes/NoteDetailPage.tsx. */
export default function DebitNoteDetailPage() {
  return <NoteDetailPage config={DEBIT_NOTE_KIND} />;
}
