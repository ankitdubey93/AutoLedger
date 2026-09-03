import type { RequestHandler } from 'express';
import * as accountService from '../../services/ledger-core/accountService.js';
import * as accountLedgerService from '../../services/ledger-core/accountLedgerService.js';
import { createAccountSchema, updateAccountSchema } from '../../schemas/ledger-core/accountSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, readPagination } from '../../utils/queryParam.js';

/**
 * Thin adapters over accountService. Zero SQL (guardrails rule 2).
 *
 * The organization comes from `requireUser(req).orgId` — the verified access
 * token — and never from a param, query value or header. The app slug in the
 * URL is a routing namespace, not a tenancy boundary (rule 16).
 */

/** Reads a `?flag=true` query parameter without treating any other value as true. */
function isTrue(value: unknown): boolean {
  return value === 'true';
}

/** GET /ledger-core/accounts — the org's chart, flat or as a tree. */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  if (isTrue(req.query.tree)) {
    const accounts = await accountService.listAccountTree(user.orgId);
    // `count` is the total number of accounts, not the number of roots — a
    // caller comparing it against the flat list should get the same number.
    const count = accounts.reduce(function size(total, node): number {
      return total + 1 + node.children.reduce(size, 0);
    }, 0);
    res.json({ success: true, count, accounts });
    return;
  }

  const accounts = await accountService.listAccounts(user.orgId, {
    includeInactive: isTrue(req.query.includeInactive),
  });
  res.json({ success: true, count: accounts.length, accounts });
};

/** GET /ledger-core/accounts/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');

  const account = await accountService.getAccountById(user.orgId, id);
  res.json({ success: true, account });
};

/** POST /ledger-core/accounts */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createAccountSchema, req.body);

  const account = await accountService.createAccount(user.orgId, user.id, input);
  res.status(201).json({ success: true, account });
};

/** PATCH /ledger-core/accounts/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const id = requireParam(req, 'id');

  const input = parseBody(updateAccountSchema, req.body);
  const account = await accountService.updateAccount(user.orgId, id, input);
  res.json({ success: true, account });
};

/** GET /ledger-core/accounts/balances?asOf=YYYY-MM-DD */
export const balances: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');
  const rows = await accountLedgerService.accountBalances(user.orgId, asOf);
  res.json({ success: true, asOf, count: rows.length, balances: rows });
};

/** GET /ledger-core/accounts/:id/ledger */
export const ledger: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const result = await accountLedgerService.accountLedger(user.orgId, requireParam(req, 'id'), {
    page,
    limit,
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    ...result,
    count: result.rows.length,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(result.totalCount / limit)),
  });
};
