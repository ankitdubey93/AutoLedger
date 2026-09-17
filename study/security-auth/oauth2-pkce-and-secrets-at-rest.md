# OAuth 2.0 Authorization Code + PKCE, and Secrets at Rest

> A leaked authorization code is useless without the verifier only this server ever held. A leaked ciphertext is useless without the key it never sits beside.

**Category:** Security
**Introduced by:** Phase 19.2 — AP-Flow's Google Drive folder intake (OAuth path retained, secondary, in Phase 19.3)
**Verified against:** Node 24.4.1, `node:crypto`, no OAuth library — hand-rolled over `fetch`

---

## Mechanism

### The authorization code flow, and the problem PKCE solves

A third-party OAuth flow (Google, in this case) has four legs:

1. **Authorize** — redirect the browser to Google with `client_id`, `redirect_uri`, `scope`, and a `state` value the server invented. The user consents at Google's own domain, never ours.
2. **Callback** — Google redirects back to `redirect_uri` with a short-lived `code` and the same `state`. This request carries **no session** — it is the user's browser, but it arrived via a 302 from `accounts.google.com`, not from an authenticated API call.
3. **Exchange** — the server POSTs `code` (plus `client_id`/`client_secret`) to Google's token endpoint and receives an access token and a refresh token.
4. **Use** — the refresh token mints access tokens indefinitely, until revoked.

The classic attack this flow is vulnerable to without a mitigation: an authorization code is a bearer credential in transit through a browser redirect — a malicious app on the same device, or a network intermediary, can intercept it and race the exchange. Google issued the code to *this browser*, but nothing ties the *exchange* to *this server*.

**PKCE (RFC 7636) closes that gap with a value the browser never carries.** Before redirecting, the server generates a random `verifier` and derives a `code_challenge = base64url(SHA-256(verifier))`. The challenge — not the verifier — goes in the authorization URL. At exchange time, the server sends the raw `verifier` alongside the code; Google recomputes the hash and checks it matches the challenge it was given at authorize time. An attacker who intercepts the code in the browser redirect never sees the verifier — it never left the server — so the stolen code is exchangeable only by whoever holds a value that was never transmitted where it could be intercepted.

```ts
// utils/pkce.ts
export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');   // the state AND the verifier both use this
}
export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');   // S256 — RFC 7636's only mandatory method
}
```

`S256`, not the RFC's alternative `plain` method (where the challenge equals the verifier): `plain` buys nothing over sending no challenge at all, since anyone who sees the challenge in the authorize URL then already holds the "secret" needed at exchange. `S256` is the only method that keeps the two values distinct.

### `state`: two jobs, one value

`state` is the traditional CSRF binding — it proves the callback correlates with a request this server actually initiated, not a forged redirect an attacker constructed pointing at the same callback URL. In Phase 19.2 it does a **second** job: because the callback carries no session, `state` is the *only* thing connecting the request back to an organization. There is no `req.user` to read the org from — the org comes from whichever row's `oauth_state_sha256` matches.

```ts
// driveConnectionService.ts's completeConnect
const { rows } = await client.query(
  `SELECT id, org_id, pkce_verifier_ciphertext FROM integration_drive_connections
    WHERE oauth_state_sha256 = $1 AND status = 'PENDING_AUTH' AND oauth_state_expires_at > now()
    FOR UPDATE`,
  [sha256Hex(state)],
);
```

This is guardrails rule 1's one documented exception in this codebase where a query has no `org_id` predicate: the state hash **is** the credential, bound to exactly one org at `startConnect` time by an authenticated OWNER/ADMIN. Nothing about that changes how it must be handled — it is still treated as bearer material, hashed before storage (below), single-use (cleared atomically before any Google call), and time-boxed (`oauth_state_expires_at`, 10 minutes).

### Why only a hash of `state` is stored, never the value

The database is the thing most likely to be dumped, backed up somewhere less guarded, or exposed by a future SQL-injection bug elsewhere in the app. If the *raw* `state` sat in a column, whoever obtained that dump could replay it directly — no PKCE verifier needed, since `state` alone is the join key the completion query matches on. Storing `sha256Hex(state)` means a database leak yields a hash that authorizes nothing: the actual `state` value only ever exists in the URL the browser was redirected with and in the callback request, never at rest.

The PKCE **verifier**, by contrast, genuinely needs to be retrieved later — it goes to Google unmodified, and there is no substitute value Google would accept instead. It cannot be reduced to a hash. So it is encrypted rather than hashed (below), the resolution for anything that must be *read back* rather than merely *compared against*.

### AES-256-GCM: what the IV and tag actually buy

```ts
// utils/secretBox.ts
export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}
```

AES-GCM is authenticated encryption: it produces both ciphertext and a 16-byte **authentication tag**, and `decryptSecret` calls `setAuthTag` before decrypting, so `decipher.final()` throws if a single byte of the ciphertext (or the tag itself) has been altered. Without the tag, GCM degenerates to a stream cipher — an attacker who can flip bits in the ciphertext flips the corresponding bits in the recovered plaintext, undetected. The tag turns "confidentiality" into "confidentiality + integrity": a tampered ciphertext is not silently decrypted wrong, it fails loudly.

**The 12-byte IV must be random and must never repeat under the same key.** GCM's security proof assumes a nonce is used at most once; two encryptions under the same (key, IV) pair leak the XOR of their plaintexts and, with GCM specifically, can leak the authentication key entirely — a catastrophic, not graceful, failure. Generating a fresh `randomBytes(12)` per call, rather than deriving the IV from a counter or timestamp, means the only thing that would repeat it is chance (a birthday-bound risk, astronomically small at 96 bits for the volume of tokens this table will ever hold).

The `v1.` prefix versions the format itself. If the encryption scheme ever changes — a different cipher, a different IV length — new ciphertexts carry `v2.` and `decryptSecret` can dispatch on the prefix, so a migration can re-encrypt old rows lazily rather than needing a flag-day cutover.

### Why the encryption key is a plain env var, not itself encrypted

`INTEGRATION_ENCRYPTION_KEY` sits in `server/.env`, unencrypted, exactly like `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`. This looks inconsistent with encrypting the tokens it protects until you ask what would encrypt the key: another key, which needs storing somewhere, which needs *its* own key. The chain has to bottom out somewhere, and the bottom is a secret held outside the database entirely — an env var, injected at deploy time, never committed. `secretBox` protects **tenant-supplied** secrets (a refresh token issued to *this org's* Google account) from a database-only compromise; the master key's own protection is an infrastructure concern (deploy-time secret injection, `.env` never committed), not a schema one.

### Why these two tables are exempt from the audit trail

AutoLedger's CDC audit trail (`audit_row_change`, Phase 5) snapshots `to_jsonb(NEW)` on every insert/update to an audited table, appending it to `audit_logs` forever. If `integration_drive_connections` carried that trigger, every `refresh_token_ciphertext` — encrypted, but still a working credential once decrypted — would be copied into an **append-only** log the moment it was written. `audit_logs` has no retention policy (a deliberate, documented gap), so that copy would outlive every rotation, every disconnect, every intentional deletion of the original row. An encrypted secret is still a secret, and CDC must never become the second place it can leak from. Migration 052's header comment states this explicitly, and it survives unchanged into 053's rename.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Store the raw `state` value | Simpler query (`WHERE oauth_state = $1` on the plain value) | Rejected — a database leak becomes directly replayable |
| Store the PKCE verifier as a hash, like `state` | Consistent treatment | Rejected — Google needs the *actual* verifier at exchange time; a hash cannot be un-hashed to produce it |
| Encrypt the verifier with a per-row key | No shared master key to protect | Rejected — the per-row key needs storing too, and now there are two secrets to protect instead of one |
| **Hash `state` (compare-only), encrypt the verifier and refresh token (read-back needed), one master key in env** | The master key's protection is an infra concern outside this code | **Chosen** |
| Skip PKCE, rely on `client_secret` alone | One fewer moving part | Rejected — `client_secret` is validated only at the token endpoint; it does nothing to stop a code intercepted in transit from being exchanged by whoever grabs it first |
| CDC-audit these tables like everything else | Consistency with every other table | Rejected — see the audit-exemption reasoning above |

Guardrails rule 11 governs token hygiene generally (this file's own header comment: "no log line, error message, or return value ever includes a token, verifier, state, key, or ciphertext").

## Where it lives in this codebase

- `server/src/utils/pkce.ts` — `randomUrlToken`, `pkceChallengeS256`, `sha256Hex`
- `server/src/utils/secretBox.ts` — `encryptSecret` / `decryptSecret`, the `v1.` format
- `server/src/services/integrations/driveConnectionService.ts` — `startConnect` (mints state + verifier), `completeConnect` (the rule-1 exception, claim-before-network ordering)
- `server/src/services/integrations/googleDriveClient.ts` — `buildAuthorizationUrl`, `exchangeCode`, `refreshAccessToken` — the actual Google REST calls, no SDK
- `server/src/db/migrations/052_ap-flow_drive_intake.sql` / `053_platform_drive_integration.sql` — the CHECK constraints holding the three OAuth-state columns and the auth-mode payload mutually exclusive, and the audit-exemption comment
- `server/src/__tests__/integrations/driveIntake.test.ts` — `startConnect` stores only a hash and an encrypted verifier; `completeConnect` stores an encrypted refresh token; a state works only once; an expired state is rejected
- `server/src/__tests__/secretBox.test.ts` — round-trip, tamper detection, wrong-key rejection

## Gotchas

- **Claim before network, always.** `completeConnect` clears the OAuth-state columns in a transaction that commits *before* the call to Google — never holds a transaction open across an external HTTP round trip (guardrails rule 5). If the network call then fails, the state is already spent and the user must restart the flow; that is the correct trade against the alternative (a held transaction blocking the connection row for the duration of a Google outage).
- **`SELECT ... FOR UPDATE` then a separate `UPDATE`, never `UPDATE ... RETURNING` in one statement.** `RETURNING` reflects post-update values — nulling `pkce_verifier_ciphertext` in the same statement that reads it back would always return `NULL`. The row lock from `FOR UPDATE` still makes the pair atomic against a concurrent `completeConnect` for the same state: the second transaction blocks on the lock, and once the first commits, re-evaluates its own `WHERE oauth_state_sha256 = $1` against the now-`NULL` column and correctly finds nothing.
- **A CHECK constraint enforces "all three OAuth-state columns null together, or all three set together."** A partial write (state hash present, verifier ciphertext absent) is a bug — the constraint makes it impossible to persist rather than merely undesirable.
- **Never echo Google's own error text to the client.** The callback controller redirects to `?drive=error` on any failure without forwarding what Google said — Google's error payloads can include diagnostic detail about the client configuration.
- **`google_account_email` is lowercased before storage and comparison** — the same UNIQUE-on-`LOWER(email)` discipline rule 9 requires for the platform's own user emails, since Google's returned casing is not guaranteed stable.

## Interview Q&A

**Q: What problem does PKCE actually solve, given the exchange also needs a `client_secret`?**
A: `client_secret` authenticates the *server* to the token endpoint — it says "a legitimate client application is asking," but it's the same value on every exchange, so it does nothing to stop a *specific* intercepted authorization code from being redeemed by whoever grabs it first. PKCE binds one particular authorization request to one particular exchange: the challenge sent at authorize time can only be matched by presenting the verifier that produced it, and that verifier never travels through the browser redirect where a code can be intercepted. They protect against different things — `client_secret` proves "a real client," PKCE proves "the same client that started this specific flow."

**Q: Why SHA-256 the `state` value instead of storing it directly?**
A: Because `state` is the credential for a session-less callback — whoever presents the matching value gets treated as the same request that started the flow. If the raw value sat in the database, a leak of that table (backup, dump, an unrelated injection bug) would hand out directly-replayable credentials. Hashing it means the stored value authorizes nothing on its own; only the original, ephemeral `state` — which lives in a URL and a callback query string, never at rest — can produce a match.

**Q: The verifier can't be hashed the same way. Why not?**
A: Because Google needs the actual verifier bytes at exchange time to recompute the challenge and compare — a hash is one-directional, you can't reconstruct the verifier from it. Anything that must be read back and used later has to be reversibly protected, so it's encrypted (AES-256-GCM) rather than hashed. The rule I'd state: hash what you only ever compare against; encrypt what you have to hand back to someone else.

**Q: Walk me through what the authentication tag in AES-GCM actually buys you.**
A: GCM is a stream cipher under the hood — without the tag, an attacker who can modify ciphertext bytes in transit or at rest flips the corresponding bits in the decrypted plaintext, and the decryption succeeds silently with corrupted output. The tag is a MAC computed over the ciphertext during encryption; on decrypt, the tag is verified before the plaintext is returned, so any tampering — even a single flipped bit — causes decryption to throw instead of returning garbage. It converts confidentiality-only encryption into confidentiality-plus-integrity.

**Q: Why does the IV have to be random, and what actually breaks if it isn't?**
A: GCM's security proof assumes a (key, IV) pair is never reused. Reuse leaks the XOR of the two plaintexts directly, and because GCM derives its authentication key from encrypting the all-zero block under that same (key, IV), reusing the pair can also let an attacker recover the authentication key itself — at which point they can forge valid ciphertexts for anything under that key. Generating a fresh 12-byte random IV on every call means the only way to repeat one is chance, and at 96 bits of randomness that's not a practical risk for the volume of secrets this table holds.

**Q: You have a two-key story here — an env-var master key and per-row encrypted secrets. Why not encrypt the master key too?**
A: Because it has to bottom out somewhere. If I encrypt the master key, I need a key for *that*, and now I've added a layer of indirection that protects nothing new — whoever can read the new key can decrypt everything anyway. The actual protection for the master key is operational: it's injected at deploy time as an environment variable, never committed to the repo, and never written to the database at all. `secretBox`'s job is narrower and more useful: protecting *tenant-supplied* secrets from a database-only compromise, on the assumption that the environment itself is a separate, better-guarded boundary.

**Q: Why are these two tables excluded from your audit trail, when you audit almost everything else?**
A: The audit trigger snapshots the whole row into an append-only log with no retention policy. If it fired here, an encrypted refresh token would get copied into `audit_logs` on every write, and it would outlive the original row forever — disconnecting, rotating, or deleting the connection wouldn't remove the copy. An encrypted secret is still a secret; CDC has to never be the second place it can leak from. It's a narrow, deliberate exception, documented in the migration itself so nobody re-adds the trigger without re-deriving why it's missing.

## Follow-ups they'll dig into

- *"What if the callback never arrives — does the `PENDING_AUTH` row leak forever?"* `oauth_state_expires_at` bounds it to 10 minutes; a stale `PENDING_AUTH` connection is simply overwritten the next time that org calls `startConnect` (`ON CONFLICT (org_id) DO UPDATE`).
- *"Two browser tabs both start the OAuth flow for the same org — what happens?"* The second `startConnect` overwrites the first's state hash and verifier (same `ON CONFLICT` upsert). The first tab's authorization URL, if used, now matches no row — Google's callback finds nothing at `completeConnect` and correctly reports `400 Invalid or expired authorization state`.
- *"How would you rotate `INTEGRATION_ENCRYPTION_KEY` without breaking every stored token?"* Not built here — the honest answer is it would need a migration that decrypts every ciphertext under the old key and re-encrypts under the new one inside a single maintenance window, since there is no dual-key decrypt-with-either-key support today.
- *"Why is `state` 256 bits (32 random bytes) rather than a UUID?"* A UUIDv4 has 122 bits of actual randomness; 32 raw random bytes is deliberately generous headroom for a value whose entire security property rests on being unguessable.

## See also

- [jwt-and-refresh-rotation.md](jwt-and-refresh-rotation.md) — the platform's own token story; same access/refresh-shaped tension between statelessness and revocability
- [service-accounts-and-jwt-bearer.md](service-accounts-and-jwt-bearer.md) — the alternative Google auth path that needs none of this
- [composite-foreign-keys-for-tenancy.md](../postgresql/composite-foreign-keys-for-tenancy.md) — how `integration_drive_folders` stays tenant-scoped despite the connection's own rule-1 exception
