import type { RequestHandler } from 'express';
import * as journalService from '../../services/ledger-core/journalService.js';
import {
  createJournalSchema,
  reverseJournalSchema,
} from '../../schemas/ledger-core/journalSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/constants.js';

/**
 * Thin adapters over journalService. Zero SQL (guardrails rule 2).
 *
 * There is no `update` and no `remove` export, and there never will be: a
 * posted entry is immutable and corrections go through `reverse` (rule 6).
 */

/** Clamps pagination input; a caller asking for 10,000 rows gets MAX_PAGE_SIZE. */
function readPagination(query: unknown): { page: number; limit: number } {
  const params = query as Record<string, unknown>;
  const rawPage = Number(params.page ?? DEFAULT_PAGE_SIZE);
  const rawLimit = Number(params.limit ?? DEFAULT_PAGE_SIZE);

  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  return { page, limit };
}

/** GET /ledger-core/journals */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { entries, totalCount } = await journalService.listEntries(user.orgId, { page, limit });

  res.json({
    success: true,
    count: entries.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    entries,
  });
};

/** GET /ledger-core/journals/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const entry = await journalService.getEntryById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, entry });
};

/** POST /ledger-core/journals */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createJournalSchema, req.body);

  const entry = await journalService.createEntry(user.orgId, user.id, input);
  res.status(201).json({ success: true, entry });
};

/** POST /ledger-core/journals/:id/reverse — the only correction path. */
export const reverse: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  // An empty body is normal here, so the schema's defaults have to cover it.
  const { entryDate } = parseBody(reverseJournalSchema, req.body ?? {});

  const entry = await journalService.reverseEntry(user.orgId, user.id, id, entryDate);
  res.status(201).json({ success: true, entry });
};
