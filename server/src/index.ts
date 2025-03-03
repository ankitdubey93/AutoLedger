import express, {Request, Response} from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import connectDB from './db/connect';
import userRoutes from './routes/users'
dotenv.config();

const app = express();
const PORT = process.env.PORT;

app.use(express.json());
app.use(express.urlencoded({extended:true}));

app.use(cors());

connectDB();

app.use('/api/users', userRoutes);

app.listen(PORT, () => {
    console.log(`Server is listening on port: ${PORT}....`)
})