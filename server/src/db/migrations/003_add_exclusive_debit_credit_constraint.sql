-- Migration 003: Enforce mutual exclusion of debit and credit at the DB layer.
-- A ledger line must affect exactly one side of the accounting equation.
-- This is a pure additive constraint — no existing data is modified.
ALTER TABLE ledger_lines
    ADD CONSTRAINT chk_exclusive_debit_credit
    CHECK (NOT (debit > 0 AND credit > 0));
