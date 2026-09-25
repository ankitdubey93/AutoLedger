import type { RequestHandler } from 'express';
import * as driveConnectionService from '../../services/integrations/driveConnectionService.js';
import * as driveFolderService from '../../services/integrations/driveFolderService.js';
import { createDriveFolderSchema, updateDriveFolderSchema } from '../../schemas/integrations/driveSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { env } from '../../config/env.js';

/**
 * Thin adapters over driveConnectionService / driveFolderService. Zero SQL
 * (guardrails rule 2).
 *
 * TOKEN HYGIENE: no response body or redirect URL from this file ever
 * includes a token, verifier, state, key, or ciphertext — Google's own error
 * text is likewise never echoed to the client on the callback path.
 */

/** GET /integrations/drive */
export const getIntegration: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const [connection, folders] = await Promise.all([
    driveConnectionService.getConnection(user.orgId),
    driveFolderService.listFolders(user.orgId),
  ]);
  res.json({ success: true, connection, folders, modes: driveConnectionService.driveModes() });
};

/** POST /integrations/drive/connect */
export const connect: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { authorizationUrl } = await driveConnectionService.startConnect(user.orgId, user.id);
  res.json({ success: true, authorizationUrl });
};

/** POST /integrations/drive/connect/service-account */
export const connectServiceAccount: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const connection = await driveConnectionService.connectServiceAccount(user.orgId, user.id);
  res.json({ success: true, connection });
};

/** GET /integrations/drive/oauth/callback — no `authenticate`; the state IS the credential. */
export const oauthCallback: RequestHandler = async (req, res) => {
  const integrationsUrl = `${env.FRONTEND_URL}/settings/connections`;

  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;

  if (error !== undefined || code === undefined || state === undefined) {
    res.redirect(`${integrationsUrl}?drive=error`);
    return;
  }

  try {
    await driveConnectionService.completeConnect(state, code);
    res.redirect(`${integrationsUrl}?drive=connected`);
  } catch {
    res.redirect(`${integrationsUrl}?drive=error`);
  }
};

/** DELETE /integrations/drive */
export const disconnect: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await driveConnectionService.disconnect(user.orgId);
  res.status(204).send();
};

/** GET /integrations/drive/folders */
export const listFolders: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const folders = await driveFolderService.listFolders(user.orgId);
  res.json({ success: true, folders });
};

/** POST /integrations/drive/folders */
export const createFolder: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createDriveFolderSchema, req.body);
  const folder = await driveFolderService.createFolder(user.orgId, user.id, input);
  res.status(201).json({ success: true, folder });
};

/** PATCH /integrations/drive/folders/:id */
export const updateFolder: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateDriveFolderSchema, req.body);
  const folder = await driveFolderService.updateFolder(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, folder });
};

/** DELETE /integrations/drive/folders/:id */
export const deleteFolder: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await driveFolderService.deleteFolder(user.orgId, requireParam(req, 'id'));
  res.status(204).send();
};

/** POST /integrations/drive/folders/:id/sync */
export const syncFolder: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await driveFolderService.requestFolderSync(user.orgId, requireParam(req, 'id'));
  res.status(202).json({ success: true, queued: true });
};
