-- Phase 46c — Xero-style "History & notes": one human-readable timeline per
-- document, payment, contact and bank line. Written by each service on its
-- own transaction (never derived from audit_logs, which stays the raw CDC
-- trail). entity_id is polymorphic — no FK, like audit_logs.row_id — so the
-- service checks the entity exists in the org before writing a note.
-- created_at uses clock_timestamp(): now() is fixed per transaction, so two
-- events in one transaction (issue + auto-applied credit) would tie.
CREATE TABLE IF NOT EXISTS document_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN (
                  'INVOICE','BILL','CREDIT_NOTE','DEBIT_NOTE','QUOTE','PURCHASE_QUOTE',
                  'SALES_ORDER','PURCHASE_ORDER','PAYMENT','MANUAL_JOURNAL',
                  'CUSTOMER','VENDOR','BANK_TRANSACTION')),
  entity_id     UUID NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('EVENT','NOTE')),
  action        TEXT NOT NULL CHECK (action ~ '^[A-Z_]{1,40}$'),
  summary       TEXT NOT NULL CHECK (length(btrim(summary)) > 0 AND char_length(summary) <= 1000),
  details       JSONB NULL,
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_document_history_note_action CHECK ((kind = 'NOTE') = (action = 'NOTE'))
);
CREATE INDEX IF NOT EXISTS idx_document_history_entity
  ON document_history (org_id, entity_type, entity_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_document_history_actor ON document_history (actor_user_id);

CREATE OR REPLACE FUNCTION reject_document_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'document_history is append-only; % is not permitted', TG_OP
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_document_history_immutable
  BEFORE UPDATE OR DELETE ON document_history
  FOR EACH ROW EXECUTE FUNCTION reject_document_history_mutation();

-- Backfill: one CREATED event per existing row (idempotent — the replay test
-- re-runs this file).

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'INVOICE', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM invoices t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'INVOICE'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'BILL', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM bills t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'BILL'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'CREDIT_NOTE', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM credit_notes t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'CREDIT_NOTE'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'DEBIT_NOTE', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM debit_notes t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'DEBIT_NOTE'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'PAYMENT', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM payments t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'PAYMENT'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'MANUAL_JOURNAL', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM manual_journals t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'MANUAL_JOURNAL'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'CUSTOMER', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM customers t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'CUSTOMER'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, 'VENDOR', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM vendors t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id AND h.entity_type = 'VENDOR'
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, CASE t.direction WHEN 'SALES' THEN 'QUOTE' ELSE 'PURCHASE_QUOTE' END, t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM quotes t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id
                      AND h.entity_type = CASE t.direction WHEN 'SALES' THEN 'QUOTE' ELSE 'PURCHASE_QUOTE' END
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT t.org_id, CASE t.direction WHEN 'SALES' THEN 'SALES_ORDER' ELSE 'PURCHASE_ORDER' END, t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
  FROM orders t
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = t.org_id
                      AND h.entity_type = CASE t.direction WHEN 'SALES' THEN 'SALES_ORDER' ELSE 'PURCHASE_ORDER' END
                      AND h.entity_id = t.id AND h.action = 'CREATED');

INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
SELECT bt.org_id, 'BANK_TRANSACTION', bt.id, 'EVENT', 'IMPORTED', 'Imported from ' || i.file_name, i.created_by, bt.created_at
  FROM bank_transactions bt
  JOIN bank_statement_imports i ON i.id = bt.import_id AND i.org_id = bt.org_id
 WHERE NOT EXISTS (SELECT 1 FROM document_history h
                    WHERE h.org_id = bt.org_id AND h.entity_type = 'BANK_TRANSACTION'
                      AND h.entity_id = bt.id AND h.action = 'IMPORTED');
