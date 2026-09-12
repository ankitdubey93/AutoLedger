import { Router } from 'express';
import * as cohortController from '../../controllers/unitecon/cohortController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/unitecon/cohorts — see docs/api.md.
 *
 * Reading is open to every member including VIEWER, matching
 * /ledger-core/reports — analytics is a report, and a VIEWER reading a
 * report needs to know the cohort window it covers.
 */
const router = Router();

router.get('/', authenticate, cohortController.getCohorts);

export default router;
