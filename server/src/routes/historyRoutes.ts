import { Router } from 'express';
import { makeHistoryController } from '../controllers/historyController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import type { Permission } from '../config/permissions.js';
import type { HistoryEntityType } from '../types/history.js';

/**
 * Phase 46c — GET <prefix>/:id/history and POST <prefix>/:id/notes, mounted
 * under each resource prefix in routes/accounting/index.ts. Each mount passes
 * the view and note permission keys of its own resource.
 */
export function buildHistoryRouter(entityType: HistoryEntityType, keys: { view: Permission; note: Permission }): Router {
  const router = Router();
  const c = makeHistoryController(entityType);
  router.get('/:id/history', authenticate, requirePermission(keys.view), c.list);
  router.post('/:id/notes', authenticate, requirePermission(keys.note), c.addNote);
  return router;
}
