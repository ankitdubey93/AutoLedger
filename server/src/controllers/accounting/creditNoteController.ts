import type { Request, RequestHandler } from 'express';
import * as creditNoteService from '../../services/accounting/creditNoteService.js';
import {
  applyCreditNoteSchema,
  createCreditNoteSchema,
  issueCreditNoteSchema,
  updateCreditNoteSchema,
  voidCreditNoteSchema,
} from '../../schemas/accounting/creditNoteSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isNoteStatus, type NoteStatus } from '../../types/accounting.js';

/**
 * Thin adapters over creditNoteService (Phase 26). Zero SQL (guardrails
 * rule 2).
 *
 * `update` and `remove` are legal despite rule 6 — both are refused by the
 * service and by migration 063's trigger for anything that is not a DRAFT.
 * An ISSUED credit note's only correction path is `void`, which posts a
 * reversing journal entry.
 */

function optionalStatus(req: Request): NoteStatus | null {
  const raw = optionalText(req, 'status', 10);
  if (raw === null) return null;
  if (!isNoteStatus(raw)) {
    throw new ApiError(400, 'status must be one of DRAFT, ISSUED, VOID');
  }
  return raw;
}

/** GET /credit-notes */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { creditNotes, totalCount } = await creditNoteService.listCreditNotes(user.orgId, {
    page,
    limit,
    status: optionalStatus(req),
    customerId: optionalUuid(req, 'customerId'),
    invoiceId: optionalUuid(req, 'invoiceId'),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    count: creditNotes.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    creditNotes,
  });
};

/** GET /credit-notes/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const creditNote = await creditNoteService.getCreditNoteById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, creditNote });
};

/** POST /credit-notes — a DRAFT against an issued invoice. */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createCreditNoteSchema, req.body);
  const creditNote = await creditNoteService.createCreditNote(user.orgId, user.id, input);
  res.status(201).json({ success: true, creditNote });
};

/** PATCH /credit-notes/:id — a draft only. */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateCreditNoteSchema, req.body);
  const creditNote = await creditNoteService.updateCreditNote(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, creditNote });
};

/** DELETE /credit-notes/:id — a draft only. */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await creditNoteService.deleteCreditNote(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /credit-notes/:id/issue */
export const issue: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(issueCreditNoteSchema, req.body ?? {});
  const creditNote = await creditNoteService.issueCreditNote(user.orgId, user.id, id, entryDate);
  res.json({ success: true, creditNote });
};

/** POST /credit-notes/:id/void */
export const void_: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(voidCreditNoteSchema, req.body ?? {});
  const creditNote = await creditNoteService.voidCreditNote(user.orgId, user.id, id, entryDate);
  res.json({ success: true, creditNote });
};

/** POST /credit-notes/:id/allocations — apply unapplied credit to an open invoice. */
export const apply: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const input = parseBody(applyCreditNoteSchema, req.body);
  const creditNote = await creditNoteService.applyCreditNote(user.orgId, user.id, id, input);
  res.status(201).json({ success: true, creditNote });
};
