import pool from "../db/connect";
import ApiError from "../utils/apiError";

export interface CreateAccountData {
    name: string;
    code: string;
    type: string;
    description?: string;
}

export const accountService = {
    /**
     * Fetches the chart of accounts for a specific user.
     */
    async getAccountsForUser(userId: string) {
        const result = await pool.query(
            `SELECT id, name, code, type, description 
             FROM accounts 
             WHERE user_id = $1 
             ORDER BY code ASC`,
            [userId]
        );
        return result.rows;
    },

    /**
     * Creates a new account, handling unique constraint violations (e.g. duplicate code).
     */
    async createAccount(userId: string, data: CreateAccountData) {
        const { name, code, type, description } = data;

        try {
            const result = await pool.query(
                `INSERT INTO accounts (user_id, name, code, type, description)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [userId, name, code, type, description]
            );
            return result.rows[0];
        } catch (error: any) {
            if (error.code === '23505') {
                throw new ApiError(409, `Account code '${code}' already exists.`);
            }
            throw error;
        }
    }
};
