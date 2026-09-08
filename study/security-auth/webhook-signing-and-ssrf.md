# Webhook Signing (HMAC) & SSRF Prevention

> A webhook receiver has no TLS client cert and no session cookie to trust — an HMAC over the raw body, verified with the same shared secret both sides hold, is the entire authentication story. And a webhook *sender* fetching a user-supplied URL is the server voluntarily stepping outside its own trust boundary, which is a problem with a name: SSRF.

**Category:** Security & Auth
**Introduced by:** Phase 7 — `utils/webhookSignature.ts`, `utils/webhookUrl.ts`
**Verified against:** Node 22 `node:crypto`, WHATWG `URL`

---

## Mechanism

### Why HMAC, and why not a bearer token

A webhook delivery is an unauthenticated `POST` to a URL the *tenant* configured, not the server. Two different problems need solving: proving the request really came from AutoLedger, and proving the body wasn't altered in transit or by a compromised intermediary.

A bearer token (a static secret sent as `Authorization: Bearer <token>`) only proves the sender *knew* a value — it says nothing about the body. If TLS termination happens at a proxy that later got compromised, or if the token leaked and someone crafts their own request, the receiver has no way to detect a tampered payload versus a genuine one, because the token isn't a function of the content.

**HMAC-SHA256** is a keyed hash: `HMAC(secret, message)`. Both sides hold the same `secret` (generated server-side, shown to the tenant once, never re-displayed). The sender computes the MAC over the exact bytes it's about to send and includes it as a header; the receiver recomputes the same MAC over the exact bytes it received and compares. Because the hash is a function of *both* the secret and the content, changing either the body or forging the header without knowing the secret produces a MAC that won't match — this simultaneously authenticates the sender (only someone with the secret can produce a valid MAC) and integrity-checks the body (any alteration changes the MAC).

```ts
const mac = createHmac('sha256', secret)
  .update(`${timestampSeconds}.${rawBody}`)
  .digest('hex');
// header: `sha256=${mac}`
```

Asymmetric signatures (the sender holds a private key, the receiver verifies with a public key) would let the receiver verify *without* knowing a secret the sender must protect — irrelevant here, because the receiver already has to be trusted with a shared secret anyway (it's the tenant's own endpoint), and symmetric HMAC is simpler and faster to compute per-request. Asymmetric signing earns its complexity when the verifier is a third party who must never see the signing key at all — not the case for a webhook a tenant configured to receive their own events.

### Why the timestamp is *inside* the signed string

```
signWebhookBody(secret, timestamp, rawBody) = HMAC(secret, `${timestamp}.${rawBody}`)
```

If the timestamp merely rode alongside the signature as a separate header, a captured request could be replayed verbatim — the signature would still validate, because it was never a function of the timestamp. Folding the timestamp *into the signed material* means a receiver that additionally rejects a request whose timestamp is more than a few minutes old gets replay protection **for free**: an attacker replaying an old request can't simply attach a fresh timestamp, because that would require recomputing the signature, which requires the secret. The signature check and the freshness check compose into full replay resistance without either one doing it alone.

### Constant-time comparison

```ts
const expectedBuf = Buffer.from(expected);
const actualBuf = Buffer.from(header);
if (expectedBuf.length !== actualBuf.length) return false;
return timingSafeEqual(expectedBuf, actualBuf);
```

A naive `===` or `Buffer.equals` comparison short-circuits at the first differing byte, so the time the comparison takes leaks *how many leading bytes matched* — a textbook timing side-channel. Given enough requests, an attacker can use response-time differences to recover the correct signature byte-by-byte instead of needing all 2²⁵⁶ guesses at once. `crypto.timingSafeEqual` compares in time proportional to length regardless of where (or whether) the buffers differ, closing that channel — but only if the lengths already match, which is why the length check happens *before* calling it (comparing differently-sized buffers throws, and returning `false` early on a length mismatch leaks only "wrong length," not position).

### SSRF: why fetching a user-supplied URL is dangerous

**Server-Side Request Forgery** is what happens when a server can be induced to make an HTTP request to a destination the *attacker* chooses, using the server's own network position and credentials. A webhook feature is, structurally, exactly this: the server takes a URL a tenant typed into a form and later fetches it. Without validation, that tenant-supplied URL could be:

- `http://169.254.169.254/latest/meta-data/iam/security-credentials/...` — the AWS/GCP/Azure cloud metadata endpoint, reachable only from inside the VPC, that hands out the instance's own IAM credentials to anything that asks. This is the canonical SSRF exploitation target; it's why the guard rejects `169.254.0.0/16` explicitly.
- `http://localhost:5432` or `http://10.0.0.5:6379` — internal services (the database, Redis, an admin panel) that were never meant to be reachable from outside the deployment, now reachable *by the server itself*, from inside the network, bypassing whatever perimeter firewall exists.
- Anything on the deployment's private subnet, effectively turning the webhook feature into a port scanner: a receiver that error-differently for "connection refused" vs "200 OK" leaks which internal ports are open.

The fix is validating the URL **at write time** (`assertDeliverableUrl`, called from `createEndpoint`/`updateEndpoint`), rejecting:

- Non-`http(s)` protocols, and `http:` specifically in production (an unencrypted webhook body is a real exposure for financial event data).
- Embedded credentials (`https://user:pass@host/`) — not an SSRF vector directly, but a sign of a malformed or malicious URL that shouldn't be stored.
- `localhost`, `*.localhost`, `*.local`, `*.internal` by hostname.
- Any IPv4 literal in a private/reserved range: `10.0.0.0/8`, `127.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (link-local, which is where the cloud metadata endpoint lives), and `0.0.0.0/8`.
- IPv6 literals, rejected wholesale — correctly enumerating IPv6's private/reserved ranges (`::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped addresses, …) is meaningfully more code than a hostname-based feature justifies, and a bare IP literal is not the normal case for a real webhook receiver.

### The gap this doesn't close: DNS rebinding

Validating at write time checks where `hooks.example.com` resolves **right now**. Nothing stops the DNS record from later pointing at `127.0.0.1` — the receiver's operator (or an attacker who compromised their DNS) can change the answer at any time, and the *send-time* `fetch` will happily connect to whatever the hostname resolves to at that moment, bypassing the check entirely. Closing this properly requires resolving the hostname once, validating the resolved IP, and then connecting directly to that IP (with the `Host` header still set correctly) rather than letting the HTTP client re-resolve — Node's built-in `fetch` doesn't expose a hook for that. This is recorded as a known, accepted limitation rather than silently ignored; a production system with a real security budget would add a validating DNS resolver or a fetch wrapper that pins the connection to the IP it validated.

### `redirect: 'manual'` as the second half of the same defense

Even with the URL guard, the *response* to that first request could be an HTTP redirect pointing anywhere — including a private address the guard would have rejected if it were the original URL. `fetch(..., { redirect: 'manual' })` tells the client to treat a 3xx response as a normal (non-following) response rather than automatically issuing a second request to `Location`. This is not a convenience setting; without it, the write-time URL validation is provably bypassable by any receiver willing to return a redirect.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| HMAC-SHA256 over `timestamp.body` | Both sides need the shared secret; no third-party verifiability | **Chosen** — matches Stripe/GitHub's well-understood webhook-signing convention, and the receiver is the tenant's own system, so a shared secret is the natural model |
| Bearer-token auth only | Simpler; no signing code | Rejected — proves possession of a token, not integrity of the body; a tampered-in-transit payload would still "authenticate" |
| Asymmetric signatures | Receiver verifies without holding a secret | Rejected as unnecessary complexity — the receiver already must be trusted with a shared secret in this model (it's the tenant's own endpoint), so the extra property asymmetric signing buys (verification without the signing key) isn't needed |
| No SSRF validation, trust the tenant's input | Zero validation code | Rejected outright — a tenant admin isn't necessarily the attacker; a compromised tenant account, a copy-pasted malicious URL, or simple misconfiguration all become an internal-network probe otherwise |
| DNS-rebinding-proof resolve-then-connect | Fully closes the send-time gap | Deferred — Node's `fetch` doesn't expose the hook needed, and the write-time guard plus `redirect: 'manual'` cover the realistic threat model for this feature's current scope. Recorded as a known limitation, not silently dropped |

## Where it lives in this codebase

- `server/src/utils/webhookSignature.ts` — `generateWebhookSecret`, `signWebhookBody`, `verifyWebhookSignature` (used by the test suite to prove our own signing is internally consistent)
- `server/src/utils/webhookUrl.ts` — `assertDeliverableUrl`, called from `webhookService.createEndpoint`/`updateEndpoint`
- `server/src/queue/handlers/webhookDeliverHandler.ts` — builds the signed request, sets `redirect: 'manual'` and `AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)`
- `server/src/db/migrations/020_platform_outbox_and_webhooks.sql` — `webhook_endpoints.secret`, stored in plaintext (unlike a password) because the server must reproduce the exact key on every send, never selected into any API response (`webhookService.ts`'s `ENDPOINT_SELECT`)

## Gotchas

- **Comparing signatures with `===`.** Reintroduces the timing side-channel `timingSafeEqual` exists to close.
- **Signing the body without the timestamp.** Turns a valid request into a permanently-replayable one.
- **Forgetting `redirect: 'manual'`.** Silently defeats every SSRF check that came before it.
- **Assuming write-time validation is sufficient.** DNS rebinding is real; this codebase records the gap rather than claiming coverage it doesn't have.
- **Logging the secret, the signature header, or the full request body "for debugging."** The secret in a log is a secret that leaked — guardrails rule 11's spirit extended past JWTs.
- **Treating a public IPv4 literal as automatically safe.** The guard only blocks *private/reserved* ranges — `http://8.8.8.8/hook` is legal, and correctly so; the point is blocking the internal network, not IP literals generally.

## Interview Q&A

**Q: Why HMAC instead of just checking a shared secret in an `Authorization` header?**
A: A bearer token proves the sender knows a value; it says nothing about whether the body that arrived is the body that was sent. HMAC is a keyed hash over the actual payload, so it proves both things at once — only someone holding the secret could have produced a MAC that matches *this specific body*, so a tampered-in-transit payload fails verification even if the attacker somehow captured the token separately.

**Q: Explain the replay-attack vector this design closes, and how.**
A: Without a timestamp in the picture, a captured valid request (headers, signature, body, all genuine) could be resent verbatim at any later time and would still verify — the signature doesn't encode *when* it was made. Putting the timestamp inside the signed string means the signature is now a function of time too; the receiver additionally checks the timestamp is recent (say, within 5 minutes) and rejects stale ones. An attacker can't fix a captured request's timestamp without recomputing the signature, which needs the secret they don't have.

**Q: What's a timing attack, concretely, in the context of signature verification?**
A: If comparison short-circuits at the first mismatched byte (as `===` or a naive loop does), the time the comparison takes correlates with how many leading bytes were correct. An attacker who can measure response latency precisely enough (and who can make enough attempts) can recover the correct signature one byte at a time — try all 256 values for byte 0, keep whichever takes measurably longer, move to byte 1 — turning a brute force of 2²⁵⁶ possibilities into roughly 256×32. `timingSafeEqual` compares in constant time regardless of where a mismatch occurs, so there's no signal to measure.

**Q: What is SSRF, and why does a webhook feature specifically create the risk?**
A: Server-Side Request Forgery is inducing a server to make a network request to a destination the attacker controls, using the server's own network position. A webhook feature does exactly what SSRF needs by design — it takes a URL from user input and has the server fetch it — so without validation it's a built-in SSRF primitive. The canonical damage is reaching the cloud metadata endpoint (`169.254.169.254`) to steal the instance's own IAM credentials, or reaching internal services (a database, an admin panel) that were never meant to be internet-facing but are reachable from inside the network the server already sits in.

**Q: You said your URL validation happens at write time. What's the gap, and why didn't you close it?**
A: DNS rebinding — a hostname that resolves to a public IP when you validate it can be repointed to `127.0.0.1` or an internal address later, and the actual `fetch` at send time re-resolves and connects to wherever it currently points, bypassing the earlier check entirely. Closing it properly means resolving the hostname once yourself, validating *that* IP, and then connecting directly to the validated IP rather than letting the HTTP client re-resolve — which Node's built-in `fetch` doesn't give you a hook for. I recorded it as a known limitation rather than pretending the write-time check is a complete SSRF defense; a production deployment with a stricter threat model would need a custom resolver or fetch wrapper.

**Q: Why does `redirect: 'manual'` matter here specifically?**
A: The URL guard only ever inspects the URL the tenant *typed*. If the request to that URL comes back with a 3xx and the client follows redirects automatically, the *second* request goes wherever the `Location` header says — which the guard never saw and never validated. A malicious or compromised receiver could pass the initial URL check and then redirect every delivery to an internal address. `redirect: 'manual'` stops the fetch from automatically following that redirect, so the guard's coverage isn't silently bypassable by the receiver's own response.

## Follow-ups they'll dig into

- "How would you fully close the DNS-rebinding gap?" (Resolve the hostname yourself with `dns.lookup`, validate the resolved IP against the same private-range rules, then make the request with an explicit IP and a `Host` header — or use a fetch agent that pins the connection.)
- "Why generate a 32-byte secret specifically?" (256 bits of entropy — well beyond brute-force range for an HMAC key, and matches the same `openssl rand -hex 32` convention used for the JWT signing secrets elsewhere in this codebase.)
- "What would you do differently for a *public* webhook API other companies integrate with?" (Publish the signing scheme, support secret rotation with an overlap window — old and new secret both valid briefly — so receivers can roll their verification key without a coordinated cutover; this codebase's rotate-secret endpoint deliberately does *not* have an overlap window, which is a fine trade for an internal-facing feature but wouldn't be for a public integration surface.)
- "Should the secret be hashed at rest, like a password?" (No — and that's worth explaining, not just asserting: a password hash is one-way because the server only ever needs to *verify* a guess, never reproduce the original. Here the server must recompute the exact same HMAC on every outbound send, which requires the plaintext key. The mitigation is narrow exposure — never returned by a read endpoint — not hashing.)

## See also

- [../architecture/transactional-outbox.md](../architecture/transactional-outbox.md)
- [jwt-and-refresh-rotation.md](jwt-and-refresh-rotation.md) — the other HMAC-based signing scheme in this codebase
- [password-hashing-and-timing.md](password-hashing-and-timing.md) — timing attacks in a different context, and why hashing is right there but wrong here
- `docs/guardrails.md` rule 11
