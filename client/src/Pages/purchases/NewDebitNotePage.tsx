import NoteFormPage from '../sales/notes/NoteFormPage';
import { DEBIT_NOTE_KIND } from '../sales/notes/noteKinds';

/** Draft or edit a debit note (Phase 26) — see notes/NoteFormPage.tsx. */
export default function NewDebitNotePage() {
  return <NoteFormPage config={DEBIT_NOTE_KIND} />;
}
