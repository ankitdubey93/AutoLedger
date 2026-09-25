import { Router } from 'express';
import * as labelController from '../../controllers/inventory/labelController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/inventory/lookup and /api/v1/inventory/labels — see docs/api.md.
 *
 * Both are open to any member: lookup and label generation never write.
 * `/labels` is a POST only because its `targets` array does not fit a
 * query string, not because it changes anything.
 */
const router = Router();

router.get('/lookup', authenticate, labelController.lookup);
router.post('/labels', authenticate, labelController.labels);

export default router;
