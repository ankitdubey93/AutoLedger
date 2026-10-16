import { Router } from 'express';
import * as manualJournalController from '../../controllers/accounting/manualJournalController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/manual-journals — see docs/api.md.
 *
 * There is no PUT. PATCH and DELETE apply to drafts (and repeating templates,
 * for PATCH) only, which the service and the database trigger enforce. A
 * posted journal is corrected by POST /:id/void, which posts a reversing entry
 * (guardrails rule 6).
 *
 * Reading is open to anyone who can view journals. Writing takes ACCOUNTANT or
 * above, matching POST /journals.
 *
 * POST /repeating is registered before the /:id routes so that "repeating" is
 * never read as an id.
 */
const router = Router();

router.get('/', authenticate, requirePermission('journals.view'), manualJournalController.list);

router.post('/', authenticate, requirePermission('journals.create'), manualJournalController.create);

// Creating a repeating journal also creates a recurring schedule, so it needs
// recurring.manage on top of journals.create.
router.post(
  '/repeating',
  authenticate,
  requirePermission('journals.create'),
  requirePermission('recurring.manage'),
  manualJournalController.createRepeating,
);

router.get('/:id', authenticate, requirePermission('journals.view'), manualJournalController.getOne);
router.patch('/:id', authenticate, requirePermission('journals.create'), manualJournalController.update);
router.delete('/:id', authenticate, requirePermission('journals.create'), manualJournalController.remove);
router.post('/:id/post', authenticate, requirePermission('journals.create'), manualJournalController.post);
router.post(
  '/:id/void',
  authenticate,
  requirePermission('journals.create'),
  manualJournalController.voidJournal,
);

export default router;
