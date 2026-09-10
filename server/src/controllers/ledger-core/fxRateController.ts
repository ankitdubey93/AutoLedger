import type { RequestHandler } from 'express';
import { pool } from '../../db/connect.js';
import { isSupportedCurrency } from '../../config/currencies.js';
import * as fxRateService from '../../services/ledger-core/fxRateService.js';
import * as organizationService from '../../services/organizationService.js';
import { upsertFxRateSchema } from '../../schemas/ledger-core/fxRateSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate, optionalText, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapters over fxRateService. Zero SQL (guardrails rule 2). */

/** GET /ledger-core/fx-rates */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { rates, totalCount } = await fxRateService.listRates(user.orgId, {
    page,
    limit,
    fromCode: optionalText(req, 'fromCode', 3),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    rates,
    count: rates.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  });
};

/** GET /ledger-core/fx-rates/latest */
export const latest: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  const fromRaw = req.query.from;
  if (typeof fromRaw !== 'string' || !isSupportedCurrency(fromRaw.toUpperCase())) {
    throw new ApiError(400, 'from must be a supported 3-letter ISO currency code');
  }
  const fromCode = fromRaw.toUpperCase();

  const onDate = optionalIsoDate(req, 'on') ?? new Date().toISOString().slice(0, 10);

  const organization = await organizationService.getById(user.orgId);
  const rate = await fxRateService.requireRateOnClient(
    pool,
    user.orgId,
    fromCode,
    organization.baseCurrency,
    onDate,
  );

  res.json({ success: true, rate });
};

/** POST /ledger-core/fx-rates */
export const upsert: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(upsertFxRateSchema, req.body);
  const rate = await fxRateService.upsertRate(user.orgId, user.id, input);
  res.status(201).json({ success: true, rate });
};

/** DELETE /ledger-core/fx-rates/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await fxRateService.deleteRate(user.orgId, requireParam(req, 'id'));
  res.status(204).send();
};
