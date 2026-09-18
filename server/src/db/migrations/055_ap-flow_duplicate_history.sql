-- 055_ap-flow_duplicate_history.sql
-- Fixes an over-strict CHECK from 054, caught by that phase's own tests
-- rather than by inspection — never edit an applied migration (rule 13).
--
-- 054's chk_ap_flow_documents_duplicate_payload was a biconditional:
-- (status = 'DUPLICATE') = (duplicate_of_id IS NOT NULL). That makes it
-- impossible for a document to leave DUPLICATE for PENDING (pushed through
-- via requestReextraction, the "not a duplicate — process it" action)
-- while KEEPING duplicate_of_id as a breadcrumb of what it was originally
-- flagged against — the constraint forced clearing it in the same
-- statement, discarding history nothing asked to discard.
--
-- The intended rule was only ever one-directional: a DUPLICATE row MUST
-- carry duplicate_of_id, but a row that carries duplicate_of_id need not
-- still be DUPLICATE — it may have since been confirmed legitimate and
-- moved on. That is what this migration replaces the CHECK with.

ALTER TABLE ap_flow_documents
  DROP CONSTRAINT IF EXISTS chk_ap_flow_documents_duplicate_payload;
ALTER TABLE ap_flow_documents
  ADD CONSTRAINT chk_ap_flow_documents_duplicate_payload
  CHECK (status <> 'DUPLICATE' OR duplicate_of_id IS NOT NULL);
