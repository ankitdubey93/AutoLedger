import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import pool from './connect';

const migrate = async () => {
    const client = await pool.connect();

    try {
        console.log("_______________________________________");
        console.log("Starting Database Migration");
        console.log("_______________________________________");

        // 1. Get the path to the migrations folder
        const migrationsDir = path.join(__dirname, 'migrations');

        // 2. Read all files in the directory
        if (!fs.existsSync(migrationsDir)) {
            throw new Error(`Migrations directory not found at: ${migrationsDir}`);
        }

        // Filter for .sql files and sort them (001, then 002, etc.)
        const files = fs.readdirSync(migrationsDir)
            .filter(file => file.endsWith('.sql'))
            .sort();

        if (files.length === 0) {
            console.log("No migration files found.");
            return;
        }

        console.log(`Found ${files.length} migration files.`);

        // 3. Start a SINGLE transaction for all files
        // This ensures if file #2 fails, file #1 is also rolled back (optional, but safer)
        await client.query('BEGIN');

        // 4. Loop through each file and execute it
        for (const file of files) {
            const filePath = path.join(migrationsDir, file);
            console.log(`⏳ Executing: ${file}...`);
            
            const sql = fs.readFileSync(filePath, 'utf-8');
            await client.query(sql);
        }

        await client.query('COMMIT');

        console.log("_______________________________________");
        console.log(" All migrations executed successfully!");
        console.log("_______________________________________");

    } catch (error: any) {
        await client.query('ROLLBACK');
        console.error(" MIGRATION FAILED");
        console.error("Reason:", error.message);

        if (error.code === '28P01') console.error(" Check your DB password in .env");
        if (error.code === '3D000') console.error(" Database does not exist. Create it first in Postgres.");

    } finally {
        client.release();
        await pool.end();
        process.exit();
    }
};

migrate();