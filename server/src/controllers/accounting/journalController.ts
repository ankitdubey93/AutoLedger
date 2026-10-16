import type { RequestHandler } from 'express';
import * as journalService from '../../services/accounting/journalService.js';
import * as manualJournalService from '../../services/accounting/manualJournalService.js';
import {
  createJournalSchema,
  reverseJournalSchema,
} from '../../schemas/accounting/journalSchema.js';
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

/** GET /journals */
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

/** GET /journals/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const entry = await journalService.getEntryById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, entry });
};

/** POST /journals */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createJournalSchema, req.body);

  const journal = await manualJournalService.createManualJournal(
    user.orgId,
    user.id,
    {
      narration: input.description ?? 'Manual journal',
      entryDate: input.entryDate,
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        description: null,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      })),
    },
    'post',
  );
  if (journal.journalEntryId === null) throw new Error('Posted manual journal has no entry');
  const entry = await journalService.getEntryById(user.orgId, journal.journalEntryId);
  res.status(201).json({ success: true, entry });
};

/** POST /journals/:id/reverse — the only correction path. */
export const reverse: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  // An empty body is normal here, so the schema's defaults have to cover it.
  const { entryDate } = parseBody(reverseJournalSchema, req.body ?? {});

  const reversalId = await manualJournalService.reverseOrVoidEntry(user.orgId, user.id, id, entryDate);
  const entry = await journalService.getEntryById(user.orgId, reversalId);
  res.status(201).json({ success: true, entry });
};
