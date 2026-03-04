--001_create_users_table.sql

--Enable UUID generation

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

--Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    email_verification_token TEXT,
    email_verification_token_expires TIMESTAMPTZ,
    password_reset_token TEXT,
    password_reset_token_expires TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uk ON users (LOWER(email));

-- Auto-update updated_at on every update
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Indexes for verification and password reset tokens
CREATE INDEX IF NOT EXISTS users_email_verif_token_idx ON users (email_verification_token);
CREATE INDEX IF NOT EXISTS users_pwd_reset_token_idx ON users (password_reset_token);