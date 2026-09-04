import type { RequestHandler } from 'express';
import * as invoiceService from '../../services/ledger-core/invoiceService.js';
import {
  createInvoiceSchema,
  issueInvoiceSchema,
  updateInvoiceSchema,
  voidInvoiceSchema,
} from '../../schemas/ledger-core/invoiceSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isInvoiceStatus, type InvoiceStatus } from '../../types/ledger-core.js';
import type { Request } from 'express';

/**
 * Thin adapters over invoiceService. Zero SQL (guardrails rule 2).
 *
 * `update` and `remove` are legal here despite rule 6 — both are refused by
 * the service *and* the database trigger for anything that is not a DRAFT,
 * which has posted nothing to the ledger. An ISSUED invoice's only correction
 * path is `void`, which posts a reversing journal entry.
 */

function optionalStatus(req: Request): InvoiceStatus | null {
  const raw = optionalText(req, 'status', 10);
  if (raw === null) return null;
  if (!isInvoiceStatus(raw)) {
    throw new ApiError(400, 'status must be one of DRAFT, ISSUED, VOID');
  }
  return raw;
}

const SETTLEMENT_FILTERS = ['OUTSTANDING', 'OVERDUE', 'PAID'] as const;
type SettlementFilter = (typeof SETTLEMENT_FILTERS)[number];

function optionalSettlement(req: Request): SettlementFilter | null {
  const raw = optionalText(req, 'settlement', 20);
  if (raw === null) return null;
  if (!(SETTLEMENT_FILTERS as readonly string[]).includes(raw)) {
    throw new ApiError(400, 'settlement must be one of OUTSTANDING, OVERDUE, PAID');
  }
  return raw as SettlementFilter;
}

/** GET /ledger-core/invoices */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { invoices, totalCount } = await invoiceService.listInvoices(user.orgId, {
    page,
    limit,
    status: optionalStatus(req),
    customerId: optionalUuid(req, 'customerId'),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
    q: optionalText(req, 'q', 200),
    settlement: optionalSettlement(req),
  });

  res.json({
    success: true,
    count: invoices.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    invoices,
  });
};

/** GET /ledger-core/invoices/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const invoice = await invoiceService.getInvoiceById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, invoice });
};

/** POST /ledger-core/invoices */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createInvoiceSchema, req.body);
  const invoice = await invoiceService.createInvoice(user.orgId, user.id, input);
  res.status(201).json({ success: true, invoice });
};

/** PATCH /ledger-core/invoices/:id — a draft only. */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateInvoiceSchema, req.body);
  const invoice = await invoiceService.updateInvoice(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, invoice });
};

/** DELETE /ledger-core/invoices/:id — a draft only. */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await invoiceService.deleteInvoice(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /ledger-core/invoices/:id/issue */
export const issue: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(issueInvoiceSchema, req.body ?? {});
  const invoice = await invoiceService.issueInvoice(user.orgId, user.id, id, entryDate);
  res.json({ success: true, invoice });
};

/** POST /ledger-core/invoices/:id/void */
export const void_: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(voidInvoiceSchema, req.body ?? {});
  const invoice = await invoiceService.voidInvoice(user.orgId, user.id, id, entryDate);
  res.json({ success: true, invoice });
};
