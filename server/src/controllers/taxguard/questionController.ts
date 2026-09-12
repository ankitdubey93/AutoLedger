import type { RequestHandler } from 'express';
import * as questionService from '../../services/taxguard/questionService.js';
import { askSchema } from '../../schemas/taxguard/questionSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over questionService. Zero SQL (guardrails rule 2). */

/** GET /taxguard/questions */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const questions = await questionService.listQuestions(user.orgId);
  res.json({ success: true, questions });
};

/** GET /taxguard/questions/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const question = await questionService.getQuestionById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, question });
};

/** POST /taxguard/questions */
export const ask: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(askSchema, req.body);
  const question = await questionService.ask(user.orgId, user.id, input);
  res.status(201).json({ success: true, question });
};

/** DELETE /taxguard/questions/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await questionService.deleteQuestion(user.orgId, requireParam(req, 'id'));
  res.status(204).send();
};
