import type { Request, RequestHandler } from 'express';
import * as quoteService from '../../services/accounting/quoteService.js';
import {
  convertQuoteSchema,
  createQuoteSchema,
  recordAcceptanceSchema,
  recordDeclineSchema,
  sendQuoteSchema,
  updateQuoteSchema,
  voidQuoteSchema,
} from '../../schemas/accounting/quoteSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination, readSort } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isQuoteStatus, QUOTE_STATUSES, type QuoteDirection, type QuoteStatus } from '../../types/accounting.js';

/**
 * Phase 41 — thin adapters over quoteService, built once per direction so
 * `/quotes` (SALES) and `/purchase-quotes` (PURCHASE) share every handler.
 * The direction is fixed by the router, never read from the request. Zero
 * SQL (guardrails rule 2).
 */

function optionalStatus(req: Request): QuoteStatus | null {
  const raw = optionalText(req, 'status', 12);
  if (raw === null) return null;
  if (!isQuoteStatus(raw)) throw new ApiError(400, `status must be one of ${QUOTE_STATUSES.join(', ')}`);
  return raw;
}

export interface QuoteController {
  list: RequestHandler;
  getOne: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  send: RequestHandler;
  revise: RequestHandler;
  accept: RequestHandler;
  decline: RequestHandler;
  void_: RequestHandler;
  revokeLink: RequestHandler;
  convert: RequestHandler;
}

export function makeQuoteController(direction: QuoteDirection): QuoteController {
  return {
    /** GET / */
    list: async (req, res) => {
      const user = requireUser(req);
      const { page, limit } = readPagination(req.query);
      const { quotes, totalCount } = await quoteService.listQuotes(user.orgId, direction, {
        page,
        limit,
        status: optionalStatus(req),
        partyId: optionalUuid(req, 'partyId'),
        from: optionalIsoDate(req, 'from'),
        to: optionalIsoDate(req, 'to'),
        q: optionalText(req, 'q', 200),
        sort: readSort(req, quoteService.QUOTE_SORT_KEYS, { key: 'quoteDate', direction: 'desc' }),
      });
      res.json({
        success: true,
        count: quotes.length,
        totalCount,
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
        quotes,
      });
    },

    /** GET /:id */
    getOne: async (req, res) => {
      const user = requireUser(req);
      const quote = await quoteService.getQuoteById(user.orgId, direction, requireParam(req, 'id'));
      res.json({ success: true, quote });
    },

    /** POST / — a DRAFT. */
    create: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(createQuoteSchema, req.body);
      const quote = await quoteService.createQuote(user.orgId, user.id, direction, input);
      res.status(201).json({ success: true, quote });
    },

    /** PATCH /:id — a draft only. */
    update: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(updateQuoteSchema, req.body);
      const quote = await quoteService.updateQuote(user.orgId, direction, requireParam(req, 'id'), input);
      res.json({ success: true, quote });
    },

    /** DELETE /:id — a draft only. */
    remove: async (req, res) => {
      const user = requireUser(req);
      await quoteService.deleteQuote(user.orgId, direction, requireParam(req, 'id'));
      res.status(204).end();
    },

    /** POST /:id/send — finalize (number + freeze) and optionally email the review link. */
    send: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(sendQuoteSchema, req.body);
      const quote = await quoteService.sendQuote(user.orgId, user.id, direction, requireParam(req, 'id'), input);
      res.json({ success: true, quote });
    },

    /** POST /:id/revise — a new draft revision. */
    revise: async (req, res) => {
      const user = requireUser(req);
      const quote = await quoteService.reviseQuote(user.orgId, user.id, direction, requireParam(req, 'id'));
      res.status(201).json({ success: true, quote });
    },

    /** POST /:id/accept — record an acceptance received another way. */
    accept: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(recordAcceptanceSchema, req.body);
      const quote = await quoteService.recordResponse(user.orgId, user.id, direction, requireParam(req, 'id'), {
        response: 'ACCEPTED',
        signerName: input.signerName,
        note: input.note,
      });
      res.json({ success: true, quote });
    },

    /** POST /:id/decline — record a decline received another way. */
    decline: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(recordDeclineSchema, req.body ?? {});
      const quote = await quoteService.recordResponse(user.orgId, user.id, direction, requireParam(req, 'id'), {
        response: 'DECLINED',
        reason: input.reason,
        note: input.note,
      });
      res.json({ success: true, quote });
    },

    /** POST /:id/void */
    void_: async (req, res) => {
      const user = requireUser(req);
      const { reason } = parseBody(voidQuoteSchema, req.body);
      const quote = await quoteService.voidQuote(user.orgId, direction, requireParam(req, 'id'), reason);
      res.json({ success: true, quote });
    },

    /** POST /:id/links/:linkId/revoke */
    revokeLink: async (req, res) => {
      const user = requireUser(req);
      const quote = await quoteService.revokeLink(
        user.orgId,
        direction,
        requireParam(req, 'id'),
        requireParam(req, 'linkId'),
      );
      res.json({ success: true, quote });
    },

    /** POST /:id/convert — an accepted quote becomes a draft invoice or bill. */
    convert: async (req, res) => {
      const user = requireUser(req);
      const input = parseBody(convertQuoteSchema, req.body ?? {});
      const document = await quoteService.convertQuote(user.orgId, user.id, direction, requireParam(req, 'id'), input);
      res.status(201).json({ success: true, document });
    },
  };
}
