# Password Hashing, Work Factors & Timing Oracles

> Storing a password is a deliberately slow operation, and the login that checks it must take the same time whether or not the account exists.

**Category:** Security
**Introduced by:** Phase 1 — `POST /auth/register` and `POST /auth/login`
**Verified against:** Node 24.4.1, `bcrypt` 6.0.0, PostgreSQL 16

---

## Mechanism

### Why not SHA-256

The instinct "hash it so it isn't plaintext" is right and insufficient. SHA-256 is built to be **fast** — that is its purpose everywhere else. A commodity GPU does billions per second, so a leaked table of SHA-256 password digests is a few hours of offline work against any realistic password. Speed is the vulnerability.

Two separate problems, two separate fixes:

**Identical passwords produce identical digests** → **salt.** A per-password random value mixed in before hashing, stored alongside the result. Two users with `hunter2` now have different digests, which kills precomputed rainbow tables and stops a leak revealing who shares a password.

**Hashing is too fast** → **work factor.** Deliberately burn time per hash.

### What bcrypt stores

bcrypt puts everything needed to verify into one 60-character string:

```
$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKyQ8Xk7pF3gS9y
└┬┘ └┬┘ └──────────────────────┬──────────────────────────┘
 │   │                          │
 │   │                          └─ 22-char salt + 31-char digest, base64
 │   └─ cost: 2^12 = 4096 iterations of the key schedule
 └─ algorithm variant
```

There is no separate salt column. `bcrypt.compare(plaintext, stored)` parses the cost and salt back out of the stored string, re-runs the derivation, and compares — which is also why raising the cost later does not invalidate existing hashes: each row verifies at whatever cost it was written with.

The cost is a **power of two**. 12 → 4096 iterations of an expensive key schedule, roughly 250ms on this machine. Each +1 doubles the work — for the attacker and for you. The rule of thumb is the highest cost your login latency budget tolerates, revisited as hardware improves.

### The 72-byte truncation — the trap in this library

bcrypt operates on at most **72 bytes** of input and silently ignores the rest. Two different passwords sharing a 72-byte prefix are interchangeable at login. I verified it rather than trusting the folklore:

```
72-byte truncation: true    // 'a'*72+'DIFFERENT' compared against a hash of 'a'*72+'XXXXXXXXX'
```

Bytes, not characters. `password.length` counts UTF-16 code units, so 19 emoji (`'😀'.repeat(19)`) is 76 bytes and would be truncated while looking like a 19-character password. The check has to be:

```ts
if (Buffer.byteLength(value, 'utf8') > 72) throw new ApiError(400, '…at most 72 bytes');
```

Rejecting is the right call. Silently accepting means storing a hash that does not actually cover the password the user typed.

### The timing oracle

The natural login shape leaks:

```ts
const user = await findByEmail(email);
if (!user) return unauthorized();               // ~2ms — no hashing happened
if (!await bcrypt.compare(pw, user.password))   // ~250ms — cost 12
  return unauthorized();
```

Both paths return an identical 401 with an identical message — and yet the response *time* answers "does this email have an account?" A 2ms reply means no, 250ms means yes. That is a user-enumeration oracle, useful for targeting phishing or credential stuffing, and it is invisible in the response body.

The fix is to always do the work:

```ts
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalisation-placeholder', BCRYPT_COST);
// …
const matches = await bcrypt.compare(password, row?.password ?? DUMMY_PASSWORD_HASH);
if (row === undefined || !matches) throw new ApiError(401, 'Invalid email or password');
```

The dummy hash is computed once at import, at the same cost, so both branches pay the same ~250ms.

This is the same family as timing-safe comparison (`crypto.timingSafeEqual`), where `===` on secrets short-circuits at the first differing byte. `bcrypt.compare` already does a constant-time comparison internally; what needed fixing was the *branch*, not the comparison.

### Where the CPU time goes

bcrypt is CPU-bound by design, and Node has one main thread. The native `bcrypt` binding runs the async form on the **libuv threadpool** (default 4 threads), so the event loop keeps serving other requests. Pure-JS `bcryptjs` cannot — it blocks the main thread for the full 250ms, and at cost 12 a handful of concurrent logins stalls every unrelated request. That is the concrete version of the story in [event-loop-and-blocking.md](../node-express/event-loop-and-blocking.md), and it is why this project uses the native binding.

Even so, the threadpool is a bounded resource: more concurrent hashes than threads and the surplus queues. It is shared with `fs` and `dns`, so heavy login traffic contends with file I/O — tunable via `UV_THREADPOOL_SIZE`.

---

### Password reset tokens (2026-09-29)

`POST /auth/forgot-password` and `POST /auth/reset-password` follow the same principles as the rest of this note, applied to a token instead of a password:

- **The token is 256 random bits** (`randomBytes(32)`, base64url), and the database stores only its **SHA-256**. SHA-256 is correct here and wrong for passwords for one reason: entropy. A human password is guessable, so its hash must be slow; a 256-bit random token cannot be guessed, so a fast hash loses nothing and a stolen table yields no usable link. Refresh tokens are stored the same way.
- **Single use via an atomic claim.** Redemption is `DELETE ... RETURNING` on the token hash, so two concurrent submissions of one link cannot both succeed. An expired token is deleted in the same statement and the transaction still commits, so it can never be retried.
- **A reset ends every session.** The same transaction deletes the user's other reset tokens and all their refresh tokens. If the password was reset because someone else knew it, their sessions die with it.
- **No account enumeration.** `forgot-password` answers `202` with the same body whether or not the email exists, and doesn't even validate the email format (a format error would be a different answer). The response time is *not* perfectly equal: a real account costs one extra indexed insert. That's a stated, accepted gap, unlike login, where the unequal path would be a whole bcrypt comparison (hundreds of milliseconds) and is equalised with a dummy hash.
- **30-minute expiry, newest link only.** Issuing a token deletes the user's older ones.
- **No mail transport.** Outside production the link is logged, and the request log records paths without query strings, so the token never lands there. A real mailer would be a job queued in the same transaction (rule 5), never a call made after `COMMIT`.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| SHA-256 / SHA-512 | Fast — which is the problem | Rejected |
| `bcryptjs` (pure JS) | No native build; blocks the event loop for the whole hash | Rejected — and it would contradict a note already written |
| **`bcrypt` (native)** | node-gyp/prebuild risk; 72-byte cap | **Chosen** — hashes on the threadpool, and `docs/schema.md` already specified bcrypt |
| `crypto.scrypt` (built in) | Memory-hard, zero dependencies, threadpool-backed | Strong alternative, and the fallback if the native build failed. Genuinely defensible |
| Argon2id | Current best practice, PHC winner | Rejected for now — another native dependency for a marginal gain at this scale |

The native build was verified **before** anything depended on it: `bcrypt` 6.0.0 installed from a prebuild on Node 24 with no source compile.

**Cost is environment-dependent, not an env var:**

```ts
export const BCRYPT_COST = env.isTest ? 4 : 12;
```

At cost 12 every test fixture that registers a user costs 250ms, and the suite creates dozens. Cost 4 makes that ~2ms. Not exposed as an env var deliberately — a mistyped production value would be a silent security regression, whereas `isTest` cannot be set by accident in production.

## Where it lives in this codebase

- `server/src/services/authService.ts` — `requestPasswordReset` / `resetPassword` (2026-09-29); `db/migrations/077_platform_password_reset_tokens.sql`; `__tests__/passwordReset.test.ts`

- `server/src/services/authService.ts` — `DUMMY_PASSWORD_HASH`, `register`, `login`
- `server/src/config/constants.ts` — `BCRYPT_COST`, `MAX_PASSWORD_BYTES`, `MIN_PASSWORD_LENGTH`
- `server/src/utils/validate.ts` — `requirePassword`, the byte-length check
- `server/src/__tests__/validate.test.ts` — the 72-byte and emoji cases
- `server/src/__tests__/auth.test.ts` — asserts wrong-password and unknown-email return an identical 401

## Gotchas

- **72 *bytes*, not characters.** `Buffer.byteLength`, never `.length`.
- **Never trim a password.** Leading and trailing spaces are legitimate characters; stripping them locks users out of the password they set. `requirePassword` deliberately does not trim, while `requireString` does.
- **One error message for both failure causes**, or the message itself becomes the oracle the timing fix just closed.
- **Cost 12 in tests will make you think the suite is broken.** It isn't; it is doing exactly what you asked, 60 times.
- **Raising the cost does not rehash existing users.** Each stored hash carries its own cost. Upgrading means rehashing on next successful login, when you hold the plaintext.
- **Hashing does not fix a weak password.** bcrypt buys time against a leak; it does nothing about `password123`. Rate limiting is the online defence — and this project does not have it yet, which is recorded as a scheduled decision in `docs/development.md` rather than left implicit.

## Interview Q&A

**Q: Why can't you store passwords with SHA-256?**
A: Two reasons. SHA-256 is unsalted by default, so identical passwords give identical digests — rainbow tables apply, and a leak reveals which users share a password. And it is fast by design: billions per second on a GPU, so a leaked table falls to offline brute force quickly. Password hashing wants the opposite property. bcrypt salts automatically and has a tunable work factor that makes each guess expensive.

**Q: What is the cost factor and how do you pick it?**
A: It's the base-2 log of the iteration count — cost 12 means 2^12 = 4096 rounds of bcrypt's key schedule, about 250ms here. Each increment doubles the work for the attacker and for you, so you pick the highest value your login latency tolerates, and revisit it as hardware improves. It's stored inside the hash string, so old hashes keep verifying at their original cost after you raise it; you upgrade opportunistically on next login when you have the plaintext.

**Q: Your login returns the same message for a wrong password and an unknown email. Is that enough?**
A: No, and that's the interesting part. The message is identical but the *timing* isn't: an unknown email returns in about 2ms because no hash ran, while a real one costs 250ms. That difference is a reliable user-enumeration oracle. The fix is to always do the work — compare against a precomputed dummy hash at the same cost when no user is found, so both paths take the same time.

**Q: What's the 72-byte thing?**
A: bcrypt only consumes the first 72 bytes of input and silently ignores the rest, so two different long passwords sharing a 72-byte prefix hash identically and are interchangeable at login. I reject anything longer with a 400 rather than storing a hash that doesn't cover what the user typed. It has to be measured in bytes — `.length` counts UTF-16 units, so 19 emoji is 76 bytes but looks like 19 characters. I verified the truncation empirically rather than trusting the documentation.

**Q: bcrypt is CPU-heavy and Node is single-threaded. Doesn't that block everything?**
A: It depends which bcrypt. The native binding runs the async form on the libuv threadpool, so the event loop stays free and other requests keep being served. Pure-JS `bcryptjs` cannot — it occupies the main thread for the full duration, and at cost 12 a few concurrent logins stall every unrelated request. That's why we use the native one. The threadpool is still bounded — four threads by default, shared with `fs` and `dns` — so heavy login traffic queues and contends with file I/O.

**Q: How would you handle a password-hash upgrade — say bcrypt to Argon2?**
A: You can't rehash without the plaintext, so it's opportunistic. Store an algorithm marker with each hash — bcrypt's `$2b$` prefix already gives you one. On successful login, verify with the old algorithm, then immediately rehash with the new one and overwrite the row. Over time the population migrates; you set a deadline after which remaining old-algorithm accounts are forced through a reset.

**Q: Walk me through how you'd design a password reset.**
A: Generate a long random token (I use 256 bits) and store only its SHA-256. A fast hash is fine here because the token has far too much entropy to guess, unlike a password, and it means a leaked database gives no working links. The link expires in 30 minutes, and issuing a new one deletes the older ones. Redeeming it is a single `DELETE ... RETURNING` on the hash inside a transaction, so the link is single-use even under a double-click race. The same transaction sets the new bcrypt hash and deletes every refresh token for the user, so any session opened with the old password ends. The forgot-password endpoint answers identically whether or not the account exists, so it can't be used to discover who's registered. And the link's token never appears in logs, and `Referrer-Policy: no-referrer` keeps it out of `Referer` headers.

## Follow-ups they'll dig into

- *"What about rate limiting?"* The online defence bcrypt cannot provide. Not built here — deliberately scheduled, not forgotten.
- *"Where does the salt live?"* Inside the 60-character bcrypt string. No separate column.
- *"Is `bcrypt.compare` timing-safe?"* Internally yes. The leak was the *branch* around it, not the comparison.
- *"Peppering?"* A server-side secret mixed in before hashing, stored outside the database, so a DB-only leak is useless. Costs a key-management problem — reasonable at higher stakes.
- *"Why not scrypt or Argon2?"* Both are good; Argon2id is current best practice. bcrypt was already specified in the schema doc, and scrypt was the fallback if the native build failed.

## See also

- [event-loop-and-blocking.md](../node-express/event-loop-and-blocking.md) — the threadpool this offloads to
- [jwt-and-refresh-rotation.md](jwt-and-refresh-rotation.md) — what happens after the password checks out
