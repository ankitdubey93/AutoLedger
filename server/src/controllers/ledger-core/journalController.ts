import type { RequestHandler } from 'express';
import * as journalService from '../../services/ledger-core/journalService.js';
import {
  createJournalSchema,
  reverseJournalSchema,
} from '../../schemas/ledger-core/journalSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';

/**
 * Thin adapters over journalService. Zero SQL (guardrails rule 2).
 *
 * There is no `update` and no `remove` export, and there never will be: a
 * posted entry is immutable and corrections go through `reverse` (rule 6).
 */

/** GET /ledger-core/journals */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { entries, totalCount } = await journalService.listEntries(user.orgId, {
    page,
    limit,
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
    accountId: optionalUuid(req, 'accountId'),
    sourceType: optionalText(req, 'sourceType', 50),
    q: optionalText(req, 'q', 200),
  });

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
