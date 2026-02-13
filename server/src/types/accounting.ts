export type AccountType = 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';

export interface Account {
    id: string;
    userId: string;
    name: string;
    code: string;
    type: AccountType;
}

export interface LedgerLine {
    accountId: string;
    debit: number;
    credit: number;
}

export interface JournalEntry {
    id: string;
    date: string;
    description: string;
    lines: LedgerLine[];
}