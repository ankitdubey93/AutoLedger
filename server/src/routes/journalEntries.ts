import express, {Request, Response, NextFunction} from 'express';
import JournalEntry from '../models/JournalEntry';
import auth from '../middleware/auth';
import { JwtPayload } from 'jsonwebtoken';

interface CustomRequest extends Request {
    user?: JwtPayload;
}

const router = express.Router();


router.get('/', auth, async (req: CustomRequest, res: Response, next: NextFunction) => {
    try{
        const user = req.user?.user.id;
        console.log(user);
        const journalEntries = await JournalEntry.find({userId: user});
        console.log(journalEntries);
        res.status(200).json(journalEntries);
    } catch (error) {
        next(error);
    }
});

router.post('/', auth, async (req: CustomRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        console.log('Receiving body: ', req.body);
        const {date, description, amount} = req.body;
       
        const userId = req.user?.user.id;
        
        const newEntry = new JournalEntry({
            date, 
            description, 
           amount,
            userId: userId,
        })
        await newEntry.save();
        res.status(201).json({message: 'Journal entry added successfully.'})
    } catch (error) {
        next(error);
    }
});

router.put('/:id', auth, async (req: CustomRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const {date, description, lines} = req.body;
        const journalEntry = await JournalEntry.findById(req.params.id);
        if(!journalEntry) {
            res.status(404).json({message: 'Journal entry not found.'})
            return;
        }
        if(journalEntry.userId.toString() !== req.user?.id) {
            res.status(403).json({message: 'Unauthorized'});
        }

        await JournalEntry.findByIdAndUpdate(req.params.id, {
            date,
            description,
            lines,
        });
        res.status(202).json({message: 'Journal entry updated successfully.'})
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', auth, async (req: CustomRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const journalEntry = await JournalEntry.findById(req.params.id);

        if(!journalEntry) {
            res.status(404).json({message: 'Journal entry not found.'});
            return;
        }

        if(journalEntry.userId.toString() !== req.user?.id) {
            res.status(403).json({message: 'Unauthorized'});
            return;
        }
        await JournalEntry.findByIdAndDelete(req.params.id);
        res.status(201).json({message: 'Journal entry deleted successfully.'});


    }  catch (error) {
        next(error);
    }
})


export default router;