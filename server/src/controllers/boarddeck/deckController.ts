import type { RequestHandler } from 'express';
import * as deckService from '../../services/boarddeck/deckService.js';
import { createDeckSchema } from '../../schemas/boarddeck/deckSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over deckService. Zero SQL (guardrails rule 2). */

/** GET /boarddeck/decks */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const decks = await deckService.listDecks(user.orgId);
  res.json({ success: true, count: decks.length, decks });
};

/** GET /boarddeck/decks/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const deck = await deckService.getDeckById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, deck });
};

/** POST /boarddeck/decks */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createDeckSchema, req.body);
  const deck = await deckService.createDeck(user.orgId, user.id, input);
  res.status(202).json({ success: true, deck });
};

/** POST /boarddeck/decks/:id/retry */
export const retry: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const deck = await deckService.retryDeck(user.orgId, requireParam(req, 'id'));
  res.status(202).json({ success: true, deck });
};

/** DELETE /boarddeck/decks/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await deckService.deleteDeck(user.orgId, requireParam(req, 'id'));
  res.status(204).send();
};

/** GET /boarddeck/decks/:id/download */
export const download: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { deck, stream } = await deckService.openDeckStream(user.orgId, requireParam(req, 'id'));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Length', String(deck.byteSizeBytes));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="deck-${deck.id}.pptx"`);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
};
