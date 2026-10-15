import type { RequestHandler } from 'express';
import * as invoiceService from '../../services/accounting/invoiceService.js';
import * as depositService from '../../services/accounting/depositService.js';
import { applyDepositSchema } from '../../schemas/accounting/depositSchema.js';
import {
  createInvoiceSchema,
  issueInvoiceSchema,
  updateInvoiceSchema,
  voidInvoiceSchema,
} from '../../schemas/accounting/invoiceSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination, readSort } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { loadAccess } from '../../middleware/rbac.js';
import * as availableCreditsService from '../../services/accounting/availableCreditsService.js';
import { isInvoiceStatus, type InvoiceStatus } from '../../types/accounting.js';
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

/** GET /invoices */
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
    sort: readSort(req, invoiceService.INVOICE_SORT_KEYS, { key: 'issueDate', direction: 'desc' }),
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

/** GET /invoices/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const invoice = await invoiceService.getInvoiceById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, invoice });
};

/** POST /invoices */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createInvoiceSchema, req.body);
  const invoice = await invoiceService.createInvoice(user.orgId, user.id, input);
  res.status(201).json({ success: true, invoice });
};

/** PATCH /invoices/:id — a draft only. */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateInvoiceSchema, req.body);
  const invoice = await invoiceService.updateInvoice(user.orgId, requireParam(req, 'id'), input, user.id);
  res.json({ success: true, invoice });
};

/** DELETE /invoices/:id — a draft only. */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await invoiceService.deleteInvoice(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /invoices/:id/issue */
export const issue: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate, applyCredits } = parseBody(issueInvoiceSchema, req.body ?? {});
  // Applying a credit note needs its own permission on top of invoices.issue; a
  // deposit needs nothing more (it matches POST /:id/apply-deposit).
  if (applyCredits.some((c) => c.kind === 'NOTE')) {
    const access = await loadAccess(req);
    if (!access.permissions.has('credit_notes.issue')) {
      throw new ApiError(403, 'Applying a credit note needs the "Issue and apply credit notes" permission.');
    }
  }
  const invoice = await invoiceService.issueInvoice(user.orgId, user.id, id, entryDate, applyCredits);
  res.json({ success: true, invoice });
};

/** GET /invoices/:id/available-credits — open credit notes and deposits this invoice could take (Phase 43c). */
export const availableCredits: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await availableCreditsService.listAvailableCredits(user.orgId, 'SALES', requireParam(req, 'id'));
  res.json({ success: true, ...result });
};

/** POST /invoices/:id/void */
export const void_: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(voidInvoiceSchema, req.body ?? {});
  const invoice = await invoiceService.voidInvoice(user.orgId, user.id, id, entryDate);
  res.json({ success: true, invoice });
};

/** POST /invoices/:id/apply-deposit — apply a paid DEPOSIT invoice to this STANDARD invoice (Phase 42). */
export const applyDeposit: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const input = parseBody(applyDepositSchema, req.body);
  const application = await depositService.applyDeposit(user.orgId, user.id, 'SALES', id, input);
  res.status(201).json({ success: true, application });
};
