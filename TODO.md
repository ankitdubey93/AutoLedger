## Known Issues / In-Progress Re-Engineering

The following improvements are planned and should be implemented in this order:

1. **[Phase 1] Auth middleware uses wrong secret** — `middleware/auth.ts` currently reads `JWT_SECRET` but should read `ACCESS_TOKEN_SECRET`. Also remove the `console.log(decoded)` that leaks token data.

2. **[Phase 2] Double-entry hardening** — Replace `Math.abs(...) > 0.01` float check with integer cents arithmetic. Add mutual exclusion validation (debit AND credit > 0 rejected). Fix `ruleEngine.ts` deduplication filter that silently drops lines causing imbalance.

3. **[Phase 3] Service layer** — Extract all SQL from controllers into `src/services/`. Controllers must become thin HTTP adapters. This is a prerequisite for unit testing.

4. **[Phase 4] API scalability** — Add `?page&limit` pagination to `GET /api/v1/journals`. Prefix all routes with `/api/v1/`. Remove unused `mongoose` dependency.

5. **[Phase 5] Unit tests** — Install Vitest, write 5 test files covering double-entry logic, rule engine, services, and auth middleware.

6. **[Phase 6] Cleanup** — Environment-aware `secure` cookie flag, consolidate migration directories (delete old `src/migrations/`, keep `src/db/migrations/`), extract `AuthenticatedRequest` to `types/express.d.ts`, fix `pool.query` inside client transaction in `authController.ts`.

7. **[Phase 7] Docker** — Add `server/Dockerfile`, `client/Dockerfile`, `server/entrypoint.sh`, `.dockerignore` files. Replace `docker-compose.dev.yml` with unified `docker-compose.yml`.

---