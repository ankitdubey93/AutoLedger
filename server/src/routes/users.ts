import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import dotenv from 'dotenv';

dotenv.config();

const jwtSecret = process.env.JWT_SECRET;

const router = express.Router();

router.post('/signup', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, password } = req.body;
        

        const existingUser = await User.findOne({ username });
        if (existingUser) {
        res.status(400).json({ message: 'User already exists' });
        return;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });

        await newUser.save();

        res.status(201).json({ message: 'User created successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error.' });
    }
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, password } = req.body;
        

        const user = await User.findOne({ username });
        if (!user) {
            res.status(400).json({ message: 'Invalid credentials.' });
            return;
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            res.status(400).json({ message: 'Invalid credentials.' });
            return;
        }

        const payload = { user: { id: user.id } };

        const token = jwt.sign(payload, jwtSecret as string, { expiresIn: '1h' });

        res.json({ token });
        console.log(token);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error.' });
    }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
       
        const user = await User.findById(req.params.id);
        if(!user) {
            res.status(404).json({message: 'User not found.'});
            return;
        }
        res.status(201).json(user);
    } catch (error) {
        console.error('Error fetching user by id: ', error);
        res.status(500).json({message: 'Error fetching data: ', error});
    }
})



// THis is a development level route only. Delete after development testing.


router.get('/', async (req: Request, res: Response):Promise<void> => {
    const users = await User.find();

    res.json(users);
})

export default router;
