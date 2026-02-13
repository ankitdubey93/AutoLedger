-- 1. Chart of Accounts: Defines the "buckets" where money goes.

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- To keep data private per user
    name TEXT NOT NULL, -- e.g. "Cash in Bank"
    code TEXT NOT NULL, -- e.g. "1001"
    type TEXT NOT NULL, -- 'ASSET','LIABILITY','Equity','Revenue','Expense'
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id,code) -- Prevent duplicate account codes for the same user
);

-- 2. Journal Entries (The Header): The "Who,What,When".

CREATE TABLE journal_entries(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    date DATE NOT NULL,
    description TEXT,
    source_type TEXT DEFAULT 'manual', -- 'invoice','expense','manual'
    source_id UUID, -- Link to Invoice table later
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Ledger lines (The Atomic Data): The actual Debits and Credits

CREATE TABLE ledger_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id),
    user_id UUID NOT NULL,
    debit DECIMAL(15,2) DEFAULT 0 CHECK (debit >= 0),
    credit DECIMAL(15,2) DEFAULT 0 CHECK (credit >= 0),
    -- Ensures at least one side has a value
    CONSTRAINT chk_debit_credit CHECK (NOT(debit = 0 AND credit = 0))
);



-- 2. INITIAL SEEDS (Default Chart of Accounts)
-- Using a dummy UUID for system-wide default accounts
INSERT INTO accounts (user_id, name, code, type, description) VALUES 
('00000000-0000-0000-0000-000000000000', 'Cash in Bank', '1001', 'Asset', 'Primary checking account'),
('00000000-0000-0000-0000-000000000000', 'Accounts Receivable', '1200', 'Asset', 'Unpaid customer invoices'),
('00000000-0000-0000-0000-000000000000', 'Accounts Payable', '2100', 'Liability', 'Unpaid vendor bills'),
('00000000-0000-0000-0000-000000000000', 'Sales Revenue', '4000', 'Revenue', 'Service and product income'),
('00000000-0000-0000-0000-000000000000', 'Rent Expense', '5000', 'Expense', 'Monthly office rent')
ON CONFLICT (user_id, code) DO NOTHING;