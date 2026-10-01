import { Router } from 'express';
import * as fxRateController from '../../controllers/accounting/fxRateController.js';
import { authenticate } from '../../middleware/auth.js';
import { allowAnyMember, requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/fx-rates — see docs/api.md.
 *
 * Reading is open to any member, matching /reports — a VIEWER building a
 * report needs to see which rate was used. Recording a rate takes ACCOUNTANT
 * or above, matching /accounts and /journals. Deleting is narrower — OWNER
 * or ADMIN only, matching the tier that can delete other reference data.
 *
 * /latest is declared before /:id so a literal path is never shadowed by the
 * param route, matching the ordering discipline in fiscalPeriodRoutes.ts.
 * There is no GET /:id — a rate is looked up by pair and date, never by id.
 */
const router = Router();

router.get('/', authenticate, requirePermission('fx.view'), fxRateController.list);
router.get('/latest', authenticate, allowAnyMember, fxRateController.latest);
router.post('/', authenticate, requirePermission('fx.rates_edit'), fxRateController.upsert);
router.delete('/:id', authenticate, requirePermission('fx.rates_delete'), fxRateController.remove);

export default router;
