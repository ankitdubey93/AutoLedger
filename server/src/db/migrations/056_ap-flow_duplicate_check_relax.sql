-- 056_ap-flow_duplicate_check_relax.sql
-- Drops chk_ap_flow_documents_duplicate_payload entirely. Caught by 055's
-- own new test, not by inspection: the check collided with a legitimate
-- FK action rather than with real application behaviour.
--
-- fk_ap_flow_documents_duplicate_of's ON DELETE SET NULL (duplicate_of_id)
-- fires if the row a DUPLICATE points at is ever deleted — nulling
-- duplicate_of_id while leaving status untouched. Postgres re-checks every
-- CHECK constraint against the row a cascade action produces, so a
-- still-DUPLICATE row with a freshly-nulled duplicate_of_id violated the
-- very constraint meant to guard the pairing, on an action nothing but the
-- FK itself performed.
--
-- There is in fact no DELETE route or query anywhere on ap_flow_documents
-- today (rule 6's posted-immutability philosophy extends to every status
-- here, in practice, not just POSTED) — this FK action is defensive
-- plumbing for a case the application never triggers. The real invariant,
-- "a DUPLICATE row is never CREATED without a target," is fully guaranteed
-- by the only code path that ever sets this status: apFlowDocumentService's
-- captureFile always supplies duplicateOfId when it does. A belt-and-braces
-- CHECK for that would need to exempt an UPDATE caused by the FK's own
-- cascade, which Postgres has no clean way to express — so the belt is
-- dropped here rather than kept fighting the brace.

ALTER TABLE ap_flow_documents
  DROP CONSTRAINT IF EXISTS chk_ap_flow_documents_duplicate_payload;
