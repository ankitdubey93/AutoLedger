import NoteFormPage from './notes/NoteFormPage';
import { CREDIT_NOTE_KIND } from './notes/noteKinds';

/** Draft or edit a credit note (Phase 26) — see notes/NoteFormPage.tsx. */
export default function NewCreditNotePage() {
  return <NoteFormPage config={CREDIT_NOTE_KIND} />;
}
