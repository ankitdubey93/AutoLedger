import { Router } from 'express';
import * as deckController from '../../controllers/boarddeck/deckController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/boarddeck/decks — see docs/api.md.
 *
 * Reading (including download) is open to any member. Creating/retrying a
 * deck needs ACCOUNTANT and above. Delete is OWNER/ADMIN only — it destroys
 * a board artifact, the same tier DELETE /forecaster/plans/:id uses for
 * removing a dimension from history.
 */
const router = Router();

router.get('/', authenticate, deckController.list);
router.get('/:id', authenticate, deckController.getOne);
router.get('/:id/download', authenticate, deckController.download);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), deckController.create);
router.post('/:id/retry', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), deckController.retry);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN'), deckController.remove);

export default router;
