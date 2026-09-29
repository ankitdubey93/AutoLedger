# Docker Images and CI: Multi-Stage Builds, Layer Caching, and a Pipeline With a Real Database

> A production image is not "the dev environment in a box". It is the smallest runnable artefact the build can produce — and a CI pipeline is where the test suite, not the container, finally earns the right to block a release.

**Category:** Tooling
**Introduced by:** Pre-showcase polish, 2026-09-29 — `server/Dockerfile`, `client/Dockerfile`, the `app` profile in `docker-compose.yml`, `.github/workflows/ci.yml`, and `oxlint` as the linter.
**Verified against:** Docker Engine with BuildKit (the `# syntax=docker/dockerfile:1` frontend), `node:22-bookworm-slim`, `nginx:1.27-alpine`, Docker Compose v2, GitHub Actions `actions/checkout@v7` / `actions/setup-node@v7`, oxlint 1.86.0, TypeScript 7.0.2. Image sizes below were measured on this machine.

---

## Mechanism

**An image is a stack of read-only layers.** Most Dockerfile instructions (`RUN`, `COPY`, `ADD`) produce one layer: a tarball of the files that instruction added, changed or deleted, relative to the layer below. At runtime an overlay filesystem (overlay2 on Linux) presents the stack as one directory tree and adds a thin writable layer on top.

**Layers are cached by content, so order is a performance decision.** BuildKit reuses a layer when its instruction and inputs are unchanged. For `COPY`, the inputs are the checksums of the files copied. That is why both Dockerfiles copy `package.json` and `package-lock.json`, run `npm ci`, and only *then* copy the source. A source-only change invalidates the `COPY src` layer and everything after it, but the dependency layer — the slow one — is reused. Copy the whole directory first and every one-line edit reinstalls every package.

**A multi-stage build throws away everything but the last stage.** Each `FROM` starts a fresh stage. The server's `build` stage installs *all* dependencies (TypeScript included), runs `npm run build`, and produces `dist/`. The `runtime` stage starts again from a clean `node:22-bookworm-slim`, runs `npm ci --omit=dev`, and takes only `dist/` from the build stage with `COPY --from=build`. The compiler, `tsx`, Vitest and every source file never reach the shipped image — they existed only in a stage nobody keeps. The client does the same thing across two different base images: a Node stage runs `vite build`, and an `nginx` stage serves the static output. No Node runtime ships at all.

**Metadata changes copy whole files — the `chown -R` trap.** In overlay filesystems, changing *anything* about a file that lives in a lower layer — its contents, its owner, its mode — triggers a "copy-up": the whole file is copied into the current layer and modified there. The first server image ended with `RUN mkdir -p storage .tesseract && chown -R node:node /app`. That re-owned all ~250 MB of `node_modules` the previous `npm ci` layer had written, so the image carried two full copies of it: **1.04 GB**. The process only ever *writes* to `storage/` and `.tesseract/`, so only those two directories need to belong to `node`. Re-owning just them brought the image to **685 MB**, with nothing else changed. The rule: own what you write, and if you do need ownership over copied files, set it in the copying instruction (`COPY --chown=node:node …`), so the file is written once with the right owner.

**`npm ci` is the reproducible install.** It installs exactly what `package-lock.json` pins, fails if the lockfile and `package.json` disagree, and deletes any existing `node_modules` first. `npm install` may update the lockfile. A build should never do that.

**Build-time vs runtime configuration.** The server reads `process.env` when it starts, so one image serves every environment and compose passes the environment in. The client cannot work that way. Vite replaces `import.meta.env.VITE_*` with literal strings *during the build*, so the API URL and the optional demo credentials are Docker `ARG`s, and changing them means rebuilding the image. That is also why a `VITE_` variable must never hold a secret: it ends up in JavaScript every visitor downloads. BuildKit's `SecretsUsedInArgOrEnv` check flags `VITE_DEMO_PASSWORD`. It is suppressed with `# check=skip=…`, with a comment explaining it's a public demo password.

**Serving an SPA from nginx needs a fallback and two cache rules.** `try_files $uri /index.html` makes a deep link like `/invoices/abc` load the app shell and let React Router resolve it; without it, nginx returns 404. Vite's hashed files under `/assets/` never change under the same name, so they get `max-age=31536000, immutable`. `index.html` gets `no-cache`, because a cached shell would keep pointing browsers at asset names the next deploy deleted.

**Compose orders startup by *condition*, not just by order.** `depends_on` with `condition: service_healthy` waits for the dependency's healthcheck to pass. `condition: service_completed_successfully` waits for a one-shot container to exit `0`, which is how `server` and `worker` wait for `migrate`, so the API never serves traffic against a half-migrated schema. **Profiles** keep the app out of the default set: `docker compose up` still starts only the databases (which `./dev.sh` relies on), and `--profile app` adds the four app services. The shared server environment is written once as a YAML anchor (`&server-environment`) and reused with the merge key `<<: *server-environment`.

**CI service containers are sibling containers on the runner.** In `.github/workflows/ci.yml`, the server job declares `postgres` and `redis` under `services:`. The runner starts them before the steps, maps their ports to the host (`5433:5432`, matching the port the suite expects), and waits for their `--health-cmd` to pass. The steps run on the runner itself and reach them at `localhost`. The suite's own `globalSetup` then creates its databases and applies every migration, so the workflow prepares nothing by hand. The pipeline has three jobs: client (typecheck, lint, test, build); server (typecheck, lint, test against real Postgres and Redis); and images (build both Dockerfiles). The last catches a Dockerfile that no longer builds, which nothing else would notice until deploy day.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| One single-stage image with dev dependencies | Simplest Dockerfile; ships TypeScript, test tooling and source | Rejected — larger image and attack surface for no runtime benefit |
| Multi-stage, one server image, three commands (API / worker / migrate) | Three services, one build; they cannot drift, because they are the same compiled code | **Chosen** |
| Run migrations in the API's entrypoint | Fewer services; but every replica races to migrate on start | Rejected — a one-shot `migrate` service that the API waits on |
| Containerise development too (source mounts, hot reload) | "Works on my machine" solved; slower watch, awkward debugging — the previous build did this | Rejected for dev (see `docs/development.md § Why not full Docker`); images are for running, not editing |
| Serve the client from Express | One container fewer; couples static hosting to API deploys and gives Node work nginx does better | Rejected — nginx stage, 75 MB image |
| ESLint + typescript-eslint | The ecosystem default | **Rejected on a hard constraint** — see Gotchas |
| oxlint | Own parser, one package, honours existing `eslint-disable` comments | **Chosen** |

## Where it lives in this codebase

- `server/Dockerfile` — build stage → runtime stage; `USER node`; only `storage/` and `.tesseract/` re-owned.
- `client/Dockerfile`, `client/nginx.conf` — Vite build with `VITE_*` build arguments; nginx SPA fallback and cache headers.
- `server/.dockerignore`, `client/.dockerignore` — keep `node_modules`, `dist`, `.env*` and local storage out of the build context (a copied host `node_modules` would carry native binaries built for the wrong platform).
- `docker-compose.yml` — the `app` profile: `migrate`, `server`, `worker`, `client`.
- `.github/workflows/ci.yml` — three jobs; the server job's `services:` block.
- `server/.oxlintrc.json`, `client/.oxlintrc.json` — correctness rules, each disabled rule with its reason beside it.

## Gotchas

- **`chown -R` over copied files doubles them.** Measured here: 1.04 GB → 685 MB by re-owning two directories instead of `/app`. It showed up as a size that didn't add up (about 250 MB of `node_modules` in a 1 GB image); `docker history <image>` lists each layer's size and confirmed the fix (the `chown` layer went to 16 kB).
- **A test-config pin can silently stop pinning.** Writing the CI environment meant reading `vitest.config.ts` closely. That showed it pinned `AP_FLOW_AI_PROVIDER`, a variable Phase 33 had renamed to `CAPTURE_AI_PROVIDER`. The pin had become a no-op, so a developer's `CAPTURE_AI_PROVIDER=gemini` was leaking into the suite. CI would never have shown this, because CI has no `.env`. It was a local-only divergence of exactly the kind the pin existed to prevent.
- **A test at 97% of its timeout is a failure waiting for a busy machine.** A Drive-intake test ran real OCR (a cold tesseract worker loading its language data) and took about 5.1 s against a 5 s limit. It passed alone on a good run and failed under parallel load, and it would have failed intermittently on shared CI runners. The fix was not a longer timeout: the test is about metering, so it now injects a stub OCR, as the other capture tests do (5,180 ms → 259 ms).
- **ESLint could not parse this codebase's TypeScript.** `typescript-eslint` parses through TypeScript's JavaScript API. TypeScript 7 is the native (Go) compiler and does not ship that API: `require('typescript').createSourceFile` is `undefined`, and `typescript-eslint`'s peer range stops at `<6.1.0`. The only way to keep ESLint would have been a second, older TypeScript installed beside the real one, which means two compilers that can disagree. `tsc` still owns type errors; the linter only has to catch what types can't.
- **Service containers can't take custom server flags.** The local test cluster runs Postgres with `fsync=off` for speed. As far as I found, GitHub's `services:` schema offers `image`, `env`, `ports`, `volumes`, `credentials` and `options` (extra `docker create` flags), but no way to override the container's command. So CI's Postgres runs with default durability: slower, not different. *(Stated from the documented service schema, not tested exhaustively — verify before repeating it as absolute.)*
- **Secure cookies over plain HTTP.** In the containers `NODE_ENV=production`, so session cookies are `Secure`. Chrome and Firefox treat `http://localhost` as a secure context and accept them. A real deployment over plain HTTP on any other hostname would silently drop them. TLS is a prerequisite, not an option.

## Interview Q&A

**Q: What is a multi-stage Docker build, and why use one for a TypeScript service?**
A: Each `FROM` in a Dockerfile starts a new stage, and only the final stage becomes the image. For a TypeScript service, the build stage needs the compiler, dev dependencies and source; the running service needs none of them, only compiled JavaScript and production dependencies. So my build stage runs `npm ci` and `tsc`, and the runtime stage starts from a clean base, runs `npm ci --omit=dev`, and copies only `dist/` across with `COPY --from=build`. The shipped image has no compiler, no test runner and no source. It's smaller, has less to patch, and can't accidentally run the TypeScript in development mode.

**Q: How do you make Docker builds fast when only source code changes?**
A: Order the Dockerfile so the slow, rarely-changing steps come first. The build cache keys a `COPY` layer on the checksums of the files it copies, so I copy only `package.json` and the lockfile, run `npm ci`, and then copy the source. A code change invalidates only the layers from `COPY src` onward, and the dependency install is reused from cache. A `.dockerignore` matters for the same reason: if a local `node_modules` or build output were part of the context, the cache would miss on files that don't affect the build.

**Q: Tell me about an image-size problem you actually hit.**
A: My first server image was 1.04 GB, which is a lot for a Node API. `node_modules` inside it measured about 250 MB, so the numbers didn't add up. The suspect was the last `RUN`, a `chown -R node:node /app`, so the unprivileged user could write uploads. Overlay filesystems copy a whole file up into the new layer whenever you change anything about it, ownership included. So that command re-wrote all of `node_modules` into a second layer. The app only writes to two directories, so I made just those two owned by `node`, and the image dropped to 685 MB with nothing else changed. `docker history` on the fixed image confirmed it: the `chown` layer is now 16 kB. The general rule: give the runtime user only what it writes, and set ownership at copy time with `COPY --chown` when you need it.

**Q: How do you run database migrations when the app is containerised?**
A: As their own one-shot container, from the same image as the API with a different command. In compose, the API and the worker `depends_on` the migrate service with `condition: service_completed_successfully`, so neither starts until migrations have exited cleanly. I avoided migrating in the API's entrypoint because with more than one replica they'd all race to migrate on startup. It also ties a schema change to whichever instance happens to boot first. One image with three commands (API, worker, migrate) also guarantees the three can never be built from different code.

**Q: What does your CI pipeline actually prove?**
A: Three independent jobs. The client job type-checks, lints, runs the component tests and does a production build, which catches a bundle that only fails at build time. The server job type-checks, lints and runs the full integration suite against real Postgres and Redis, started as service containers on the runner. That matters here because the core guarantees live in the database: the double-entry balance trigger, the immutability triggers, the tenant isolation tests. A mocked database would prove none of them. The third job builds both Docker images, so a broken Dockerfile shows up on the pull request instead of on deploy day.

**Q: Why oxlint rather than ESLint?**
A: Not preference: ESLint couldn't lint this code. The project is on TypeScript 7, the native compiler, which doesn't ship the JavaScript API that `typescript-eslint` parses through, and `typescript-eslint` only supports TypeScript below 6.1. The workaround would have been installing a second, older TypeScript just for the linter, and then the linter and the compiler could disagree about the same file. oxlint has its own parser, is a single package, and honours the `eslint-disable` comments already in the code. Type errors remain `tsc`'s job; the lint config is correctness rules only, with each disabled rule explained next to where it's turned off.

## Follow-ups they'll dig into

- "How would you deploy this for real?" — Push the two images to a registry from CI on `main`, run them behind a TLS-terminating proxy (the cookies are `Secure` in production), turn on `trust proxy` in Express so audit rows record the client IP rather than the proxy's, and move the Document Vault's filesystem storage to object storage (its `put`/`get`/`stat` interface was kept narrow for exactly that swap).
- "Why is the image still 685 MB?" — The base Debian slim image and native dependencies: `sharp`'s libvips, the tesseract WASM core, `pdfjs-dist` and its canvas bindings. Alpine would be smaller but uses musl, and prebuilt native modules for glibc may not load there or may need rebuilding. That's a trade to measure, not assume.
- "What stops a flaky test from being ignored in CI?" — Nothing automatic, which is why the timing fix above mattered. A test that fails intermittently teaches people to re-run the pipeline until it's green, and then a real failure gets re-run away too.

## See also

- [typescript-build-and-dev-tooling.md](typescript-build-and-dev-tooling.md) — `tsc` vs `tsx`, and the build that the server image's first stage runs.
- [testing-with-vitest.md](testing-with-vitest.md) — the real-database integration tier the CI server job runs.
- [../architecture/deterministic-demo-fixtures.md](../architecture/deterministic-demo-fixtures.md) — the demo seeder, the other thing a deployed demo needs.
