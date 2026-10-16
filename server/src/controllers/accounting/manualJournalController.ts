import type { RequestHandler } from 'express';
import * as manualJournalService from '../../services/accounting/manualJournalService.js';
import * as recurringService from '../../services/accounting/recurringService.js';
import {
  createManualJournalSchema,
  createRepeatingJournalSchema,
  listManualJournalsQuerySchema,
  manualJournalBodySchema,
  voidManualJournalSchema,
} from '../../schemas/accounting/manualJournalSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, readPagination } from '../../utils/queryParam.js';

/**
 * Thin adapters over manualJournalService and recurringService. Zero SQL
 * (guardrails rule 2).
 *
 * There is no PUT. PATCH and DELETE apply to drafts only; the service and the
 * database trigger refuse anything else (guardrails rule 6). A posted journal's
 * only correction is POST /:id/void, which posts a reversing entry.
 */

/** GET /manual-journals */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const { status } = parseBody(listManualJournalsQuerySchema, req.query);

  const { journals, totalCount, counts } = await manualJournalService.listManualJournals(user.orgId, {
    status,
    q: optionalText(req, 'q', 200),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
    page,
    limit,
  });

  res.json({
    success: true,
    count: journals.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    counts,
    journals,
  });
};

/** GET /manual-journals/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const journal = await manualJournalService.getManualJournalById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, journal });
};

/** POST /manual-journals — action 'draft' saves a draft; 'post' saves and posts. */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { action, ...input } = parseBody(createManualJournalSchema, req.body);
  const journal = await manualJournalService.createManualJournal(user.orgId, user.id, input, action);
  res.status(201).json({ success: true, journal });
};

/** PATCH /manual-journals/:id — full replacement; draft or repeating template only. */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(manualJournalBodySchema, req.body);
  const journal = await manualJournalService.updateManualJournal(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, journal });
};

/** DELETE /manual-journals/:id — draft only. */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await manualJournalService.deleteManualJournal(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /manual-journals/:id/post — draft to posted. */
export const post: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const journal = await manualJournalService.postManualJournal(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, journal });
};

/** POST /manual-journals/:id/void — posts a reversing entry; the journal becomes VOIDED. */
export const voidJournal: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { voidDate } = parseBody(voidManualJournalSchema, req.body ?? {});
  const journal = await manualJournalService.voidManualJournal(user.orgId, user.id, id, voidDate);
  res.json({ success: true, journal });
};

/** POST /manual-journals/repeating — a repeating journal created without posting one first. */
export const createRepeating: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createRepeatingJournalSchema, req.body);
  const { journal, schedule } = await recurringService.createRepeatingJournal(user.orgId, user.id, input);
  res.status(201).json({ success: true, journal, schedule });
};
