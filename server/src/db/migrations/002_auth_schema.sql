CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. USERS TABLE

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,

    -- Email Verification Logic
    email_verified BOOLEAN DEFAULT FALSE,
    email_verification_token TEXT,
    email_verification_token_expires TIMESTAMP,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);


-- 2. REFRESH TOKEN TABLE

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    token TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_token UNIQUE(token)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);