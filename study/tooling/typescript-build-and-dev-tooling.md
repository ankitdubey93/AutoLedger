# TypeScript Build & Dev Tooling (tsx, tsc, Vite)

> Nothing that runs our TypeScript ever type-checks it. Transpiling and type-checking are separate tools with separate speeds, and knowing which does which is the difference between "it runs" and "it's correct."

**Category:** Tooling
**Introduced by:** Phase 0 — `server/tsconfig.json`, `tsconfig.build.json`, `client/vite.config.ts`
**Verified against:** TypeScript 7.0.2, tsx 4.23.1 (esbuild 0.28.1), Vite 8.2.0 (Rolldown), Node 24.4.1, Vitest 4.1.10

---

## Mechanism

### The central fact: types are erased, so transpiling needs no type information

TypeScript compiles to JavaScript by **deleting** the types. `const x: number = 1` becomes `const x = 1`. No annotation survives, and none has a runtime representation.

That has a consequence people underrate: **stripping types requires only parsing one file.** You do not need to resolve imports, load `.d.ts` files, or build a type graph to know that `: number` should be deleted. So a transpiler can process files independently and in parallel, in any order, and never read a second file.

Type *checking* is the opposite. To know whether `x` may be assigned to `y`, the checker must resolve every import transitively, build the full program, and reason across the entire graph. It is inherently whole-program and inherently slower.

Two jobs, two orders of magnitude in cost. Every tool below is a consequence of separating them:

| Tool | Job | Reads | Speed on this project |
|---|---|---|---|
| `tsx` (esbuild, Go) | strip types, run | one file at a time | instant restarts |
| `tsc` (TypeScript 7, Go) | type-check whole program | everything | 0.84s |
| Vite dev (esbuild) | transform on request | one module | ~250ms cold start |
| Vite build (Rolldown, Rust) | bundle + minify | everything | 216ms, 17 modules |

The exceptions to pure erasure are the TypeScript features that emit *code* rather than deleting it: `enum`, `namespace`, parameter properties (`constructor(private x: number)`), and legacy decorators. `const enum` is worse — it inlines values across file boundaries, which a single-file transpiler cannot do. This is exactly what `isolatedModules: true` enforces: it makes the compiler reject anything that cannot be correctly transpiled one file at a time. We set it on both sides, because both are transpiled by esbuild.

### `tsx` — and why it cannot fail on a type error

`tsx` registers a Node module loader hook that intercepts `.ts` imports and hands the source to **esbuild**, which strips types and returns JavaScript. esbuild is written in Go, parallelises across cores, and never builds a type graph — which is why it is fast, and also why it is structurally incapable of reporting a type error. It does not know the types. It threw them away.

**So `npm run dev` will happily run code that does not compile.** That is not a bug, it is the trade. Type-checking is a separate command:

```bash
npm run typecheck    # tsc --noEmit
```

If you take one thing from this note: in a modern TS setup, **type errors surface in your editor and in CI, not in your dev server.** A project without a `typecheck` script wired into CI is one where type errors reach production.

### TypeScript 7 is a Go binary, not a JavaScript program

Verified on this machine — `node_modules/@typescript/typescript-linux-x64/lib/tsc` reports:

```
ELF 64-bit LSB executable, x86-64, statically linked, Go BuildID=...
```

The `typescript` package is now a thin shim (`getExePath.js`) that resolves a platform-specific native binary from an optional dependency. TypeScript 7 is the Go port of the compiler, replacing the self-hosted JavaScript implementation that TypeScript had been since it was written. The type system and `tsconfig` semantics are the same; the implementation is native, parallel, and roughly an order of magnitude faster on large codebases.

Practical consequence: `tsc` is no longer slow enough to need avoiding. The old reflex of "don't run the checker in the watch loop, it's too slow" is dated advice.

### Why the server writes `.js` in its imports

```ts
import { createApp } from './app.js';   // the file on disk is app.ts
```

This looks wrong and is correct. The rule underneath: **TypeScript never rewrites module specifiers.** Whatever string you write is the string that appears in the emitted JavaScript. It is a type-checker with erasure, not a bundler.

So the specifier must be valid *for whatever will resolve it at runtime*. With `module: NodeNext`, the resolver is Node's native ESM resolver, and it does **not** do extension guessing — CommonJS `require` tried `.js`, `.json`, `/index.js`, but ESM `import` requires the exact path. Node needs `./app.js`. Hence you write `./app.js` in the `.ts` file, and TypeScript is smart enough to look for `app.ts` when checking while emitting `./app.js` untouched.

The client does the opposite: `moduleResolution: "bundler"`, no extensions, because Vite resolves specifiers and its rules are not Node's. Two projects, two resolution modes, because they have two different runtimes — Node in one case, a bundler in the other.

### `verbatimModuleSyntax`

Historically TypeScript did **import elision**: if every binding from an import was used only in type position, it deleted the entire import statement. That silently breaks a module imported for its side effects, and it makes emit depend on type information — which a single-file transpiler like esbuild does not have, so tsc and esbuild could disagree about the output.

`verbatimModuleSyntax: true` removes the guesswork: an `import` stays, and anything type-only must say so.

```ts
import type { RequestHandler } from 'express';   // erased — you said so
import express from 'express';                    // kept — you said so
```

Emit becomes a mechanical function of the source text, identical across every tool.

### What `strict` does and does not include

`strict: true` is a bundle: `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`.

It does **not** include these, which we enable explicitly:

| Flag | Catches |
|---|---|
| `noUncheckedIndexedAccess` | `arr[0]` typed as `T` when the array may be empty — adds `| undefined` |
| `exactOptionalPropertyTypes` | assigning explicit `undefined` to `foo?: string`; "absent" and "present but undefined" become different |
| `noImplicitReturns` | a function where one branch returns a value and another falls off the end |
| `noFallthroughCasesInSwitch` | a missing `break` |
| `noUnusedLocals` / `noUnusedParameters` | dead bindings |

`noUncheckedIndexedAccess` is the one that matters most here. `SORT_COLUMNS[req.query.sort]` returning `string` rather than `string | undefined` is how an unwhitelisted value reaches a SQL identifier — see [guardrails.md](../../docs/guardrails.md) rule 5.

`noUnusedParameters` has a deliberate escape hatch: parameters prefixed with `_` are exempt. That is what lets our error middleware declare `(err, _req, res, _next)` — Express detects error handlers by **arity**, so the fourth parameter must exist even though nothing uses it, and the underscore keeps the compiler quiet without disabling the check.

### Two tsconfigs, because checking and emitting want different inputs

- `tsconfig.json` — `noEmit: true`, includes `src` **and** `vitest.config.ts`. Editors and `npm run typecheck` use it.
- `tsconfig.build.json` — extends it, sets `rootDir: src` / `outDir: dist`, excludes `__tests__`.

The forcing issue is `rootDir`. Emitting requires one, and `vitest.config.ts` sits outside `src`, so a single config either refuses to emit or leaves the tool config untyped. Splitting gives the editor everything and the build only what ships.

### Vite: two completely different pipelines

**Dev — no bundling.** Vite serves native ES modules and lets the browser do the graph walking. It transforms each module on demand, only when the browser requests it, which is why cold start is ~250 ms regardless of project size. Verified by fetching from the running dev server:

```
GET /src/App.tsx  →  import { getHealth } from "/src/services/fetchServices.ts";
                     import __vite__cjsImport0_react from "/node_modules/.vite/deps/react.js?v=d5824a00";
```

Two things are visible there. `.tsx` was transpiled to JS but the **URL keeps its original extension** — Vite maps URL to source file, not to an output artifact. And `react` was rewritten to a **pre-bundled** dependency.

**Dependency pre-bundling** exists for two reasons. React ships CommonJS, which browsers cannot `import`; esbuild converts it to ESM once and caches it in `node_modules/.vite/deps`. And a package like lodash-es is 600 files — unbundled, that is 600 HTTP requests in a waterfall. Pre-bundling collapses each dependency to one. The `?v=d5824a00` is a cache-busting hash: dependencies are served with long-lived immutable caching, and the hash changes when your lockfile does.

**HMR** is the payoff of unbundled dev. When a file changes, Vite invalidates that module and pushes it over a WebSocket. React Fast Refresh (visible as `injectIntoGlobalHook` and `createHotContext` in the served output) re-runs the component while preserving its state.

**Build — fully bundled, by Rolldown.** Vite 8 bundles with **Rolldown**, a Rust rewrite of Rollup, shipped as a native binding (`@rolldown/binding-linux-x64-gnu`). Earlier Vite used Rollup, written in JavaScript; the migration is the same "rewrite the hot path in a systems language" move as TypeScript 7's Go port. Our build: 17 modules, 216 ms, `193 kB → 61 kB gzipped`.

Why bundle for production when dev doesn't? Tree-shaking, minification, code splitting, and — most importantly — content-hashed filenames (`index-CMVdjsqi.js`) that permit permanent caching with correct invalidation. The unbundled request waterfall that is free on localhost is not free over the network.

### `import.meta.env` is compile-time substitution

Vite replaces `import.meta.env.VITE_API_BASE_URL` with a **string literal at build time**. There is no runtime lookup; the value is baked into the shipped JavaScript. Two consequences: only `VITE_`-prefixed variables are exposed (so a stray `DATABASE_URL` in `.env` cannot leak), and **nothing in a client `.env` is secret** — it is in the bundle, readable by anyone. It also means changing `.env` requires restarting the dev server, because the substitution already happened.

## Why we chose it here

| Decision | Alternative | Why |
|---|---|---|
| `tsx` for dev | `ts-node` | `ts-node` type-checks on every run — slow, and duplicates what the editor already does. `swc`/`tsx` won this argument broadly |
| `tsx watch` | `nodemon` + a compile step | One process, no `dist/` in the loop. `nodemon` predates native TS execution and adds a moving part |
| Separate `typecheck` script | Type-check in the dev loop | Keeps restarts instant; the editor gives immediate feedback and CI is the real gate |
| `tsc` for the production build | Bundle the server with esbuild | Server code isn't shipped over a network — bundling buys nothing, and plain output keeps stack traces readable |
| Vite | Webpack, CRA | CRA is unmaintained; Webpack's dev cold start scales with project size, Vite's doesn't |
| `NodeNext` on the server | `bundler` resolution | The server is run by Node, not a bundler. Resolution mode must match the actual runtime |
| No client bundler config | Ejecting/customising | Vite's defaults are correct; a config you don't need is a config that rots |

The through-line: **match the tool to the runtime, and never make the fast loop do the slow job.**

## Where it lives in this codebase

- `server/tsconfig.json` — checking config, all strict flags, `NodeNext`
- `server/tsconfig.build.json` — emit config, `rootDir`/`outDir`, excludes tests
- `server/package.json` — `dev` (tsx watch), `typecheck`, `build`, `start`
- `server/vitest.config.ts` — `globals: true`, coverage scoped to `services/` and `utils/`
- `server/src/middleware/errorHandler.ts` — the `_next` underscore exemption keeping arity 4
- `client/tsconfig.json` — `bundler` resolution, `jsx: react-jsx`, `types: ["vite/client"]`
- `client/vite.config.ts` — React plugin, `strictPort`
- `client/src/vite-env.d.ts` — types `import.meta.env` so a missing variable is a compile error

## Gotchas

- **`npm run dev` does not type-check.** The highest-value thing to know here. Broken types run fine until CI or production. Run `npm run typecheck`.
- **Forgetting `.js` on a server-side relative import** type-checks clean and then throws `ERR_MODULE_NOT_FOUND` at runtime — because tsc validated against `app.ts` while Node was handed `./app` and refused to guess.
- **Copying an import style between `server/` and `client/`** breaks in one direction: extensions are mandatory under `NodeNext`, wrong under `bundler`.
- **`const enum` is banned by `isolatedModules`** — it requires cross-file inlining that a per-file transpiler cannot do.
- **Client `.env` values are public.** Inlined into the bundle at build time. Never a secret, ever.
- **Editing `.env` mid-session does nothing** until the dev server restarts; the substitution is already baked in.
- **`skipLibCheck: true` skips type-checking `.d.ts` files.** We set it, as almost everyone does, because one badly-typed transitive dependency shouldn't fail your build. The honest cost: a genuine error inside a dependency's types goes unnoticed.
- **`strictPort: true` on Vite** is deliberate. Without it Vite drifts to 5174 when 5173 is taken, and the server's CORS origin no longer matches — producing a CORS error that looks like a server bug.
- **Deleting `node_modules/.vite`** is the fix when dependency pre-bundling goes stale after a dependency change.

## Interview Q&A

**Q: Why is esbuild/tsx so much faster than `tsc`, and what do you give up?**
A: They're not doing the same job. Stripping types requires parsing a single file — no imports resolved, no type graph. Type-checking is whole-program: to know if an assignment is legal the checker must resolve every import transitively. So a transpiler parallelises trivially across files and a checker can't. What you give up is that the transpiler cannot report a single type error, because it never computed the types. That's why `tsx` for dev and `tsc --noEmit` in CI is the standard pairing — and why a project without a typecheck script is one where type errors reach production.

**Q: Why do your server imports say `./app.js` when the file is `app.ts`?**
A: Because TypeScript never rewrites module specifiers — the string you write is the string that's emitted. It's a checker with erasure, not a bundler. Under `module: NodeNext`, the thing resolving that string at runtime is Node's ESM resolver, which requires exact paths and does no extension guessing the way CommonJS `require` did. So the specifier must be what *Node* needs, `./app.js`, and TypeScript is built to look up `app.ts` when checking it. The client uses `moduleResolution: bundler` and omits extensions, because there the resolver is Vite.

**Q: What does `strict: true` not give you?**
A: `strict` bundles `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables` and `alwaysStrict`. It does *not* include `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, or the unused-code flags. The important one for us is `noUncheckedIndexedAccess`: without it `record[key]` is typed as present even when the key is arbitrary. That's exactly the shape of our SQL sort-column whitelist, where an unchecked lookup returning `undefined` instead of a safe column name is how an identifier reaches a query string.

**Q: Why doesn't Vite bundle in development but does in production?**
A: In dev it serves native ES modules and transforms each one on demand, so cold start is independent of project size — you're not paying to build the whole graph to see one page. That's free on localhost, where an extra request costs nothing. In production it isn't: hundreds of unbundled modules become a request waterfall over real latency, and you also want tree-shaking, minification, code splitting and content-hashed filenames for cache invalidation. The one thing it must pre-bundle even in dev is dependencies — React ships CommonJS, which browsers can't import, and a package like lodash-es is 600 files that would be 600 requests.

**Q: Someone puts an API key in `client/.env` as `VITE_API_KEY`. What do you tell them?**
A: It's public. Vite substitutes `import.meta.env.VITE_*` with string literals at build time, so the key is a literal in the shipped JavaScript that anyone can read with view-source. The `VITE_` prefix is not a security boundary — it's the opposite, a marker for "safe to publish," which is why non-prefixed variables are excluded. Anything secret has to live server-side, with the browser calling an endpoint that uses it. Same reasoning as our `server/.env`, which the browser never sees.

**Q: You have `strict` on and one file is fighting you. What do you do?**
A: Not `any`, and not `@ts-ignore`, which suppresses whatever error appears there next year too. Usually the type is telling the truth and the code has an unhandled case — `noUncheckedIndexedAccess` complaining about `arr[0]` means the array really can be empty. If I genuinely know more than the checker, `@ts-expect-error` with a comment, because it *fails* once the underlying issue is fixed, so it can't rot silently. If the real problem is a badly-typed dependency, the fix is a local `.d.ts`, not weakening the config for the whole project.

**Q: Tell me about a tooling decision you made and what it cost.**
A: Two tsconfigs on the server, which looks like over-engineering. The forcing issue was `rootDir`: emitting needs one, and `vitest.config.ts` lives outside `src`, so a single config either refuses to emit or leaves the test config untyped in the editor. Splitting gives `tsconfig.json` everything with `noEmit`, and `tsconfig.build.json` only `src` with real output. The cost is a second file to keep in sync — mitigated by `extends`, so only the four differing options are duplicated. The general shape recurs: the editor wants a superset of what the build wants, and pretending they're the same config means one of them is wrong.

## Follow-ups they'll dig into

- "How do you stop type errors reaching main?" — `npm run typecheck` in CI, and a pre-push hook if the team wants it locally. The editor is feedback, not a gate.
- "`skipLibCheck: true` — what does it hide?" — real errors inside dependency `.d.ts` files. Nearly everyone accepts that trade rather than have one bad transitive dependency break their build.
- "Would you bundle the server too?" — only for cold-start-sensitive serverless deployments. For a long-running container it buys nothing and costs stack-trace readability.
- "Your dev and prod builds use different pipelines — isn't that a risk?" — yes, and it's real: dev is per-module esbuild, prod is a Rolldown bundle, and tree-shaking or dependency-interop bugs can appear only in prod. The mitigation is that CI builds the production bundle on every PR, so "works in dev" is never the last signal.
- "What changes with TypeScript 7's Go compiler?" — the type system and config semantics don't; the implementation is native and parallel, roughly an order of magnitude faster on large projects. Mostly it invalidates the old reflex that the checker is too slow to run often.

## See also

- [../typescript/typescript-foundations.md](../typescript/typescript-foundations.md) — the compiler pipeline, erasure, and what `strict` buys
- [../node-express/nodejs-foundations.md](../node-express/nodejs-foundations.md) — CJS vs ESM, and why resolution differs
- [../react/react-foundations.md](../react/react-foundations.md) — what Fast Refresh preserves across an HMR update
