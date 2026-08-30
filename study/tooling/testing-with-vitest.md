# Testing with Vitest (and Why Not Jest)

> Jest and Vitest look almost identical at the API surface. The difference is underneath: Jest ships its own module system and transform pipeline, Vitest borrows the one your app already builds with — and on an ESM+TypeScript project that decides everything.

**Category:** Tooling
**Introduced by:** Phase 0 — `server/vitest.config.ts`, `src/__tests__/`
**Verified against:** Vitest 4.1.10, Jest 30.4.2, Node 24.4.1, TypeScript 7.0.2, Express 5.2.1. Every claim below was run, not recalled — including the Jest failures.

---

## Part 1 — Why Vitest

### What a test runner actually does

Four jobs, and only the second is interesting:

1. **Find** test files by glob.
2. **Transform** them — our tests are TypeScript ESM; Node cannot execute that directly.
3. **Execute** them in an isolated environment, injecting `describe` / `it` / `expect` and tracking which assertions ran.
4. **Report** results and exit non-zero on failure.

Step 2 is the whole story. A test runner has to compile your code, which means it needs to know your TypeScript config, your path aliases, your plugins, your env handling — **everything your build tool already knows.**

Jest solves this by owning the pipeline: `babel-jest` or `ts-jest` transforms, `moduleNameMapper` resolves. That was the right design in 2016, when Jest was often the only build tool a project had. Today it means you maintain **two parallel configurations**: your real one, and Jest's imitation of it. They drift. The classic symptom is a path alias that works in `npm run dev` and fails only in tests.

Vitest inherits `vite` as a direct dependency and reuses Vite's transform pipeline. `vitest.config.ts` and `vite.config.ts` are the same config format, and can literally be the same file. Aliases, plugins and env resolution are configured once. There is no imitation to drift.

### The ESM problem, demonstrated

Our server is `"type": "module"` with `moduleResolution: NodeNext`. That is precisely where Jest hurts. I ran Jest 30.4.2 against a minimal ESM package:

**Without the flag** — a test file that does `import { jest } from '@jest/globals'`:

```
SyntaxError: Cannot use import statement outside a module
    at ModuleExecutor.compile (node_modules/jest-runtime/build/index.js:2104:44)
Test Suites: 1 failed, 1 total
```

**With `NODE_OPTIONS=--experimental-vm-modules`:**

```
(node:95613) ExperimentalWarning: VM Modules is an experimental feature and might change at any time
Test Suites: 1 passed, 1 total
```

It works — behind a flag Node still labels experimental, in Jest 30, in 2026.

The reason is architectural rather than neglect. **Jest's module mocking works by controlling `require`.** Jest replaces the module registry, so `jest.mock('./db')` can intercept the lookup and hand back a fake. CommonJS makes that easy because `require` is a function call resolved at runtime.

ESM `import` is not a function call. Bindings are statically resolved and linked by the runtime before execution, and they are *live bindings*, not values. There is no `require` to intercept. Jest's workaround is `--experimental-vm-modules` plus a separate API with a warning label in its name:

```js
// Jest, ESM. Note: unstable_, and the subject MUST be imported dynamically after.
jest.unstable_mockModule('./dep.js', () => ({ value: () => 'mocked' }));
const { run } = await import('./subject.js');
```

A static `import { run } from './subject.js'` at the top would be hoisted above the mock call and get the real module. Verified — the dynamic import is mandatory.

Vitest sits on Vite, which already rewrites the module graph during transform. So it can replace a module's bindings at transform time, and `vi.mock` is hoisted **above the static imports**. Verified in this repo:

```ts
import { checkDatabase } from '../services/healthService.js';  // static, at the top

vi.mock('../db/connect.js', () => ({                            // still wins
  pool: { query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) },
  closePool: vi.fn(),
}));
// → checkDatabase() sees the mocked pool. Test passes.
```

You write normal imports. That is not a small ergonomic win; it is the difference between tests that read like code and tests that read like a workaround.

### Isolation: forks, not threads

Verified by printing `isMainThread` inside a test: it is `true`, and `VITEST_POOL_ID=1` — so each test file runs in a **forked child process**, not a worker thread. Vitest's default pool has been `forks` since v2.

The trade:

| Pool | Isolation | Speed | Risk |
|---|---|---|---|
| `forks` (default) | Separate process: own module registry, own globals, own memory | Slower to spawn | Safe with native addons |
| `threads` | Shared process, separate `worker_threads` | Faster startup | Native modules (like some `pg` builds) can segfault; global leakage |

Forks became the default because correctness beat speed: a test that mutates a global or a module-level singleton cannot poison a sibling file. That matters here — our `pool` is a module-level singleton, and per-file process isolation means one test file's pool state is invisible to the next.

### Everything else is a wash

Vitest implements Jest's `expect` API (via `@vitest/expect`), so `toEqual`, `toHaveBeenCalledWith`, snapshots and matchers all behave the same. `vi` mirrors `jest`. Migration is mostly `jest.` → `vi.`. **Do not claim Vitest is "faster than Jest" in an interview** as the headline reason — with SWC, Jest is competitive, and the honest answer is architectural fit, not benchmarks.

### When Jest is still right

Be able to say this, or you sound like you've only used one tool:

- An existing large Jest suite — migration cost is real and the payoff is modest
- React Native — the Metro/Jest integration is the supported path
- A CommonJS codebase with no Vite anywhere: Jest is one dependency; Vitest would pull in a bundler you otherwise don't need
- You need `jest-environment-jsdom` behaviours or an ecosystem plugin with no Vitest equivalent

| Option | Trade-off | Verdict |
|---|---|---|
| **Vitest** | Shares the Vite pipeline; native ESM; `vi.mock` works with static imports; one config | **Chosen** |
| Jest | Enormous ecosystem, universally known; ESM behind an experimental flag, second config to maintain | Rejected — our server is ESM+TS, its weakest case |
| `node:test` | Zero dependencies, built in | Rejected — weak mocking, no coverage UI, thinner assertions |
| Mocha + Chai + Sinon | Composable, unopinionated | Rejected — assembling four tools to get what Vitest ships |

---

## Part 2 — How to actually write a test

This is what an interviewer means by "write a test for this function."

### The anatomy

```ts
describe('createJournalEntry', () => {          // the unit under test
  it('rejects an entry whose debits do not equal its credits', () => {
    // Arrange — set up inputs and doubles
    const lines = [
      { accountId: 'a', debitCents: 5000, creditCents: 0 },
      { accountId: 'b', debitCents: 0, creditCents: 4999 },
    ];

    // Act — one call, the thing being tested
    const act = () => assertBalanced(lines);

    // Assert — one behaviour
    expect(act).toThrow('Entry is unbalanced');
  });
});
```

**Arrange / Act / Assert.** If a test has two Act steps it is two tests.

**Name the test after the behaviour, not the implementation.** `'rejects an entry whose debits do not equal its credits'` survives a rewrite of the function. `'calls reduce twice'` does not, and tells a reader nothing when it fails. The name is what a failing CI run shows you at 2am — it should state what the system got wrong.

### Testing a pure function — where the value is highest

Pure functions are free to test: no setup, no doubles, no cleanup. Money conversion is the canonical AutoLedger example:

```ts
describe('toCents', () => {
  it.each([
    [1.005, 101],      // the float-rounding trap
    [0.1, 10],
    [19.99, 1999],
    [0, 0],
    [-5.5, -550],
  ])('converts %d to %d cents', (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });
});
```

`it.each` is table-driven testing: one body, many cases, and a failure names the case that broke. Reach for it whenever you would otherwise copy-paste a test and change one literal.

**Pick cases adversarially, not representatively.** Zero, negative, the boundary, the value that breaks in binary floating point, the empty array, the single-element array. `toCents(1.005)` is worth more than five tests of round numbers, because `1.005 * 100 === 100.49999999999999` is exactly where naive implementations fail.

### Testing errors — and the bug that fakes a pass

Synchronous throws need a **function**, not a call:

```ts
expect(() => assertBalanced(bad)).toThrow(ApiError);   // ✅
expect(assertBalanced(bad)).toThrow(ApiError);         // ❌ throws before expect() runs
```

Async rejections need `.rejects` **and an `await`**:

```ts
await expect(service.create(orgId, bad)).rejects.toThrow(ApiError);
await expect(service.create(orgId, bad)).rejects.toThrow('unbalanced');
```

Forgetting the `await` is the single most common false-positive in a JS test suite: `expect(...).rejects.toThrow()` returns a promise, nothing awaits it, the test function returns, and the test **passes whatever happens**. It will pass if the code doesn't throw at all. If you take one practical thing from this note, take that.

Assert on the *type and message*, not just "it threw" — otherwise a typo that throws `TypeError: undefined is not a function` passes a test that claims to verify validation.

### Test doubles, in increasing order of dishonesty

| Double | What it is | Use when |
|---|---|---|
| **Stub** | Returns canned data | You need the collaborator to produce a value |
| **Spy** | Records calls, keeps real behaviour | You care that something was called |
| **Mock** | Replaces the module entirely | The real thing is slow, external, or non-deterministic |
| **Fake** | Working lightweight implementation | In-memory repository |

```ts
const fn = vi.fn((a: number) => a * 2);     // stub with an implementation
fn(3);
expect(fn).toHaveBeenCalledWith(3);
expect(fn).toHaveBeenCalledTimes(1);

const spy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
// ... assert ...
spy.mockRestore();                           // put the real one back
```

`vi.spyOn` + `mockRestore` is safer than `vi.mock` when you only need one method, because it is scoped and reversible.

### Mocking a module, and why it proves less than you think

```ts
vi.mock('../db/connect.js', () => ({
  pool: { query: vi.fn() },
  closePool: vi.fn(),
}));

import { pool } from '../db/connect.js';
import { getAccount } from '../services/accountService.js';

it('scopes the query by org_id', async () => {
  vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: 'acc-1' }] } as never);

  await getAccount('org-1', 'acc-1');

  const [sql, params] = vi.mocked(pool.query).mock.calls[0]!;
  expect(sql).toContain('org_id = $2');
  expect(params).toEqual(['acc-1', 'org-1']);
});
```

That test is worth writing — and you must be honest about its limit. **It proves a string was passed to a function.** It does not prove the SQL is valid, that the column exists, that the `CHECK` constraint fires, or that the index is used. A mocked pool will happily accept `SELCT * FRM acounts`.

This is exactly the failure recorded in [guardrails.md](../../docs/guardrails.md): the prior build mocked the pool in every test, so its migrations, constraints and triggers were **never once executed by a test**. It had a green suite and unverified constraints. That is why [testing.md](../../docs/testing.md) mandates two tiers, and why a cross-tenant isolation test must hit a real database.

Rule of thumb: **mock at the boundary of what you own.** Mock the network, the clock, the filesystem. Do not mock the database and then claim the query is correct.

### Testing an HTTP route

`supertest` binds the app to an ephemeral port and drives real HTTP. Note that `createApp()` returns the app *without* listening — that separation exists so tests never need a fixed port. This is `src/__tests__/app.test.ts`:

```ts
import request from 'supertest';
import { createApp } from '../app.js';

describe('app wiring', () => {
  const app = createApp();

  it('answers a 404 for an unknown route in the documented error shape', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: 'Route not found: GET /api/v1/does-not-exist',
    });
  });
});
```

Assert on **status and body shape**, because that is the contract a client depends on. This test also silently proves the error middleware was registered with four parameters — if it had three, Express would treat it as ordinary middleware, the error would fall through to Express's default handler, and the body would be HTML instead of our JSON.

### Testing against a real database

`src/__tests__/health.test.ts` deliberately does not mock:

```ts
describe('GET /api/v1/health', () => {
  const app = createApp();

  afterAll(async () => {
    await closePool();     // the pool keeps the event loop alive; Vitest hangs without this
  });

  it('reports ok with a live database round trip', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: { connected: true } });
  });
});
```

Two things to carry forward. `toMatchObject` asserts a **subset**, so adding a field to the response doesn't break the test — use it for API responses, and `toEqual` when the exact shape *is* the contract. And every resource opened must be closed in `afterAll`, or the process never exits.

From Phase 1, when there are tables, integration tests need isolation between tests. The two standard approaches: `TRUNCATE ... CASCADE` in `beforeEach` (simple, slower), or wrap each test in a transaction and `ROLLBACK` in `afterEach` (fast, but the code under test then cannot manage its own transactions — which rules it out for us, since our services own `BEGIN`/`COMMIT`).

### Lifecycle hooks

```ts
beforeAll(async () => { /* once per file — open a connection */ });
beforeEach(() => { /* per test — reset state */ });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await closePool(); });
```

`beforeEach` runs outermost-`describe`-first; `afterEach` unwinds inside-out. Anything returning a promise is awaited. Prefer `beforeEach` over `beforeAll` for mutable state — shared mutable state across tests creates order dependence, and an order-dependent suite fails only when someone adds a test.

### Coverage, and what it does not mean

```bash
npm run test:coverage
```

Our config scopes coverage to `services/` and `utils/` — the layers that hold logic. Controllers are thin adapters and routes are declarations; measuring them inflates the number without measuring anything.

Coverage is a **negative signal only**. Low coverage reliably tells you something is untested. High coverage does not tell you the tests are good: a test that calls a function and asserts nothing scores 100% line coverage. `docs/testing.md` targets ≥80% on those two directories, which is a floor, not a goal.

### The framework for "how would you test this?"

Answer in this order and you will sound like someone who has done it:

1. **What is the contract?** Inputs, outputs, thrown errors, side effects.
2. **What are the edge cases?** Zero, negative, empty, boundary, duplicate, concurrent, the float trap.
3. **What are the dependencies, and which do I fake?** Fake the clock, the network, randomness. Not the database, if the claim is about SQL.
4. **What is the failure I most fear?** For us: an unbalanced entry posting, or org A reading org B's data. Test that first — it's the reason the module exists.
5. **What does this test still not prove?** Say it out loud. It is the most senior thing you can say about a test.

## Where it lives in this codebase

- `server/vitest.config.ts` — `globals: true`, `environment: 'node'`, coverage scoped to `services/` and `utils/`
- `server/src/__tests__/app.test.ts` — unit tier: middleware wiring, 404 shape, no `X-Powered-By`
- `server/src/__tests__/health.test.ts` — integration tier: real Postgres, `afterAll` closes the pool
- `server/tsconfig.json` — `types: ["vitest/globals"]`, required for `globals: true` to type-check
- `docs/testing.md` — the two-tier rule and what every module owes

Only 4 tests exist today, because only a health endpoint exists. The examples above involving journals, accounts and `toCents` are **illustrative of Phase 1–2 code that is not built yet** — the patterns are real, that code is not.

## Gotchas

- **A missing `await` on `.rejects` makes a test pass unconditionally.** The highest-frequency false positive in JS testing.
- **`vi.mock` factories and outer variables: it depends on how you import, which is why the rule is "never".** Verified both ways. With a *static* import of the subject, the factory runs during the import phase and referencing an outer `const` fails:

  ```
  Error: [vitest] There was an error when mocking a module. If you are using "vi.mock"
  factory, make sure there are no top level variables inside, since this call is hoisted
  to the top of the file.
  Caused by: ReferenceError: Cannot access 'fakeQuery' before initialization
  ```

  With a *dynamic* `await import()` inside the test, the same code **passes**, because by then the module body has evaluated. So the bug hides until someone converts a dynamic import to a static one. Always use `vi.hoisted()`:

  ```ts
  const mocks = vi.hoisted(() => ({ query: vi.fn() }));
  vi.mock('../db/connect.js', () => ({ pool: { query: mocks.query } }));
  ```

- **`toBe` vs `toEqual`.** `toBe` is `Object.is` — reference identity for objects. `toEqual` is deep structural. `expect({a:1}).toBe({a:1})` always fails.
- **`toEqual` ignores `undefined` properties**; `toStrictEqual` does not, and also checks class identity.
- **Mocks persist across tests in a file** unless cleared. `vi.restoreAllMocks()` in `afterEach`, or `restoreMockssomething` in config. A leaked `mockResolvedValueOnce` produces failures in a *different* test than the one that caused them.
- **Anything that keeps the event loop alive hangs Vitest** — an open pool, a live server, an un-cleared `setInterval`. Vitest bundles `why-is-node-running` for exactly this; run with `--reporter=verbose` when a suite won't exit.
- **`vi.useFakeTimers()` must be paired with `vi.useRealTimers()`**, or every later test in the file inherits frozen time. Fake timers plus real I/O deadlocks: the promise waits on a timer that only advances manually.
- **`globals: true` needs `types: ["vitest/globals"]`** in tsconfig, or `describe` is a type error even though it runs.
- **Integration tests are order-dependent if they share a database.** Vitest runs files in parallel by default — two files writing the same table will flake. Isolate per test, or set `fileParallelism: false` for DB-backed suites.
- **Testing implementation details makes refactoring expensive.** Asserting a private helper was called means a behaviour-preserving rewrite fails the suite. Test through the public surface.

## Interview Q&A

**Q: You used Vitest. Why not Jest?**
A: Mostly ESM. Our server is `"type": "module"` with TypeScript, and Jest's mocking is built around intercepting `require` — it replaces the CommonJS module registry. ESM imports are statically linked live bindings, so there's nothing to intercept, and Jest's support still needs `NODE_OPTIONS=--experimental-vm-modules` and a separate `jest.unstable_mockModule` API. I checked on Jest 30: without the flag the test file dies with "Cannot use import statement outside a module"; with it, it passes but Node still prints an experimental warning. Vitest sits on Vite's transform pipeline, so it rewrites the module graph and `vi.mock` gets hoisted above static imports — normal import syntax just works. The secondary reason is config: with Jest you maintain a second resolution config that imitates your build's, and they drift; with Vitest it's the same config object. I wouldn't migrate a large working Jest suite for this, and for React Native I'd still use Jest.

**Q: Walk me through writing a test for a function that validates a journal entry is balanced.**
A: First the contract: it takes a list of lines with debit and credit amounts and either returns nothing or throws. Then the cases. The happy path — two lines, equal, passes. The core failure — off by one cent, throws. Then the adversarial ones: an empty array, a single line, and both sides populated on one line, which our rules say is invalid. Since it's a pure function I'd use `it.each` for a table of amounts, so a failure names the case. For the throws I'd assert on type and message — `expect(() => assertBalanced(lines)).toThrow(ApiError)` — because "it threw something" would also pass on a `TypeError` from a typo. Critically, I'd assert with *integer cents*, not floats, since the whole reason the function exists is that `0.1 + 0.2 !== 0.3`; a test written in floats would encode the bug it's meant to prevent.

**Q: When do you mock, and when is mocking wrong?**
A: Mock at the boundary of what you own and what you can't control — the network, the clock, randomness, third-party APIs. Don't mock to avoid inconvenience. The specific anti-pattern I'd call out is mocking the database and then claiming your query is correct: a mocked pool proves a string was passed to a function. It can't tell you the SQL parses, the column exists, or a CHECK constraint fires. That's not hypothetical here — the previous version of this project mocked the pool in every test, so its migrations and constraints were never executed by a test at all. Green suite, unverified schema. It's why we run integration tests against a real Postgres container.

**Q: How do you test that an async function rejects?**
A: `await expect(fn()).rejects.toThrow(ApiError)`. The `await` is the part that matters — `.rejects` returns a promise, and without awaiting it the test function returns before the assertion resolves, so the test passes no matter what, including when the function doesn't throw at all. It's the most common silently-broken test in JavaScript. If I want to be extra safe in a test with branching, `expect.assertions(1)` at the top fails the test if the assertion never ran.

**Q: What does 90% code coverage tell you?**
A: That roughly 10% is definitely untested. That's all — it's a negative signal. A test that calls a function and asserts nothing gives full line coverage on it. Coverage measures execution, not verification. I'd rather see 70% with adversarial edge cases and a cross-tenant isolation test than 95% of happy paths. We scope coverage to `services/` and `utils/` because that's where the logic is; including thin controllers would raise the number without measuring anything.

**Q: Unit or integration — how do you decide?**
A: By what the code's claim is. If the claim is about logic — is this balanced, is this transition legal, does this convert correctly — a unit test is faster and pinpoints the failure. If the claim is about the *boundary* — this query is scoped by org, this constraint rejects that row, this trigger fires — only a real database can prove it, and a unit test there is theatre. Our rule is that every module ships both, and a module without a cross-tenant isolation test against real Postgres isn't done. The unit tests tell you *where* it broke; the integration tests tell you *whether* it works.

**Q: Tell me about a testing detail that surprised you.**
A: Vitest hoists `vi.mock` to the top of the file, so the docs say never reference an outer variable in the factory. I wanted to know if that was real, so I wrote it wrong deliberately — and it passed. Then I changed only the import of the subject from a dynamic `await import()` inside the test to a static top-level import, and the identical mock factory failed with `ReferenceError: Cannot access 'fakeQuery' before initialization`. The reason is that the factory is lazy: it runs when the mocked module is first imported. With a dynamic import that's inside the test, long after the module body evaluated the `const`; with a static import it's during the import phase, before it. So the same code is fine or broken depending on how the *subject* is imported. That's the worst kind of rule — one you can violate for months until an unrelated refactor makes it explode. Now I always use `vi.hoisted()`, which is correct in both cases.

## Follow-ups they'll dig into

- "How do you keep integration tests isolated from each other?" — `TRUNCATE ... CASCADE` per test, or transaction-and-rollback. Rollback is faster but doesn't work when the code under test manages its own transactions, which ours does. And Vitest parallelises files, so DB-backed suites need `fileParallelism: false` or a database per worker.
- "How would you test the cross-tenant isolation rule?" — create two orgs with real data, authenticate as org A, request org B's row by ID, assert 404 rather than 403 (a 403 confirms the row exists). Repeat per endpoint; it's the one test every module owes.
- "How do you test concurrency — two clients, one stock row?" — two real pool clients, both `BEGIN`, both `SELECT ... FOR UPDATE`, assert the second blocks until the first commits. Requires real Postgres; unmockable by definition.
- "How do you test time-dependent code?" — inject the clock or use `vi.useFakeTimers()` with `setSystemTime`. Never let a test depend on the real date; it'll fail on a leap day or in another timezone.
- "What would you do differently on a legacy Jest codebase?" — leave it. The migration cost is real and the benefit is mostly ergonomic. Vitest's argument is strongest for a new ESM+TypeScript project, which is exactly what we had.

## See also

- [typescript-build-and-dev-tooling.md](typescript-build-and-dev-tooling.md) — the Vite transform pipeline Vitest reuses, and why `tsx` doesn't type-check
- [../architecture/multi-tenancy-row-level-scoping.md](../architecture/multi-tenancy-row-level-scoping.md) — what a cross-tenant isolation test has to prove
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — why an open pool hangs the test process
- [../node-express/express-middleware-and-async-errors.md](../node-express/express-middleware-and-async-errors.md) — the 4-arg arity our 404 test implicitly verifies
