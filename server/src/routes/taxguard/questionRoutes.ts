import { Router } from 'express';
import * as questionController from '../../controllers/taxguard/questionController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/taxguard/questions — see docs/api.md.
 *
 * Reading and asking are open to any member. Delete is OWNER/ADMIN only —
 * removing a question/answer from the org's own history.
 */
const router = Router();

router.get('/', authenticate, questionController.list);
router.get('/:id', authenticate, questionController.getOne);
router.post('/', authenticate, questionController.ask);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN'), questionController.remove);

export default router;
