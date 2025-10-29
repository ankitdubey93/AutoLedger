-- 002_create_journal_entries_table.sql

-- Enable UUID generation (if not already enabled)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Journal Entries table
CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT NOT NULL,
    accounts JSONB NOT NULL, -- Array of accounts with debit/credit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on every update
DROP TRIGGER IF EXISTS journal_entries_set_updated_at ON journal_entries;
CREATE TRIGGER journal_entries_set_updated_at
BEFORE UPDATE ON journal_entries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Index for faster lookups by user
CREATE INDEX IF NOT EXISTS journal_entries_user_id_idx ON journal_entries (user_id);
