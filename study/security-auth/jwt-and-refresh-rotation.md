# JWT & Refresh Token Rotation

> A signed token proves who issued it, not whether it should still be honoured. Everything else follows from that.

**Category:** Security
**Introduced by:** Phase 1 — login, session persistence, and `POST /auth/refresh`
**Verified against:** Node 24.4.1, `jsonwebtoken` 9.0.3, PostgreSQL 16

---

## Mechanism

### What a JWT actually is

Three base64url segments joined by dots: `header.payload.signature`.

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9      {"alg":"HS256","typ":"JWT"}
eyJzdWIiOiIyOWE4ZjViYy0zYTAxIiwib3JnSWQ… {"sub":"29a8f5bc…","orgId":"bb452da8…","role":"OWNER","iat":…,"exp":…}
vQMVbPepCRguq5eI011QF4FUVBoN2lXQ1pO6…    HMAC-SHA256(base64url(header) + "." + base64url(payload), secret)
```

**base64url is encoding, not encryption.** Anyone holding the token can read the payload — paste it into jwt.io, or just `atob` it. The signature is an HMAC: a keyed hash over the first two segments. Verification recomputes that HMAC with the server's secret and compares. Matching means *we* produced this exact byte sequence and nobody altered it since.

With `HS256` the same secret signs and verifies, so every party that can verify can also forge — fine for one service, wrong the moment a third party needs to verify, which is when you move to `RS256` (sign with a private key, publish the public one).

The critical property: **verification is a pure function of the token and the secret.** No database, no network, no shared state. That is what makes JWTs scale horizontally — and it is exactly why they cannot be revoked. Nothing is consulted that could say "this one is cancelled". `exp` is enforced by the verifier reading a claim inside the token itself, which is why a stolen token remains valid for its full lifetime.

### The access/refresh split

That un-revocability is the whole design pressure. The resolution is two tokens with different jobs:

| | Access | Refresh |
|---|---|---|
| Lifetime | 15 minutes | 7 days |
| Checked against the DB? | No | **Yes — a row must exist** |
| Sent where | every API call (`Path=/`) | only `/api/v1/auth` |
| Secret | `ACCESS_TOKEN_SECRET` | `REFRESH_TOKEN_SECRET` |

The access token is stateless and short-lived: cheap to verify, and a leak is bounded to 15 minutes. The refresh token is long-lived but **stateful** — it only works if a matching row exists in `refresh_tokens`, so deleting that row revokes it instantly. Revocability is bought back exactly where it is affordable, on the once-per-15-minutes path rather than on every request.

### Rotation, and why the claim must be atomic

Every refresh consumes its token and issues a new one. The naive implementation has a race:

```ts
const row = await client.query('SELECT … WHERE token_hash = $1'); // both see it
if (!row) throw;
await client.query('DELETE …');                                   // both delete
```

Two concurrent refreshes with the same token both read the row, both proceed, and both mint a session. The fix is to make the read and the claim the same statement:

```sql
DELETE FROM refresh_tokens WHERE token_hash = $1
RETURNING user_id, org_id, expires_at
```

`DELETE … RETURNING` locks and removes the row in one atomic step. The first transaction gets the row; the second blocks on the row lock, and when the first commits, re-evaluates its predicate against the now-deleted row and returns **zero rows**. Exactly one winner, enforced by the database rather than by application timing.

### Reuse detection falls out for free

Now look at what "zero rows returned, but the signature was valid" means. The token is genuine — we signed it — but its row is gone, so it was already spent. Either the legitimate client is replaying (a bug), or someone else rotated it first (a theft). You cannot tell which, and both warrant the same response:

```ts
await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [claims.userId]);
throw new ApiError(401, 'Refresh token has already been used…');
```

Deleting the whole **token family** ends every session for that user. If a token leaked, everything descended from it is suspect. This is the standard OAuth 2.0 BCP refresh-token-rotation recommendation, and here it costs one extra `DELETE` and zero extra state.

### Why `jti` is mandatory

`jwt.sign({ sub }, secret, { expiresIn: '7d' })` is a pure function of the payload and `iat`, which has **one-second resolution**. Two logins in the same second produce a byte-identical token, an identical SHA-256, and a `UNIQUE` violation on `token_hash` — for a completely legitimate action. `jwtid: randomUUID()` makes every token distinct.

I would not have predicted this one; it showed up as a puzzling 500 on a double login and it is now a test:

```ts
it('gives two tokens issued in the same second different values', () => {
  expect(signRefreshToken(id, 'org-1')).not.toBe(signRefreshToken(id, 'org-1'));
});
```

### Why the token is hashed at rest

`refresh_tokens.token_hash` stores SHA-256 hex, not the token. A database dump then yields nothing usable.

**A fast hash is correct here, and that surprises people** who have internalised "never store a credential with a fast hash". bcrypt's slowness exists to make *guessing* expensive, which matters when the secret is a low-entropy human password from a small realistic space. A refresh token is 200+ bits of `randomUUID` plus an HMAC — brute-forcing it is infeasible regardless of hash speed, so bcrypt would add latency to every refresh and buy nothing. Use bcrypt for what humans choose; use SHA-256 for what you generated.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Server-side sessions (session id → Redis) | Trivially revocable, but every request hits Redis, and Redis has no consumer until Phase 7 | Rejected for now — genuinely reasonable, and the honest answer to "why not sessions?" is scale-vs-simplicity, not correctness |
| Long-lived access token, no refresh | One fewer moving part; a leak lasts days | Rejected — unacceptable for financial data |
| Access + refresh, refresh **not** rotated | Simpler; a stolen refresh token works for its full 7 days undetected | Rejected — rotation is what makes theft *detectable* |
| **Access + refresh with rotation and family invalidation** | Two-tab race (below) | **Chosen** |
| One secret for both token types | One less env var | **Rejected — this is a vulnerability.** A refresh token would verify as an access token, so a stolen 7-day credential becomes an unlimited-lifetime one. `env.ts` refuses to boot if the two match |

[guardrails.md rule 11](../../docs/guardrails.md) fixes the TTLs and forbids reintroducing the prior build's vestigial `JWT_SECRET`.

## Where it lives in this codebase

- `server/src/utils/jwt.ts` — the **only** module that signs, verifies, or narrows a raw JWT. Everything else deals in `AuthUser` / `RefreshClaims`
- `server/src/services/authService.ts` — `rotateRefreshToken` (the atomic claim), `login`, `switchOrg`, `logout`
- `server/src/middleware/auth.ts` — verify-only, no DB round trip
- `server/src/config/env.ts` — length and distinctness checks on both secrets
- `server/src/__tests__/auth.test.ts` — rotation, replay, family invalidation

## Gotchas

- **`jwt.verify` returns `string | JwtPayload`.** The string branch is real (a token signed over a plain string payload) and must be rejected, not cast away. Narrowed once, inside `utils/jwt.ts`.
- **A valid signature does not mean a well-formed payload.** A token we signed before a schema change could carry a role that no longer exists. `verifyAccessToken` re-validates `sub`, `orgId` and `role` and throws on anything unexpected, so a missing `orgId` can never become `undefined` inside a query's scope.
- **Never log a decoded payload** (rule 11). It contains the user id, the active org, and the role.
- **Error messages are deliberately uniform.** Expired, malformed and bad-signature all produce "Invalid or expired token" — distinguishing them tells an attacker which half of a forgery attempt worked.
- **The two-tab race is real and accepted.** Two tabs refreshing in the same instant both present the pre-rotation cookie; the loser trips reuse detection and logs the user out everywhere. Client-side single-flight closes the same-tab case, and the cross-tab window is narrow because the cookie jar is shared. The alternative — a grace period where a just-rotated token still works — reopens the replay hole it exists to close.
- **`exp` is checked by the verifier against its own clock.** Skew between issuer and verifier causes spurious rejections; `jsonwebtoken` exposes `clockTolerance` for that.

## Interview Q&A

**Q: What is a JWT, and what does the signature actually prove?**
A: Three base64url segments — header, payload, signature. The signature is an HMAC over the first two using a server secret. Verifying recomputes it and compares, which proves the token was issued by someone holding the secret and has not been modified. It proves nothing about whether the token *should still* be honoured — that is the key limitation. base64url is encoding, not encryption, so never put anything secret in the payload.

**Q: Why not just use one long-lived token?**
A: Because a JWT cannot be revoked. Verification is a pure function of the token and the secret, so nothing is consulted that could cancel it — a stolen token is valid until `exp`, full stop. The split makes that acceptable: the access token is stateless but expires in 15 minutes, so a leak is bounded; the refresh token lasts 7 days but is backed by a database row, so deleting it revokes instantly. You buy revocability precisely where you can afford it.

**Q: Walk me through refresh token rotation and how you detect theft.**
A: Each refresh consumes its token and issues a new one. I claim the row with the delete itself — `DELETE … WHERE token_hash = $1 RETURNING …` — rather than SELECT-then-DELETE, because a read followed by a write lets two concurrent refreshes both succeed. With the atomic form exactly one transaction gets the row.

The elegant part is that reuse detection is then free. A valid signature with zero rows returned means the token was already rotated, i.e. it is being replayed. I cannot tell attacker from victim, so I delete the user's entire token family and return 401. It costs one extra DELETE and no additional state.

**Q: Why hash the refresh token with SHA-256 rather than bcrypt?**
A: Because bcrypt's cost function exists to make guessing expensive, and that only matters for low-entropy secrets like human passwords. A refresh token is 200+ bits of randomness — infeasible to brute-force regardless of hash speed. bcrypt would add ~250ms to every refresh and buy nothing. The rule I'd state: slow hash for what humans choose, fast hash for what you generated. I still hash it, so a database dump yields no usable sessions.

**Q: You have two token secrets. Why not one?**
A: Because with one secret a refresh token verifies as an access token. Someone who steals the 7-day refresh cookie could present it as a bearer credential to any authenticated route, and the 15-minute access TTL — the entire reason for the split — would be worth nothing. It's a three-line check, so `env.ts` refuses to boot if the two are equal, alongside a 32-character minimum.

**Q: Tell me about a bug you hit implementing this.**
A: Logging in twice within the same second threw a unique-constraint violation. `jwt.sign` is deterministic given the payload and `iat`, and `iat` has one-second resolution — so both calls produced a byte-identical token, and therefore an identical SHA-256, colliding on the `token_hash` unique index. The fix is `jwtid: randomUUID()` on every refresh token. What I took from it is that "the token is random" was an assumption I had never checked; the randomness has to be *put there*. It's a test now.

## Follow-ups they'll dig into

- *"What if the user logs out on one device — are they logged out everywhere?"* No. Logout deletes one row, so other sessions survive. Reuse *detection* deletes the whole family, because at that point one of them is presumed compromised.
- *"How do you handle a compromised signing secret?"* Rotating it invalidates every outstanding token, so everyone is logged out. Graceful rotation means accepting both old and new keys during an overlap window — `kid` in the header selects the key.
- *"Why not put the token in `localStorage` and skip cookies?"* See [cookies-samesite-and-csrf.md](cookies-samesite-and-csrf.md) — `localStorage` is readable by any XSS payload.
- *"What happens under two tabs?"* The accepted race above. Worth volunteering before they find it.
- *"Does refresh re-check permissions?"* Yes — membership is re-validated on every refresh, which bounds the stale-role window to one access-token lifetime. See [multi-tenancy-row-level-scoping.md](../architecture/multi-tenancy-row-level-scoping.md).

## See also

- [cookies-samesite-and-csrf.md](cookies-samesite-and-csrf.md) — how these tokens are transported
- [password-hashing-and-timing.md](password-hashing-and-timing.md) — the login step that precedes issuing them
- [transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — why `DELETE … RETURNING` is atomic
