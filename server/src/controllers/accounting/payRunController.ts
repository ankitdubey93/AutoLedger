import type { RequestHandler } from 'express';
import * as payRunService from '../../services/accounting/payRunService.js';
import { bankAccountDetailsSchema, createPaymentBatchSchema, vendorBankDetailsSchema } from '../../schemas/accounting/payRunSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireParam } from '../../utils/routeParam.js';
import { requireUser } from '../../utils/requireUser.js';

/** Thin adapters over payRunService. Zero SQL (rule 2). */

export const getBankAccount: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  res.json({ success: true, details: await payRunService.getBankAccountDetails(user.orgId, requireParam(req, 'accountId')) });
};

export const saveBankAccount: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(bankAccountDetailsSchema, req.body);
  res.json({ success: true, details: await payRunService.saveBankAccountDetails(user.orgId, requireParam(req, 'accountId'), input) });
};

export const listVendors: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  res.json({ success: true, details: await payRunService.listVendorBankDetails(user.orgId) });
};

export const saveVendor: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(vendorBankDetailsSchema, req.body);
  res.json({ success: true, details: await payRunService.saveVendorBankDetails(user.orgId, user.id, requireParam(req, 'vendorId'), input) });
};

export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  res.json({ success: true, batches: await payRunService.listPaymentBatches(user.orgId) });
};

export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createPaymentBatchSchema, req.body);
  res.status(201).json({ success: true, batch: await payRunService.createPaymentBatch(user.orgId, user.id, input) });
};

export const aba: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { filename, content } = await payRunService.buildBatchAbaFile(user.orgId, requireParam(req, 'id'));
  res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(content);
};
