import type { Request, RequestHandler } from 'express';
import * as bankMatchService from '../../services/ledger-core/bankMatchService.js';
import { matchBankTransactionSchema } from '../../schemas/ledger-core/bankSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { isBankTransactionStatus, type BankTransactionStatus } from '../../types/ledger-core.js';

/**
 * Thin adapters over bankMatchService. Zero SQL (guardrails rule 2).
 *
 * There is no PATCH and no DELETE — a bank line's match state changes only
 * through match/unmatch/ignore/unignore, and unmatch corrects a posted
 * payment by voiding it, never by editing it (guardrails rule 6).
 */

function optionalStatus(req: Request): BankTransactionStatus | null {
  const raw = optionalText(req, 'status', 20);
  if (raw === null) return null;
  if (!isBankTransactionStatus(raw)) {
    throw new ApiError(400, 'status must be UNMATCHED, MATCHED or IGNORED');
  }
  return raw;
}

function optionalMinScore(req: Request): number | null {
  const raw = req.query.minScore;
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new ApiError(400, 'minScore must be a whole number between 0 and 100');
  }
  return value;
}

/** GET /ledger-core/bank-transactions */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { transactions, totalCount } = await bankMatchService.listTransactions(user.orgId, {
    page,
    limit,
    accountId: optionalUuid(req, 'accountId'),
    importId: optionalUuid(req, 'importId'),
    status: optionalStatus(req),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
    q: optionalText(req, 'q', 100),
    minScore: optionalMinScore(req),
  });

  res.json({
    success: true,
    count: transactions.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    transactions,
  });
};

/** GET /ledger-core/bank-transactions/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const transaction = await bankMatchService.getTransactionById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, transaction });
};

/** POST /ledger-core/bank-transactions/:id/rescore */
export const rescore: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const transaction = await bankMatchService.rescoreTransaction(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, transaction });
};

/** POST /ledger-core/bank-transactions/:id/match */
export const match: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const target = parseBody(matchBankTransactionSchema, req.body);
  const transaction = await bankMatchService.matchTransaction(user.orgId, user.id, id, target);
  res.json({ success: true, transaction });
};

/** POST /ledger-core/bank-transactions/:id/unmatch */
export const unmatch: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const transaction = await bankMatchService.unmatchTransaction(user.orgId, user.id, id);
  res.json({ success: true, transaction });
};

/** POST /ledger-core/bank-transactions/:id/ignore */
export const ignore: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const transaction = await bankMatchService.setIgnored(user.orgId, id, true);
  res.json({ success: true, transaction });
};

/** POST /ledger-core/bank-transactions/:id/unignore */
export const unignore: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');
  const transaction = await bankMatchService.setIgnored(user.orgId, id, false);
  res.json({ success: true, transaction });
};
