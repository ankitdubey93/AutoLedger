import pool from "../db/connect";
import ApiError from "../utils/apiError";

export interface JournalLineInput {
    accountId: string;
    debit: number;
    credit: number;
}

export interface CreateJournalEntryData {
    date: string;
    description: string;
    lines: JournalLineInput[];
}

export const journalService = {
    /**
     * Creates a new journal entry and its associated ledger lines in a single transaction.
     */
    async createEntry(userId: string, data: CreateJournalEntryData) {
        const { date, description, lines } = data;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // 1. Insert Header
            const entryResult = await client.query(
                `INSERT INTO journal_entries (user_id, date, description, source_type)
                 VALUES ($1, $2, $3, 'manual')
                 RETURNING id, date, description, created_at`,
                [userId, date, description]
            );
            const journalEntryId = entryResult.rows[0].id;

            // 2. Insert Lines
            for (const line of lines) {
                await client.query(
                    `INSERT INTO ledger_lines (journal_entry_id, account_id, user_id, debit, credit)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [journalEntryId, line.accountId, userId, line.debit, line.credit]
                );
            }

            await client.query('COMMIT');
            return entryResult.rows[0];

        } catch (error: any) {
            await client.query('ROLLBACK');

            // Re-throw foreign key violations as 400s
            if (error.code === '23503') {
                throw new ApiError(400, "Invalid Account ID provided. Please refresh your accounts list.");
            }
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Fetches journal entries for a user with pagination, including nested lines.
     */
    async getEntriesForUser(userId: string, page: number = 1, limit: number = 20) {
        const offset = (page - 1) * limit;

        const query = `
            SELECT 
                je.id,
                je.date,
                je.description,
                je.source_type,
                je.created_at,
                COUNT(*) OVER() as total_count, -- Use window function for total matches
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', ll.id,
                            'accountId', ll.account_id,
                            'accountName', a.name,
                            'accountCode', a.code,
                            'debit', ll.debit,
                            'credit', ll.credit
                        ) ORDER BY ll.debit DESC
                    ), 
                    '[]'
                ) AS lines
            FROM journal_entries je
            LEFT JOIN ledger_lines ll ON je.id = ll.journal_entry_id
            LEFT JOIN accounts a ON ll.account_id = a.id
            WHERE je.user_id = $1
            GROUP BY je.id
            ORDER BY je.date DESC, je.created_at DESC
            LIMIT $2 OFFSET $3
        `;

        const result = await pool.query(query, [userId, limit, offset]);

        const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;

        return {
            entries: result.rows.map(row => {
                const { total_count, ...entry } = row;
                return entry;
            }),
            totalCount
        };
    }
};
