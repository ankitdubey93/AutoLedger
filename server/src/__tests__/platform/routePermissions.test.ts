import { describe, expect, it } from 'vitest';
import apiRouter from '../../routes/index.js';
import authRouter from '../../routes/auth.js';
import { authenticate } from '../../middleware/auth.js';
import {
  BUILTIN_ROLE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  isPermission,
  withRequiredPermissions,
} from '../../config/permissions.js';

/**
 * Phase 38c — the guard against a future route being forgotten.
 *
 * Every route whose middleware stack includes `authenticate` must also
 * carry an access decision: `requirePermission(key)` or the explicit
 * `allowAnyMember`. A new route added with only `authenticate` would be
 * open to every member of every role, silently — this test fails instead.
 *
 * The `/auth` router is exempt by identity: its authenticated routes act on
 * the caller's own identity (profile, sessions, switching organization),
 * not on organization data.
 *
 * Walks Express 5.2's router internals (`router.stack`, `layer.route`,
 * `layer.handle.stack`). Those are not a public API; if an Express upgrade
 * changes them, this test fails loudly (zero routes found), not silently.
 */

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle: unknown;
}

function collect(router: unknown, out: Array<{ where: string; handles: unknown[] }>, trail: string): void {
  const stack = (router as { stack?: RouteLayer[] }).stack ?? [];
  for (const layer of stack) {
    if (layer.route !== undefined) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      const handles = layer.route.stack.map((l) => l.handle);
      const last = handles[handles.length - 1];
      const name = typeof last === 'function' ? last.name : '?';
      // The mount prefix is not recoverable from Express 5's layers; the
      // handler name (`list`, `issue`…) plus the path is enough to find it.
      out.push({ where: `${methods} ${layer.route.path} → ${name}()${trail}`, handles });
    } else if (layer.handle === authRouter) {
      continue;
    } else if (typeof layer.handle === 'function' && 'stack' in (layer.handle as object)) {
      collect(layer.handle, out, `${trail}>`);
    }
  }
}

describe('every authenticated route makes an access decision', () => {
  const routes: Array<{ where: string; handles: unknown[] }> = [];
  collect(apiRouter, routes, '');

  it('finds the routes (guards against Express internals changing)', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('pairs authenticate with requirePermission or allowAnyMember', () => {
    const missing = routes
      .filter((r) => r.handles.includes(authenticate))
      .filter((r) => !r.handles.some((h) => typeof h === 'function' && 'accessDecision' in h))
      .map((r) => r.where);
    expect(missing).toEqual([]);
  });

  it('names only keys that exist in the catalogue', () => {
    const keys = routes.flatMap((r) =>
      r.handles
        .filter((h): h is { accessDecision: { kind: string; key?: string } } => typeof h === 'function' && 'accessDecision' in h)
        .map((h) => h.accessDecision.key)
        .filter((k): k is string => k !== undefined),
    );
    expect(keys.filter((k) => !isPermission(k))).toEqual([]);
    // And the catalogue has no dead keys: every permission guards something
    // (roles.manage and members.manage are checked in services as well).
    const used = new Set(keys);
    expect(PERMISSIONS.map((p) => p.key).filter((k) => !used.has(k))).toEqual([]);
  });
});

describe('the permission catalogue', () => {
  it('built-in roles are nested: VIEWER ⊂ ACCOUNTANT ⊂ ADMIN ⊂ OWNER', () => {
    const { OWNER, ADMIN, ACCOUNTANT, VIEWER } = BUILTIN_ROLE_PERMISSIONS;
    for (const k of VIEWER) expect(ACCOUNTANT.has(k)).toBe(true);
    for (const k of ACCOUNTANT) expect(ADMIN.has(k)).toBe(true);
    for (const k of ADMIN) expect(OWNER.has(k)).toBe(true);
    expect(OWNER.size).toBe(PERMISSIONS.length);
    for (const k of OWNER_ONLY_PERMISSIONS) expect(ADMIN.has(k as never)).toBe(false);
  });

  it('every built-in role already holds everything its permissions require', () => {
    for (const set of Object.values(BUILTIN_ROLE_PERMISSIONS)) {
      expect([...withRequiredPermissions(set)].sort()).toEqual([...set].sort());
    }
  });

  it('closes a selection over requires, transitively', () => {
    expect([...withRequiredPermissions(['invoices.issue'])].sort()).toEqual(['customers.view', 'invoices.issue', 'invoices.view']);
    expect(withRequiredPermissions(['not.a_key']).size).toBe(0);
  });
});
