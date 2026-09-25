import { Router } from 'express';
import setupRoutes from './setupRoutes.js';
import uomRoutes from './uomRoutes.js';
import categoryRoutes from './categoryRoutes.js';
import codeSchemeRoutes from './codeSchemeRoutes.js';
import locationRoutes from './locationRoutes.js';
import movementRoutes from './movementRoutes.js';
import valuationRoutes from './valuationRoutes.js';
import itemRoutes from './itemRoutes.js';
import serialRoutes from './serialRoutes.js';
import labelRoutes from './labelRoutes.js';

/**
 * Inventory's router, mounted at /api/v1/inventory by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is
 * still the only access-control boundary inside these routes (guardrails
 * rule 16).
 */
const router = Router();

router.use('/', setupRoutes);
router.use('/uoms', uomRoutes);
router.use('/categories', categoryRoutes);
router.use('/code-schemes', codeSchemeRoutes);
router.use('/locations', locationRoutes);
// Mounted before itemRoutes: this router owns /items/:id/lots and
// /items/:id/serials, and must not be shadowed by itemRoutes' /items/:id.
router.use('/', movementRoutes);
// Phase 35a: valuation, true-up, reclass, link-all; mounted before itemRoutes.
router.use('/', valuationRoutes);
router.use('/items', itemRoutes);
router.use('/serials', serialRoutes);
router.use('/', labelRoutes);

export default router;
