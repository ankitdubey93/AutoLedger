import type { AuthUser } from './auth.js';
import type { MemberAccess } from '../services/permissionService.js';

/**
 * Declaration merging: teaches TypeScript that `req.user` exists, so
 * controllers get a typed active organization instead of a cast.
 *
 * Two things here are easy to get wrong:
 *
 * 1. The `import` above makes this file a *module*, and a module's top-level
 *    declarations are local to it. Without the `declare global` wrapper the
 *    augmentation would be invisible and `req.user` would still error.
 * 2. The specifier ends in `.js` even though the source is `.ts` — NodeNext
 *    resolution applies to `.d.ts` files too.
 *
 * `user` is optional because it is genuinely absent on unauthenticated routes
 * (`/health`, `/auth/login`). Use `requireUser(req)` from utils/requireUser.ts
 * rather than a `!` assertion — see the note there.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /**
       * Phase 38c — the caller's current membership and permissions, resolved
       * once per request by `requirePermission` and reused by later handlers.
       */
      access?: MemberAccess;
    }
  }
}
