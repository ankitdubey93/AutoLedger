import NoteDetailPage from '../sales/notes/NoteDetailPage';
import { DEBIT_NOTE_KIND } from '../sales/notes/noteKinds';

/** One debit note (Phase 26) — see notes/NoteDetailPage.tsx. */
export default function DebitNoteDetailPage() {
  return <NoteDetailPage config={DEBIT_NOTE_KIND} />;
}
