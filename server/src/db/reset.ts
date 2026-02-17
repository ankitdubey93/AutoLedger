import 'dotenv/config';
import pool from './connect';

const resetDatabase = async () => {
    const client = await pool.connect();

    try {
        console.log("_______________________________________");
        console.log("RESETTING DATABASE (DELETING DATA) 🧨");
        console.log("_______________________________________");

        await client.query('BEGIN');

        // DROP TABLES (Order doesn't strictly matter with CASCADE, but good to be explicit)
        // We drop the dependents first, then the parents.
        
        console.log("Dropping tables...");
        
        await client.query(`DROP TABLE IF EXISTS refresh_tokens CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS ledger_lines CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS journal_entries CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS accounts CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS users CASCADE;`);

        await client.query('COMMIT');
        
        console.log("Database cleared successfully.");

    } catch (error: any) {
        await client.query('ROLLBACK');
        console.error("RESET FAILED:", error.message);
    } finally {
        client.release();
        await pool.end(); // Close connection
    }
};

resetDatabase();