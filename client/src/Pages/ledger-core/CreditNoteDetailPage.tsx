import NoteDetailPage from './notes/NoteDetailPage';
import { CREDIT_NOTE_KIND } from './notes/noteKinds';

/** One credit note (Phase 26) — see notes/NoteDetailPage.tsx. */
export default function CreditNoteDetailPage() {
  return <NoteDetailPage config={CREDIT_NOTE_KIND} />;
}
