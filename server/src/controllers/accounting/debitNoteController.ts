import type { Request, RequestHandler } from 'express';
import * as debitNoteService from '../../services/accounting/debitNoteService.js';
import {
  applyDebitNoteSchema,
  createDebitNoteSchema,
  issueDebitNoteSchema,
  updateDebitNoteSchema,
  voidDebitNoteSchema,
} from '../../schemas/accounting/debitNoteSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isNoteStatus, type NoteStatus } from '../../types/accounting.js';

/**
 * Thin adapters over debitNoteService (Phase 26) — the purchase-side mirror
 * of creditNoteController. Zero SQL (guardrails rule 2).
 *
 * `update` and `remove` are legal despite rule 6 — both are refused by the
 * service and by migration 063's trigger for anything that is not a DRAFT.
 * An ISSUED debit note's only correction path is `void`, which posts a
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

/** GET /debit-notes */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { debitNotes, totalCount } = await debitNoteService.listDebitNotes(user.orgId, {
    page,
    limit,
    status: optionalStatus(req),
    vendorId: optionalUuid(req, 'vendorId'),
    billId: optionalUuid(req, 'billId'),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    count: debitNotes.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    debitNotes,
  });
};

/** GET /debit-notes/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const debitNote = await debitNoteService.getDebitNoteById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, debitNote });
};

/** POST /debit-notes — a DRAFT against an approved bill. */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createDebitNoteSchema, req.body);
  const debitNote = await debitNoteService.createDebitNote(user.orgId, user.id, input);
  res.status(201).json({ success: true, debitNote });
};

/** PATCH /debit-notes/:id — a draft only. */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateDebitNoteSchema, req.body);
  const debitNote = await debitNoteService.updateDebitNote(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, debitNote });
};

/** DELETE /debit-notes/:id — a draft only. */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await debitNoteService.deleteDebitNote(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /debit-notes/:id/issue */
export const issue: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(issueDebitNoteSchema, req.body ?? {});
  const debitNote = await debitNoteService.issueDebitNote(user.orgId, user.id, id, entryDate);
  res.json({ success: true, debitNote });
};

/** POST /debit-notes/:id/void */
export const void_: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(voidDebitNoteSchema, req.body ?? {});
  const debitNote = await debitNoteService.voidDebitNote(user.orgId, user.id, id, entryDate);
  res.json({ success: true, debitNote });
};

/** POST /debit-notes/:id/allocations — apply unapplied credit to an open bill. */
export const apply: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const input = parseBody(applyDebitNoteSchema, req.body);
  const debitNote = await debitNoteService.applyDebitNote(user.orgId, user.id, id, input);
  res.status(201).json({ success: true, debitNote });
};
