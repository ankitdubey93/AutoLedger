import type { RequestHandler } from 'express';
import * as driveConnectionService from '../../services/ap-flow/driveConnectionService.js';
import { setDriveFolderSchema } from '../../schemas/ap-flow/driveSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { env } from '../../config/env.js';

/**
 * Thin adapters over driveConnectionService. Zero SQL (guardrails rule 2).
 *
 * TOKEN HYGIENE: no response body or redirect URL from this file ever
 * includes a token, verifier, state, or ciphertext — Google's own error
 * text is likewise never echoed to the client on the callback path.
 */

/** GET /ap-flow/drive */
export const getConnection: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const connection = await driveConnectionService.getConnection(user.orgId);
  res.json({ success: true, connection, configured: driveConnectionService.isDriveConfigured() });
};

/** POST /ap-flow/drive/connect */
export const connect: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { authorizationUrl } = await driveConnectionService.startConnect(user.orgId, user.id);
  res.json({ success: true, authorizationUrl });
};

/** GET /ap-flow/drive/oauth/callback — no `authenticate`; the state IS the credential. */
export const oauthCallback: RequestHandler = async (req, res) => {
  const settingsUrl = `${env.FRONTEND_URL}/app/ap-flow/settings`;

  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;

  if (error !== undefined || code === undefined || state === undefined) {
    res.redirect(`${settingsUrl}?drive=error`);
    return;
  }

  try {
    await driveConnectionService.completeConnect(state, code);
    res.redirect(`${settingsUrl}?drive=connected`);
  } catch {
    res.redirect(`${settingsUrl}?drive=error`);
  }
};

/** PUT /ap-flow/drive/folder */
export const setFolder: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(setDriveFolderSchema, req.body);
  const connection = await driveConnectionService.setFolder(user.orgId, input.folder);
  res.json({ success: true, connection });
};

/** POST /ap-flow/drive/sync */
export const sync: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await driveConnectionService.requestSync(user.orgId);
  res.status(202).json({ success: true, queued: true });
};

/** DELETE /ap-flow/drive */
export const disconnect: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await driveConnectionService.disconnect(user.orgId);
  res.status(204).send();
};
