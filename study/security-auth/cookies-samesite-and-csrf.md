# Cookies, SameSite & CSRF

> `localhost:5173` → `localhost:5000` is cross-**origin** but same-**site**, and that one distinction decides the entire auth transport design.

**Category:** Security
**Introduced by:** Phase 1 — httpOnly session cookies across the Vite/Express port split
**Verified against:** Chrome 141, Express 5.2, `cookie-parser` 1.4.7

---

## Mechanism

### Origin is not site

Two different scopes, constantly confused:

**Origin** = scheme + host + **port**. Exact triple. `http://localhost:5173` and `http://localhost:5000` are *different origins* — which is why this project needs CORS at all.

**Site** = scheme + **registrable domain** (eTLD+1). **The port is not part of it.** The registrable domain comes from the [Public Suffix List](https://publicsuffix.org/): for `app.example.co.uk` the public suffix is `co.uk`, so the site is `example.co.uk`.

So `localhost:5173` → `localhost:5000` is **cross-origin but same-site**. `SameSite=Lax` cookies are therefore sent on every request between them, including the cross-origin `POST` from the login form. That is the load-bearing fact that lets a Vite dev server on one port and Express on another share a cookie session with no proxy — and it holds in the likely production topology too, since `app.example.com` → `api.example.com` are also same-site.

**The trap: `127.0.0.1` is not in the Public Suffix List, so it is its own site.** Point `VITE_API_BASE_URL` at `http://127.0.0.1:5000` while the page is served from `localhost:5173` and it becomes genuinely cross-site — every `Lax` cookie is silently withheld, every authenticated request 401s, and there is no CORS error to explain it because CORS is a different mechanism entirely. It looks exactly like broken auth. It is now a troubleshooting row in `docs/development.md`.

Modern browsers also implement **schemeful** same-site: `http://example.com` and `https://example.com` are different sites.

### The three SameSite values

| Value | Sent on cross-site… | |
|---|---|---|
| `Strict` | nothing | Following a link from Gmail to your app arrives logged out |
| `Lax` | **top-level GET navigations only** | The default in Chrome since 2020 |
| `None` | everything (requires `Secure`) | Needed for genuinely cross-site embedding |

`Lax` blocks cross-site `POST`, `PUT`, `DELETE`, and all `fetch`/XHR — which is most of CSRF — while still letting an inbound link work.

### The Lax hole that made refresh a POST

`Lax` deliberately **does** send cookies on a top-level cross-site *navigation* — clicking a link, or a `<meta refresh>`, or `window.location = …`. So a `GET` endpoint that changes state is reachable cross-site:

```html
<!-- on evil.example -->
<img src="http://localhost:5000/api/v1/auth/refresh">
```

If `/auth/refresh` were a `GET`, that would rotate the visitor's refresh token. Their own tab then presents the now-spent token, trips reuse detection, and gets logged out everywhere — a CSRF logout, from a bare image tag.

The original `docs/api.md` specified `GET /auth/refresh`. **Phase 1 changed it to `POST`**, which `Lax` will not send cross-site. A state-changing `GET` is wrong on HTTP-semantics grounds anyway; the CSRF angle is what makes it urgent rather than merely untidy.

### httpOnly, and why not localStorage

`httpOnly` makes a cookie invisible to `document.cookie`. Verified in a real browser:

```
=== document.cookie (must NOT contain tokens) ===
""
=== cookies via CDP ===
autoledger_at httpOnly=true path=/ sameSite=Lax
```

The token is present and being sent — the page simply cannot read it.

This is the whole argument against `localStorage`. `localStorage` is plain JavaScript state, so **any** XSS — a compromised npm dependency, a bad `dangerouslySetInnerHTML` — reads it and exfiltrates a working credential. With httpOnly cookies, XSS can still *make requests as the user* while the page is open, which is bad, but it cannot steal a token to replay later from elsewhere. That difference matters a lot during incident response.

The trade: cookies are attached automatically, which is what creates CSRF exposure in the first place. `localStorage` + an `Authorization` header is CSRF-immune but XSS-fragile. **You are choosing which attack to be vulnerable to**, and XSS-resistance is the better trade because XSS is far more common than CSRF now that `Lax` is the browser default.

### Path scoping and the clearCookie trap

The refresh cookie is scoped to `Path=/api/v1/auth`, so it is not attached to ordinary API calls and cannot leak through a proxy log or a request dump from any other endpoint.

That scoping introduces a genuinely nasty failure mode. **`res.clearCookie` does not delete anything** — it sets the same cookie with an expiry in the past, and the browser only matches it to the existing cookie if `path`, `domain`, `secure`, `httpOnly` and `sameSite` all agree. Clear a `Path=/api/v1/auth` cookie at the default `Path=/` and **nothing happens**: logout returns 200, the UI updates, and the cookie is still sitting there.

The mitigation is structural rather than remembered — one module, `utils/cookies.ts`, derives both the set and the clear from the same options objects, and nothing else in the codebase calls `res.cookie`. There is a test asserting the logout `Set-Cookie` carries the right `Path`.

### CSRF, mechanically

CSRF works because the browser attaches cookies to requests **the destination site did not initiate**. `evil.example` submits a form to `yourbank.example/transfer`; the cookie rides along; the server sees a fully authenticated request. The attacker never reads the response — they only need the side effect.

Phase 1's posture is defence in depth rather than a token scheme:

1. **`SameSite=Lax`** — blocks cross-site POST/fetch outright. The primary defence.
2. **CORS with a single pinned origin** — `cors({ origin: env.FRONTEND_URL, credentials: true })`. `credentials: true` also *forbids* a wildcard origin, which is why `FRONTEND_URL` is mandatory at boot.
3. **JSON-only bodies** — an HTML form can only send `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`. It cannot send `application/json` without triggering a preflight it will fail. So the classic no-JavaScript form-POST attack cannot reach a JSON handler at all.

No `csurf` — it is deprecated and unmaintained, and rule 14 defers new dependencies regardless. Double-submit tokens are deferred, and that is written down in `docs/api.md` rather than left as an assumption.

### Cookies ignore ports

Cookies are keyed by **name + domain + path** — the port is not part of the key. Every app on `localhost` shares one jar, so a cookie named `access_token` from any other project on your machine would clobber this one. Hence `autoledger_at` / `autoledger_rt`.

Note the asymmetry: the port is irrelevant for *cookies* and for *same-site*, but decisive for *origin* and therefore CORS.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `localStorage` + `Authorization` header | CSRF-immune; any XSS steals a replayable token | Rejected |
| `SameSite=Strict` | Strongest; an inbound link lands logged out | Rejected — bad UX for no gain given Lax already blocks cross-site POST |
| `SameSite=None; Secure` | Needed only for genuine cross-site use | Rejected — unnecessary here, and strictly weaker |
| **`httpOnly` + `SameSite=Lax` + pinned CORS** | Needs the same-site reasoning to be correct | **Chosen** |
| Vite proxy (`/api` → :5000, same origin) | Sidesteps CORS entirely | Rejected — hides a real cross-origin setup behind dev-only config; better to configure CORS honestly and match production |

## Where it lives in this codebase

- `server/src/utils/cookies.ts` — the only module that sets or clears auth cookies
- `server/src/config/constants.ts` — cookie names, `REFRESH_COOKIE_PATH`, TTLs
- `server/src/app.ts` — `cookieParser()` before the routes; `cors({ credentials: true })`
- `server/src/routes/auth.ts` — `POST /refresh`, with the reasoning inline
- `client/src/services/fetchServices.ts` — `credentials: 'include'`, without which the browser omits cookies on a cross-origin fetch

## Gotchas

- **`credentials: 'include'` is required on the client.** A cross-origin `fetch` omits cookies by default, even same-site ones. Easy to miss because it fails as a 401, not as a visible cookie problem.
- **`clearCookie` must match the original attributes** — otherwise logout silently no-ops.
- **`Secure` cookies are allowed on `http://localhost`** (browsers treat localhost as a trustworthy origin), so `secure: env.isProduction` is about correctness in production, not a localhost workaround.
- **`__Host-` prefix** enforces `Secure` + `Path=/` + no `Domain`. Good production hardening, but it conflicts with the path-scoped refresh cookie and behaves inconsistently on plain-http localhost. Deferred.
- **A CORS error and a missing cookie look nothing alike.** CORS failures shout in the console; a `SameSite` mismatch is silent and surfaces as a 401.

## Interview Q&A

**Q: Your frontend is on port 5173 and your API on 5000. Do SameSite cookies work?**
A: Yes, and the reason is the origin/site distinction. Origin includes the port, so those are different origins — hence CORS. But *site* is scheme plus registrable domain and ignores the port, so both are `localhost` and the request is same-site. `SameSite=Lax` cookies are sent on all methods between them. The trap is mixing `localhost` and `127.0.0.1`: IP literals aren't in the Public Suffix List, so each is its own site, and that combination silently drops every cookie with no CORS error to explain it.

**Q: httpOnly cookies or localStorage for tokens?**
A: httpOnly cookies, and it's explicitly choosing which attack to be exposed to. localStorage is readable by any JavaScript, so a single XSS — one compromised dependency — exfiltrates a working token the attacker replays from anywhere. httpOnly means XSS can still act as the user while the page is open, but can't steal a portable credential. The cost is that cookies are attached automatically, which creates CSRF exposure — and `SameSite=Lax` plus pinned CORS handles that. XSS is the more common attack today, so I'd rather be resistant to it.

**Q: Explain CSRF and how you're mitigating it.**
A: The browser attaches cookies to requests the destination didn't initiate, so a form on `evil.example` posting to your API arrives fully authenticated — the attacker never reads the response, they just want the side effect. Three layers here: `SameSite=Lax` blocks cross-site POST and fetch outright; CORS is pinned to one origin with `credentials: true`, which also forbids a wildcard; and every endpoint takes JSON, which an HTML form can't send without a preflight it will fail. No csurf — it's deprecated, and Lax being the browser default has moved the risk profile a long way.

**Q: You changed refresh from GET to POST. Why does that matter?**
A: Because `SameSite=Lax` deliberately still sends cookies on top-level cross-site *navigations*. As a GET, `/auth/refresh` was reachable from an `<img>` tag or a plain link on any site — that rotates the victim's refresh token, so their own tab then presents a spent token, trips reuse detection, and they get logged out everywhere. A CSRF logout from an image tag. POST isn't sent cross-site under Lax. A state-changing GET is wrong on HTTP semantics anyway; the CSRF angle made it urgent.

**Q: Tell me about a subtle bug in cookie handling.**
A: `res.clearCookie` doesn't delete a cookie — it sets an expired one, and the browser only matches it if path, domain, secure, httpOnly and sameSite all agree. Our refresh cookie is scoped to `/api/v1/auth`, so clearing it at the default path silently does nothing: logout returns 200, the UI updates, and the cookie is still there. I made it structurally impossible rather than something to remember — one `utils/cookies.ts` module derives set and clear from the same options objects, nothing else calls `res.cookie`, and there's a test asserting the logout `Set-Cookie` carries the right Path.

**Q: Why prefix the cookie names?**
A: Cookies are keyed by name, domain and path — the port isn't part of the key. So every app on localhost shares one jar, and a generic `access_token` from another project would clobber ours. `autoledger_at` makes collisions impossible. It's the mirror image of the origin rule: the port is irrelevant for cookies and same-site, but decisive for CORS.

## Follow-ups they'll dig into

- *"What if the API is on a genuinely different domain?"* Then it's cross-site and you need `SameSite=None; Secure` — which reopens CSRF, so you add double-submit tokens or move to bearer tokens with the XSS trade-off.
- *"How does the SPA know it's logged in if it can't read the cookie?"* It asks: `GET /auth/check`. That's also why the response carries `accessTokenExpiresAt`.
- *"What does `__Host-` buy?"* Enforced `Secure` + `Path=/` + no `Domain`, so a subdomain can't set a cookie your main domain honours.
- *"Does `SameSite=Lax` protect a GET that changes state?"* No — that's exactly the hole above.
- *"Subdomain takeover?"* Cookies scoped with `Domain=.example.com` are sent to every subdomain, so one compromised subdomain sees them. Host-only cookies avoid it.

## See also

- [jwt-and-refresh-rotation.md](jwt-and-refresh-rotation.md) — what these cookies carry
- [api-versioning.md](../architecture/api-versioning.md) — how `/api/v1/auth` gets its mount path
