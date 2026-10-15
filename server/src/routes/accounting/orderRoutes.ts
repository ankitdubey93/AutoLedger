import { Router } from 'express';
import { makeOrderController } from '../../controllers/accounting/orderController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import type { QuoteDirection } from '../../types/accounting.js';

/**
 * /api/v1/orders (SALES) and /api/v1/purchase-orders (PURCHASE) — Phase 42,
 * see docs/api.md. One router factory: the two resources are the same
 * document in two directions, gated by their own permission keys.
 *
 * PATCH/DELETE are draft-only (refused by the service and migration 092's
 * trigger otherwise). A confirmed order changes only by its lifecycle
 * transitions and conversion — none of which posts to the ledger.
 */

const KEYS = {
  SALES: { view: 'sales_orders.view', edit: 'sales_orders.edit', convert: 'sales_orders.convert' },
  PURCHASE: { view: 'purchase_orders.view', edit: 'purchase_orders.edit', convert: 'purchase_orders.convert' },
} as const;

export function buildOrderRouter(direction: QuoteDirection): Router {
  const router = Router();
  const c = makeOrderController(direction);
  const key = KEYS[direction];

  router.get('/', authenticate, requirePermission(key.view), c.list);
  router.get('/:id', authenticate, requirePermission(key.view), c.getOne);

  router.post('/', authenticate, requirePermission(key.edit), c.create);
  router.patch('/:id', authenticate, requirePermission(key.edit), c.update);
  router.delete('/:id', authenticate, requirePermission(key.edit), c.remove);

  router.post('/:id/confirm', authenticate, requirePermission(key.edit), c.confirm);
  router.post('/:id/close', authenticate, requirePermission(key.edit), c.close);
  router.post('/:id/reopen', authenticate, requirePermission(key.edit), c.reopen);
  router.post('/:id/cancel', authenticate, requirePermission(key.edit), c.cancel);

  router.post('/:id/convert', authenticate, requirePermission(key.convert), c.convert);
  router.post('/:id/deposit', authenticate, requirePermission(key.convert), c.deposit);

  return router;
}
