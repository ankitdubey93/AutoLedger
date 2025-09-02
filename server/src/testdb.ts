import dotenv from "dotenv";
dotenv.config();
import pool from "./db/connect";


const testConnection = async () => {
    try {
        const res = await pool.query("SELECT NOW()");
        console.log("Postgres connection working! Server time:", res.rows[0]);
        process.exit(0);

    }
     catch (error) {
        console.error("Failed to connect to Postgres:", error);
        process.exit(1);
     }
}


testConnection();