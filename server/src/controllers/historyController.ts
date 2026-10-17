import type { RequestHandler } from 'express';
import * as historyService from '../services/historyService.js';
import { addHistoryNoteSchema } from '../schemas/historySchema.js';
import type { HistoryEntityType } from '../types/history.js';
import { parseBody } from '../utils/parseBody.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';

/**
 * Phase 46c — thin adapters over historyService. Zero SQL (guardrails rule 2).
 * One factory per entity type; the router decides which type a mount carries.
 */
export function makeHistoryController(entityType: HistoryEntityType) {
  return {
    list: (async (req, res) => {
      const user = requireUser(req);
      const history = await historyService.listHistory(user.orgId, entityType, requireParam(req, 'id'));
      res.json({ success: true, count: history.length, history });
    }) satisfies RequestHandler,
    addNote: (async (req, res) => {
      const user = requireUser(req);
      const { text } = parseBody(addHistoryNoteSchema, req.body);
      const entry = await historyService.addNote(user.orgId, user.id, entityType, requireParam(req, 'id'), text);
      res.status(201).json({ success: true, entry });
    }) satisfies RequestHandler,
  };
}
