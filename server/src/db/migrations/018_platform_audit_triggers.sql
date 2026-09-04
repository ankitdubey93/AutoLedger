-- 018_platform_audit_triggers.sql
-- Phase 5 — attaches audit_row_change() (017) to every audited table.
--
-- AFTER, not BEFORE: the trail records what actually happened, so it must
-- fire after every BEFORE trigger and every CHECK constraint on the table
-- has already had its chance to reject the row.
--
-- 16 tables are audited. Deliberately NOT audited, and why:
--   * users, refresh_tokens — password is a bcrypt digest and token_hash is
--     a session credential; copying either into a JSONB column would spread
--     a secret into a table nobody is permitted to delete rows from.
--   * schema_migrations — the migration runner's own bookkeeping, not a
--     financial or tenant-scoped record.
--   * audit_logs — would be self-referential.
--
-- TRUNCATE does not fire row-level triggers, so resetTables() in the test
-- fixtures is unaffected by any of this.
--
-- Every slug argument below matches a slug in server/src/config/apps.ts
-- (guardrails rule 16); 'platform' names the app-less identity/tenancy
-- layer, the same layer authService and organizationService belong to.

CREATE OR REPLACE TRIGGER trg_organizations_audit
  AFTER INSERT OR UPDATE OR DELETE ON organizations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

CREATE OR REPLACE TRIGGER trg_organization_members_audit
  AFTER INSERT OR UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

CREATE OR REPLACE TRIGGER trg_accounts_audit
  AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_journal_entries_audit
  AFTER INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_ledger_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_ledger_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON ledger_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_ledger_invoice_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON ledger_invoice_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_customers_audit
  AFTER INSERT OR UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_vendors_audit
  AFTER INSERT OR UPDATE OR DELETE ON vendors
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_invoices_audit
  AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_invoice_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_bills_audit
  AFTER INSERT OR UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_bill_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_payments_audit
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_payment_allocations_audit
  AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE OR REPLACE TRIGGER trg_fiscal_periods_audit
  AFTER INSERT OR UPDATE OR DELETE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
