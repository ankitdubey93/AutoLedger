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


        // 1. Resolving path to the SQL File
        // Note: __dirname points to src/db. We look for /migrations/.......

        const sqlFilePath = path.join(__dirname,'migrations','001_initial_schema.sql');


        //2. Read the SQL File
        if(!fs.existsSync(sqlFilePath)) {
            throw new Error(`Migration file not found at: ${sqlFilePath}`);
        }

        const sql = fs.readFileSync(sqlFilePath,'utf-8');

        //3. Execute everything inside a single transaction
        await client.query('BEGIN');

        console.log('Running schema and seed queries......');
        await client.query(sql);

        await client.query('COMMIT');

        console.log("Database migration and seeding successful!.");


 
    } catch (error:any) {
        await client.query('ROLLBACK');
        console.error("MIGRATION FAILED>");
        console.error("Reason:", error.message);


        if (error.code === '28P01') console.error("💡 Check your DB password in .env");
        if (error.code === '3D000') console.error("💡 Database does not exist. Create it first in Postgres.");

    } finally {
        client.release();
        await pool.end();
        process.exit();
    }
};


migrate();