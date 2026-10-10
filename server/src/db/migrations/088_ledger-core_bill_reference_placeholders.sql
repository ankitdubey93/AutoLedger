-- 088_ledger-core_bill_reference_placeholders.sql
-- Phase 40 follow-up — two draft bills for one vendor may both carry the
-- reference `RENT-[Month]`.
--
-- 013's ux_bills_vendor_reference is a plain UNIQUE (org_id, vendor_id,
-- vendor_reference) constraint, so a draft whose reference still holds
-- placeholders occupied that exact text: a second `RENT-[Month]` draft (next
-- month's, typed ahead) was refused although neither will ever be posted
-- under that text — approval fills it (`RENT-October`) first.
--
-- It becomes a partial unique index of the SAME NAME, exempting only an
-- editable bill (DRAFT / AWAITING_APPROVAL) whose reference contains bracket
-- text shaped like a placeholder. Everything else is unique exactly as
-- before, and every bill is checked the moment approval fills its reference
-- and flips it to POSTED — the same UPDATE, so the index sees the posted row.
-- Keeping the name keeps every `pgConstraint(err) === 'ux_bills_vendor_reference'`
-- 409 mapping working: a unique-index violation reports the index name.
--
-- The pattern is deliberately looser than the engine's grammar (it also
-- exempts unknown bracket text, and `[[escapes]]`, in a draft): exempting a
-- little too much in drafts only defers a duplicate to approval, which
-- billService.fillVendorReferenceOnClient pre-checks and this index enforces.
--
-- A relaxation, not a data change: no row is touched. Signed off by the user
-- on 2026-10-10 ("fix the concerns"), per rule 13's destructive-change rule.
--
-- Idempotent: the constraint is dropped only while it still exists (a plain
-- unique index has no pg_constraint row), and the index is IF NOT EXISTS.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ux_bills_vendor_reference' AND conrelid = 'bills'::regclass
  ) THEN
    ALTER TABLE bills DROP CONSTRAINT ux_bills_vendor_reference;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_bills_vendor_reference
  ON bills (org_id, vendor_id, vendor_reference)
  WHERE NOT (
    status IN ('DRAFT', 'AWAITING_APPROVAL')
    AND vendor_reference ~ '\[\s*[A-Za-z][A-Za-z ]*\s*([+-]\s*[0-9]{1,3}\s*)?\]'
  );
