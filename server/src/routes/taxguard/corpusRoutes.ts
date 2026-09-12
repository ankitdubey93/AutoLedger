import { Router } from 'express';
import * as corpusController from '../../controllers/taxguard/corpusController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/taxguard/corpus — see docs/api.md.
 *
 * Reading is open to any member. Adding/deleting a corpus document needs
 * ACCOUNTANT and above for create, OWNER/ADMIN for delete — it destroys an
 * ingested tax act and its chunks, the same tier BoardDeck's deck delete uses.
 */
const router = Router();

router.get('/', authenticate, corpusController.list);
router.get('/:id', authenticate, corpusController.getOne);
router.get('/:id/chunks', authenticate, corpusController.chunks);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), corpusController.create);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN'), corpusController.remove);

export default router;
