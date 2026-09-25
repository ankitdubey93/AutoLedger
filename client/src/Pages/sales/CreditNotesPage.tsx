import NoteListPage from './notes/NoteListPage';
import { CREDIT_NOTE_KIND } from './notes/noteKinds';

/** The credit-note register (Phase 26) — see notes/NoteListPage.tsx. */
export default function CreditNotesPage() {
  return <NoteListPage config={CREDIT_NOTE_KIND} />;
}
