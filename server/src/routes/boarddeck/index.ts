import { Router } from 'express';
import closeRunRoutes from './closeRunRoutes.js';
import bvaRoutes from './bvaRoutes.js';
import deckRoutes from './deckRoutes.js';

/**
 * BoardDeck Automator's router, mounted at /api/v1/boarddeck by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/close-runs', closeRunRoutes);
router.use('/bva', bvaRoutes);
router.use('/decks', deckRoutes);

export default router;
