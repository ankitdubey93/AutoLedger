# Service Accounts and the JWT-Bearer Grant

> A service account authenticates as itself, not on behalf of a user — which is exactly why it needs no consent screen, no Google verification, and no refresh token to expire.

**Category:** Security
**Introduced by:** Phase 19.3 — the Drive integration's recommended connection mode, replacing 19.2's OAuth-only flow as the default
**Verified against:** Node 24.4.1, `node:crypto` (no `google-auth-library`, no `googleapis` — hand-rolled, guardrails rule 14), RFC 7523, Google's documented service-account flow as of 2026

---

## Mechanism

### What problem this actually solves

Phase 19.2's Drive connection used the standard three-legged OAuth flow: redirect the user to Google, they consent, Google redirects back with a code, the server exchanges it for tokens. That flow assumes there is a *person* consenting on behalf of *their own* data. For a server-side integration that just needs to read files from a folder a tenant chooses to share, three-legged OAuth is solving a harder problem than the one that exists — and it comes with real costs that only bite once the app is actually deployed:

- `drive.readonly` is a Google-classified **restricted scope**. Requesting it for real users means an annual third-party security assessment, not just a review.
- An OAuth app in Google's **"Testing" publishing status issues refresh tokens that expire after 7 days.** A demo or pre-launch connection dies weekly, silently, until someone notices the sync stopped.

A **service account** is a different kind of principal entirely: a Google-managed identity that belongs to a Cloud project, not to any human. It authenticates with its own key pair, and a tenant grants it access the same way they'd grant access to any other person — by sharing a folder with its email address. No consent screen exists to show, because no user is being asked to authorize anything on their own behalf.

### The JWT-bearer grant, mechanically

RFC 7523 defines a grant type for exactly this: exchange a self-signed JWT **assertion** for an access token, no authorization code, no redirect, no user interaction at all.

```
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<signed-jwt>
```

The assertion itself is a JWT the server constructs and signs *itself*, using the service account's own private key:

```ts
const header = { alg: 'RS256', typ: 'JWT' };
const claims = {
  iss: config.clientEmail,        // the service account's own address — it is both signer and subject
  scope: GOOGLE_DRIVE_SCOPE,
  aud: GOOGLE_TOKEN_URL,           // https://oauth2.googleapis.com/token — Google's own recipient
  iat: nowSeconds,
  exp: nowSeconds + 3600,          // Google's own maximum for this grant
};
// no `sub` — see delegation below
```

POST that assertion to the token endpoint, and Google returns a bearer access token — **no refresh token at all.** There is nothing to refresh: the server can mint a fresh assertion and trade it for a new access token any time, using nothing but a key it already holds locally. This is the structural reason the 7-day Testing-mode refresh expiry simply doesn't apply — that expiry is a property of *refresh tokens*, and this flow has none.

### RS256, and why it has to be asymmetric

Three-legged OAuth's token refresh uses `client_secret` — a **shared** secret Google also holds, appropriate when both parties already have an established, pre-registered relationship (`client_id`/`client_secret` were issued together). The JWT-bearer grant instead has the server *sign* the assertion with its own private key and lets Google *verify* it against the public key it already has on file for that service account (uploaded, or generated, when the service account was created). Signing and verifying use different keys — that's what "asymmetric" buys here: the private key never has to leave the server that holds it, and possessing the public key (which Google already has) is not enough to forge a valid assertion.

`node:crypto`'s `createSign('RSA-SHA256')` does the actual work — no SDK needed, because RSA-SHA256 signing is a primitive Node ships, not a Google-specific algorithm:

```ts
const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
const signature = createSign('RSA-SHA256').update(signingInput).sign(config.privateKeyPem, 'base64url');
```

### PKCS#8 vs PKCS#1, and why the format matters

The private key Google hands you in the downloaded JSON key file is a **PKCS#8** PEM — it begins `-----BEGIN PRIVATE KEY-----`, a generic container format that can wrap an RSA key, an EC key, or others, with the key type declared inside the DER structure itself. This is distinct from the older **PKCS#1** format (`-----BEGIN RSA PRIVATE KEY-----`), which is RSA-specific and carries no algorithm identifier at all — a parser has to already know it's looking at RSA. Node's `crypto.createSign(...).sign()` accepts either, since `KeyObject` inspection auto-detects the format from the PEM header, but validating that a configured key actually starts with the PKCS#8 marker catches the single most common transcription mistake early: pasting the wrong field from the JSON key, or pasting the whole JSON object instead of extracting `private_key`. Both produce a string that fails only when a signature is actually attempted — a confusing 502 during a folder sync hours after misconfiguration, rather than an immediate, actionable error at connect time.

### No `sub` claim — delegation by sharing, not by impersonation

A JWT-bearer assertion *can* carry a `sub` claim naming a specific user the service account should act **as** — Google calls this domain-wide delegation, and it requires a Workspace super admin to explicitly authorize the service account's scopes in the Admin console. Two things rule it out here: it doesn't exist at all for personal Gmail accounts (only Workspace), and even where it's available, it's a heavier, admin-gated grant than this feature needs. AutoLedger's service account never impersonates anyone — it authenticates as itself, and the tenant grants it access the ordinary way, by adding its address to a folder's sharing list, exactly as they'd share with a colleague. That's "delegation by sharing" rather than "delegation by impersonation": the access the service account has is precisely the access someone chose to give its address, nothing broader, and revoking it is exactly as simple as un-sharing a folder from any other collaborator.

### One token, every organization — and the thundering herd that implies

Every other secret in this codebase's Drive integration is per-org: each tenant's OAuth connection has its own refresh token. A service account is different by design — **one** credential serves every tenant that has shared a folder with it. That collapses what would otherwise be N per-org token refreshes into one shared token, but it also means a naive implementation mints a fresh assertion and calls Google's token endpoint on *every* sync, for *every* org, on every poll tick — needless load, and needless risk of hitting Google's own rate limits as tenant count grows.

The fix is a module-scope cache keyed by the service account's own email, holding the **in-flight promise**, not just the eventual result:

```ts
const tokenPromises = new Map<string, Promise<CachedToken>>();

export async function getServiceAccountAccessToken(config, fetchImpl = fetch): Promise<string> {
  const existing = tokenPromises.get(config.clientEmail);
  if (existing !== undefined) {
    const token = await existing;
    if (Date.now() < token.expiresAt - SERVICE_ACCOUNT_TOKEN_SKEW_MS) return token.accessToken;
  }
  const mintPromise = mintAccessToken(config, fetchImpl);
  tokenPromises.set(config.clientEmail, mintPromise);   // set BEFORE the first await inside it
  ...
}
```

Caching the *promise* rather than the *token* is what makes this single-flight rather than merely cached: JavaScript's run-to-completion semantics mean a synchronous burst of calls — 20 orgs syncing in the same tick — all execute up to their first `await` before control ever yields back to the event loop. The first caller sets the promise into the map and only *then* hits its own `await`; every subsequent caller in that same synchronous burst finds the promise already there and awaits the shared result instead of starting its own mint. Twenty concurrent callers on a cold cache produce exactly one HTTP request to Google, not twenty — this is provable, and is exactly what `serviceAccountAuth.test.ts` asserts (`expect(fetchImpl).toHaveBeenCalledTimes(1)`).

The cache treats a token as expired `SERVICE_ACCOUNT_TOKEN_SKEW_MS` (60 seconds) before its real 3600-second expiry, so a caller never receives a token that expires mid-request. This single-flight guarantee is deliberately *not* extended to the expiry-triggered re-mint path — a handful of concurrent callers each starting their own mint right at the hourly boundary is accepted as a minor, infrequent cost rather than engineering a fully race-free re-mint for an event that happens once an hour.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| **Service account, JWT-bearer grant** | One global credential (below); tenant must be comfortable sharing with an external address | **Chosen as the default** — no consent screen, no Google verification burden, no refresh-token expiry |
| Three-legged OAuth (kept as the secondary path) | Best UX for a single well-known Google account, but restricted-scope verification and Testing-mode's 7-day refresh expiry | Retained, not removed — some Workspace admins block sharing to external `gserviceaccount.com` addresses, so this stays the fallback |
| Domain-wide delegation (`sub` claim) | Removes the need to share anything — the SA can act as any user in the domain | Rejected — needs a Workspace super admin's explicit authorization, doesn't exist for personal Gmail, and is a broader grant than "read one shared folder" needs |
| A public API key on a publicly-shared folder | Genuinely no OAuth of any kind | Rejected outright for an accounting product — it requires the tenant's invoices to be readable by anyone on the internet with the link |
| Store the private key encrypted in the database | Consistent with the OAuth refresh token's own treatment | Rejected — it's one global secret, not per-tenant; encrypting it would still need `INTEGRATION_ENCRYPTION_KEY` in plaintext env to decrypt it, so the ciphertext protects nothing the env var didn't already protect. Plain env, matching `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `VOYAGE_API_KEY` |

## Where it lives in this codebase

- `server/src/services/integrations/googleServiceAccount.ts` — `buildAssertion`, `getServiceAccountAccessToken` (the single-flight cache), `resetServiceAccountTokenCache`
- `server/src/services/integrations/driveConnectionService.ts` — `connectServiceAccount` (no network, no consent — one upsert), `getAccessToken` (the one place either auth mode resolves to a bearer token)
- `server/src/config/env.ts` — `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (the `\n`-escape unescaping, and the PKCS#8-marker validation)
- `server/src/db/migrations/053_platform_drive_integration.sql` — `auth_mode` and the CHECK making the two auth modes' payload shapes mutually exclusive
- `server/src/__tests__/integrations/serviceAccountAuth.test.ts` — assertion shape, RSA signature verification against an in-test-generated keypair, the single-flight proof, cache-key isolation between two service account emails
- `server/src/__tests__/integrations/driveIntake.test.ts` — `connectServiceAccount` needs no network and stores no refresh token; mutual exclusivity with an existing OAuth connection

## Gotchas

- **Never log the assertion, the private key, or the minted access token.** The assertion is self-signed proof of identity for up to an hour; treat it with the same care as the key that produced it.
- **A malformed key must fail at first *use*, not at module import.** `buildAssertion` throws synchronously inside `mintAccessToken`, which only runs when a real Drive action is attempted — so the server and worker still boot cleanly with no service account configured at all, matching the boot posture every other optional provider key in this codebase already has.
- **Google's own error body must never be forwarded.** `mintAccessToken` throws with the HTTP status only (`Google service-account token request failed with status 400`), the identical token-hygiene posture the OAuth refresh path takes.
- **A failed mint must not poison the cache.** If `getServiceAccountAccessToken` cached a *rejected* promise indefinitely, every subsequent call would immediately re-throw the same stale failure forever. The catch block only clears the map entry if it still holds *this* failed attempt — a concurrent successful re-mint may have already replaced it, and clobbering that would be its own bug.
- **The cache key is the service account's email, not a constant.** A test (or a future multi-service-account design) that swaps configs must never receive a token minted for a different `clientEmail` — `serviceAccountAuth.test.ts` asserts this directly.
- **This is a genuinely global secret.** A leak of the private key exposes every tenant's shared folders, not just one org's. There's no rotation tooling for it in this phase — rotating means generating a new key in the Cloud console, updating the env var, and redeploying.

## Interview Q&A

**Q: What is the JWT-bearer grant, and how is it different from the authorization-code flow?**
A: RFC 7523's JWT-bearer grant exchanges a self-signed JWT assertion directly for an access token — no redirect, no user consent, no authorization code. The server signs a short-lived JWT with its own private key, claiming to be a specific identity (`iss`), and Google verifies the signature against the public key it already has on file for that identity. The authorization-code flow exists to get a *user's* consent for access to *their* data; the JWT-bearer grant is for when the caller is authenticating as *itself* — there's no third party's consent to obtain.

**Q: Why does this flow never issue a refresh token, and why does that matter?**
A: There's nothing to refresh — the server can mint a brand-new signed assertion and trade it for a fresh access token any time, using only a key it already holds. Refresh tokens exist specifically to avoid re-running an interactive consent flow every time an access token expires; when there's no interactive flow to avoid, there's no refresh token to issue. That matters concretely here because Google enforces a 7-day refresh-token expiry on an unverified OAuth app in "Testing" status — a rule that only applies to flows that produce refresh tokens in the first place, so a service-account connection is structurally immune to it.

**Q: Explain the difference between PKCS#1 and PKCS#8, and why you validate for the PKCS#8 marker specifically.**
A: PKCS#1 is an RSA-specific private-key format — the PEM header is `RSA PRIVATE KEY`, and a parser has to already assume it's looking at an RSA key since the format carries no algorithm identifier. PKCS#8 is a generic wrapper that can hold any key type, with the algorithm declared inside the structure — its header is plain `PRIVATE KEY`. Google's downloaded service-account key is PKCS#8. I validate for that specific marker at config-load time because the actual failure mode of a wrong or malformed key is a `crypto.createSign(...).sign()` throw deep inside a background sync job hours later — a confusing 502 with no obvious cause. Catching the shape mismatch immediately, with a message naming exactly which field to check, moves that failure to the moment someone pastes the wrong string.

**Q: Why no `sub` claim, and what would adding one actually do?**
A: A `sub` claim requests domain-wide delegation — telling Google "let this service account act as this specific user." That needs a Workspace super admin to explicitly authorize the service account's scopes in the Admin console, and doesn't exist at all for personal Gmail accounts. I don't need it: the service account authenticates as itself, and a tenant grants it exactly the access they choose by sharing a folder with its address — the same mechanism they'd use to share with a colleague. Adding `sub` would be requesting a broader, admin-gated capability to solve a problem "read one folder someone chose to share" doesn't have.

**Q: Walk me through the single-flight caching and why it actually works with plain async/await, no lock.**
A: The cache stores the in-flight *promise*, not the eventual token, and — critically — it's stored into the map *before* the async mint function's first `await`. JavaScript is single-threaded with run-to-completion semantics: when a synchronous burst of calls happens (say, twenty organizations' syncs firing in the same poll tick), the first call executes synchronously all the way to its own first `await`, and setting the promise into the cache happens on that synchronous path, before control ever returns to the event loop. So by the time the second call runs, the promise is already there for it to find and await instead of starting its own mint. No lock is needed because there's no point where two callers are both mid-flight *without* one of them having already published its promise for the other to see.

**Q: What's the actual security boundary if this one key leaks, and how does that compare to the per-org OAuth refresh tokens?**
A: It's strictly worse in blast radius — a leaked service-account key exposes every tenant's shared folders at once, whereas a leaked per-org OAuth refresh token only exposes that one tenant's Drive access. That's the honest cost of the "one credential, no consent screen" simplicity. The mitigations available are standard environment-secret hygiene (never committed, injected at deploy time, rotatable by regenerating the key in the Cloud console) rather than anything special this feature does — there's no rotation tooling built for it in this phase, which I'd flag as the first thing worth adding if this went to real production scale.

## Follow-ups they'll dig into

- *"What happens if a tenant un-shares the folder from the service account?"* The next sync's `files.list` call simply returns nothing new (or a 404 on `getFolder` for a brand-new folder attempt) — there's no explicit revocation signal, since the service account never held a token scoped to that one folder; access was always evaluated live by Drive's own permission check at request time.
- *"Could you support multiple service accounts, say one per customer tier?"* The cache is already keyed by `clientEmail`, so the mechanism scales to N service accounts with no change — the current single-service-account default is a product decision (one connect flow to build and support), not a technical ceiling.
- *"How would you rotate the key without downtime?"* Not built here — the honest answer is generating a new key in the Cloud console (Google supports multiple active keys per service account simultaneously), deploying the new value, confirming syncs succeed, then deleting the old key from the Cloud console once traffic has fully cut over.
- *"Why 3600 seconds for the assertion's `exp`, not something else?"* That's Google's own documented maximum for this grant — the token endpoint rejects an assertion whose `exp` claims a longer lifetime.

## See also

- [oauth2-pkce-and-secrets-at-rest.md](oauth2-pkce-and-secrets-at-rest.md) — the three-legged flow this replaces as the default, retained as the fallback
- [jwt-and-refresh-rotation.md](jwt-and-refresh-rotation.md) — this platform's own JWTs are a completely different use (session auth, HMAC-signed, symmetric secret) from the RSA-signed, self-asserted identity JWT here — worth being able to distinguish the two out loud
- [modular-monolith-app-namespacing.md](../architecture/modular-monolith-app-namespacing.md) — how a Drive file authenticated this way is then routed to the app that owns its folder's purpose
