import { Router } from 'express';
import { makeQuoteController } from '../../controllers/accounting/quoteController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import type { QuoteDirection } from '../../types/accounting.js';

/**
 * /api/v1/quotes (SALES) and /api/v1/purchase-quotes (PURCHASE) — Phase 41,
 * see docs/api.md. One router factory: the two resources are the same
 * document in two directions, gated by their own permission keys.
 *
 * PATCH/DELETE are draft-only (refused by the service and migration 089's
 * trigger otherwise). A sent quote changes only by revision, void, a
 * response, or conversion — none of which posts to the ledger.
 */

const KEYS = {
  SALES: { view: 'quotes.view', edit: 'quotes.edit', send: 'quotes.send', convert: 'quotes.convert' },
  PURCHASE: {
    view: 'purchase_quotes.view',
    edit: 'purchase_quotes.edit',
    send: 'purchase_quotes.send',
    convert: 'purchase_quotes.convert',
  },
} as const;

export function buildQuoteRouter(direction: QuoteDirection): Router {
  const router = Router();
  const c = makeQuoteController(direction);
  const key = KEYS[direction];

  router.get('/', authenticate, requirePermission(key.view), c.list);
  router.get('/:id', authenticate, requirePermission(key.view), c.getOne);

  router.post('/', authenticate, requirePermission(key.edit), c.create);
  router.patch('/:id', authenticate, requirePermission(key.edit), c.update);
  router.delete('/:id', authenticate, requirePermission(key.edit), c.remove);
  router.post('/:id/revise', authenticate, requirePermission(key.edit), c.revise);

  router.post('/:id/send', authenticate, requirePermission(key.send), c.send);
  router.post('/:id/accept', authenticate, requirePermission(key.send), c.accept);
  router.post('/:id/decline', authenticate, requirePermission(key.send), c.decline);
  router.post('/:id/void', authenticate, requirePermission(key.send), c.void_);
  router.post('/:id/links/:linkId/revoke', authenticate, requirePermission(key.send), c.revokeLink);

  router.post('/:id/convert', authenticate, requirePermission(key.convert), c.convert);

  return router;
}
