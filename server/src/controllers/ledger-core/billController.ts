import type { RequestHandler } from 'express';
import * as billService from '../../services/ledger-core/billService.js';
import {
  approveBillSchema,
  createBillSchema,
  submitBillSchema,
  updateBillSchema,
  voidBillSchema,
} from '../../schemas/ledger-core/billSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isBillStatus, type BillStatus } from '../../types/ledger-core.js';
import type { Request } from 'express';

/**
 * Thin adapters over billService. Zero SQL (guardrails rule 2).
 *
 * `update` and `remove` are legal here despite rule 6 — both are refused by
 * the service *and* the database trigger for anything that is not DRAFT or
 * AWAITING_APPROVAL, which has posted nothing to the ledger. A POSTED bill's
 * only correction path is `void`, which posts a reversing journal entry.
 */

function optionalStatus(req: Request): BillStatus | null {
  const raw = optionalText(req, 'status', 20);
  if (raw === null) return null;
  if (!isBillStatus(raw)) {
    throw new ApiError(400, 'status must be one of DRAFT, AWAITING_APPROVAL, POSTED, VOID');
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

/** GET /ledger-core/bills */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { bills, totalCount } = await billService.listBills(user.orgId, {
    page,
    limit,
    status: optionalStatus(req),
    vendorId: optionalUuid(req, 'vendorId'),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
    q: optionalText(req, 'q', 200),
    settlement: optionalSettlement(req),
  });

  res.json({
    success: true,
    count: bills.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    bills,
  });
};

/** GET /ledger-core/bills/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const bill = await billService.getBillById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, bill });
};

/** POST /ledger-core/bills */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createBillSchema, req.body);
  const bill = await billService.createBill(user.orgId, user.id, input);
  res.status(201).json({ success: true, bill });
};

/** PATCH /ledger-core/bills/:id — draft or in-review only. */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateBillSchema, req.body);
  const bill = await billService.updateBill(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, bill });
};

/** DELETE /ledger-core/bills/:id — draft or in-review only. */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await billService.deleteBill(user.orgId, requireParam(req, 'id'));
  res.status(204).end();
};

/** POST /ledger-core/bills/:id/submit */
export const submit: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  parseBody(submitBillSchema, req.body ?? {});
  const bill = await billService.submitBill(user.orgId, id);
  res.json({ success: true, bill });
};

/** POST /ledger-core/bills/:id/approve */
export const approve: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(approveBillSchema, req.body ?? {});
  const bill = await billService.approveBill(user.orgId, user.id, id, entryDate);
  res.json({ success: true, bill });
};

/** POST /ledger-core/bills/:id/void */
export const void_: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const { entryDate } = parseBody(voidBillSchema, req.body ?? {});
  const bill = await billService.voidBill(user.orgId, user.id, id, entryDate);
  res.json({ success: true, bill });
};
