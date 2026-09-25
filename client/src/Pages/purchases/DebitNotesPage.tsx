import NoteListPage from '../sales/notes/NoteListPage';
import { DEBIT_NOTE_KIND } from '../sales/notes/noteKinds';

/** The debit-note register (Phase 26) — see notes/NoteListPage.tsx. */
export default function DebitNotesPage() {
  return <NoteListPage config={DEBIT_NOTE_KIND} />;
}
