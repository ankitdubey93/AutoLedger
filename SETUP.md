# SETUP — running AutoLedger on a fresh machine

Everything needed to go from a blank OS to a running stack. Written for a Linux
box (the project is developed on Ubuntu); macOS notes are inline where the two
differ. Windows is untested — use WSL2 and follow the Linux path inside it.

The project's day-to-day reference is [docs/development.md](docs/development.md).
This file is the bootstrap: what a machine with *nothing* on it needs, in order,
plus what has to be rescued off the old machine first.

---

## 0. Before you wipe the old machine

Not everything that matters is in git. Do all four, in order.

### 0.1 Push every commit

```bash
cd /path/to/AutoLedger
git status                 # must be clean
git log origin/main..HEAD  # must be empty — anything listed is NOT on GitHub
git push origin main
```

An unpushed commit is gone forever after a format. Check this twice.

### 0.2 Copy the three `.env` files somewhere safe

`.env`, `server/.env` and `client/.env` are gitignored on purpose — they carry
token secrets and API keys. **Never commit them.** Copy them to a password
manager, an encrypted USB stick, or a private note:

```bash
cat .env server/.env client/.env
```

Only `server/.env` really matters. The two token secrets can be regenerated
(existing sessions just get logged out), but these cannot be regenerated for
free and would have to be re-issued from each provider's console:

- `ANTHROPIC_API_KEY` — AP-Flow vision extraction
- `GEMINI_API_KEY` — AP-Flow's alternate provider
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` — Drive intake
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `INTEGRATION_ENCRYPTION_KEY` — Drive OAuth path

If you also downloaded a Google service-account JSON key file, save that too.

### 0.3 Dump the database, if you want your data back

The dev data lives in the Docker volume `postgres-data`, which a format
destroys. Skip this if you're happy starting from an empty database — the easier path.

```bash
docker compose up -d postgres          # if not already running
docker exec autodb_postgres pg_dump -U autodb_user -d autodb > ~/autodb-backup.sql
```

Copy `~/autodb-backup.sql` off the machine. Restoring it is §6.

### 0.4 Copy `server/storage/` if you dumped the database

The Document Vault (Phase 9.5) stores uploaded file bytes on disk, **not** in
Postgres — `server/storage/<org_id>/<ab>/<cd>/<sha256>`. It is gitignored. A
database restore without it leaves every document row pointing at bytes that
no longer exist.

```bash
tar czf ~/autoledger-storage.tar.gz -C server storage
```

`server/.tesseract/` (the downloaded OCR language model, ~15 MB) is **not**
worth saving — it re-downloads itself on first real OCR use.

---

## 1. Prerequisites on the new machine

| Need | Why | Check |
|---|---|---|
| **git** | clone the repo | `git --version` |
| **Node 22 or newer** | the server, worker and client all run on the host (`server/package.json` pins `engines.node >= 22`; developed on Node 24) | `node -v` |
| **Docker Engine + Compose v2 plugin** | Postgres and Redis run as containers; `dev.sh` refuses to start without `docker compose` | `docker compose version` |
| **openssl** | generating the two token secrets (preinstalled almost everywhere) | `openssl version` |

There is **no** `server/Dockerfile`, no `client/Dockerfile`, no `entrypoint.sh`.
Infrastructure is containerised; the application processes are not. That is a
deliberate choice — [docs/development.md § Why not full Docker](docs/development.md#why-not-full-docker).

### 1.1 Node

Use nvm so the version is per-user and upgradable:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL -l
nvm install 22          # or: nvm install 24
nvm alias default 22
node -v && npm -v
```

(macOS alternative: `brew install node@22`.)

### 1.2 Docker

Ubuntu/Debian, using Docker's own repository — the distro's `docker.io`
package ships an old Compose:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Then let your user run Docker without `sudo` (log out and back in, or run
`newgrp docker`, for the group change to take effect):

```bash
sudo usermod -aG docker $USER
newgrp docker
docker run --rm hello-world     # must succeed without sudo
```

(macOS alternative: Docker Desktop, which bundles Compose v2.)

### 1.3 Build tools — probably not needed

`bcrypt`, `sharp` and `pdfjs-dist` are native. All three ship prebuilt binaries
for linux-x64, linux-arm64 and macOS, so `npm ci` normally downloads rather than
compiles. Only if you see node-gyp errors during install:

```bash
sudo apt-get install -y build-essential python3
```

---

## 2. Clone

```bash
mkdir -p ~/Documents/Programming
cd ~/Documents/Programming
git clone https://github.com/ankitdubey93/AutoLedger.git
cd AutoLedger
```

If `./dev.sh` later says "permission denied", the executable bit was lost in
transit: `chmod +x dev.sh`. (It is committed as `100755`, so this should not
happen on a plain clone.)

---

## 3. The three `.env` files

Three files, deliberately separate — the root one is read **only** by
`docker-compose.yml`, `server/.env` by the server and worker processes, and
`client/.env` is inlined into the browser bundle by Vite at build time.

```bash
cp .env.example .env
cp server/.env.example server/.env
cp client/.env.example client/.env
```

If you saved the old files in §0.2, paste those in instead of editing the
examples — then skip to §4.

### 3.1 Generate the two token secrets (required)

The server **refuses to boot** without both. Each must be ≥32 characters and
they must be **different from each other** — one shared key would let a 7-day
refresh token verify as a 15-minute access token.

```bash
openssl rand -hex 32     # paste into ACCESS_TOKEN_SECRET
openssl rand -hex 32     # run it AGAIN, paste into REFRESH_TOKEN_SECRET
```

Put them in `server/.env`:

```ini
ACCESS_TOKEN_SECRET=<first value>
REFRESH_TOKEN_SECRET=<second value>
```

There is no `JWT_SECRET` in this project. Do not reintroduce one
([docs/guardrails.md](docs/guardrails.md) rule 11).

### 3.2 What else is required

Everything else in the copied examples already has a working local default.
The full table is in [docs/development.md § Environment variables](docs/development.md#environment-variables);
the boot-time requirements are:

| File | Variable | Required | Default in the example |
|---|---|---|---|
| root `.env` | `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` | fed to the container | `autodb_user` / `autodb_pass` / `autodb` |
| root `.env` | `PG_PORT`, `REDIS_PORT` | no | `5432`, `6379` |
| `server/.env` | `FRONTEND_URL` | **yes** — server throws at boot | `http://localhost:5173` |
| `server/.env` | `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` | **yes** | must match the root `.env` |
| `server/.env` | `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET` | **yes** | blank — §3.1 |
| `client/.env` | `VITE_API_BASE_URL` | yes | `http://localhost:5000` |

`PG_USER` / `PG_PASSWORD` / `PG_DATABASE` **must agree** between the root and
server files — the root one creates the database user, the server one connects
as it.

`server/src/config/env.ts` collects *every* problem and throws once, so a bad
`.env` gives you the complete list on the first failed boot, not one variable
per restart.

### 3.3 The optional API keys

The server and worker both boot fine with all of these blank. Leaving one unset
degrades exactly one feature to a `503` at the moment it is used; nothing else
breaks, and the test suite never needs any of them.

| Unset | What stops working | What still works |
|---|---|---|
| `ANTHROPIC_API_KEY` | AP-Flow AI extraction | AP-Flow upload, rasterization, local OCR, PII masking, manual review, posting |
| `GEMINI_API_KEY` | only matters if `AP_FLOW_AI_PROVIDER=gemini` | the Anthropic path (the default) |
| `GOOGLE_SERVICE_ACCOUNT_*` | Drive folder intake | direct upload into AP-Flow |

Drive intake needs a one-time Google Cloud setup (service account, JSON key,
share a folder with its address) — the step-by-step is
[docs/development.md § Setting up Drive intake](docs/development.md#setting-up-drive-intake).

---

## 4. Install dependencies

Lockfiles are committed, so use `npm ci` — it installs exactly the locked
versions and is faster than `npm install`:

```bash
(cd server && npm ci)
(cd client && npm ci)
```

Expect a few minutes and roughly 1 GB across both `node_modules` — `sharp`,
`pdfjs-dist`, `tesseract.js` and `@anthropic-ai/sdk` are the heavy ones.

There is no root `package.json`; the two workspaces are installed separately.

---

## 5. First run

From the repository root:

```bash
./dev.sh
```

One command, no arguments. In order it:

1. preflights (compose plugin present, all three `.env` files present, both
   `node_modules` present, ports 5000 and 5173 free) and dies with a specific
   message if anything is missing;
2. starts the `postgres` and `redis` containers and waits for their own compose
   healthchecks — not a sleep;
3. applies all pending migrations (62 of them on a fresh database);
4. runs the server (`:5000`), the background worker, and the Vite client
   (`:5173`) as three colour-prefixed processes.

One `Ctrl-C` stops all three. If any one process dies, the launcher takes the
other two down too — that is deliberate, a half-running stack produces failures
that look like application bugs.

The first `docker compose up` pulls `pgvector/pgvector:pg16` and
`redis:7-alpine` — a few hundred MB, one time.

### 5.1 Verify

```bash
curl http://localhost:5000/api/v1/health
```

Healthy is `200` with `"status":"ok"`, `db.connected: true`, `redis.connected: true`.
A `503` means Postgres is unreachable. Redis being down is `200` +
`"status":"degraded"` — reads all still work, only background jobs stop.

Then open **http://localhost:5173**, register an organization, and you land on
the app chooser with the three available apps.

Use `localhost` everywhere — never mix `localhost` and `127.0.0.1` between the
page origin and `VITE_API_BASE_URL`. They are different sites to the browser,
and every authenticated request will silently 401 with no CORS error to explain
it.

---

## 6. Restoring the old database (only if you did §0.3)

Do this **before** the first `./dev.sh`, into an empty volume — the dump carries
its own schema *and* the `migrations` bookkeeping table, so `npm run migrate`
afterwards correctly becomes a no-op.

```bash
docker compose up -d postgres                     # containers only
docker exec -i autodb_postgres psql -U autodb_user -d autodb < ~/autodb-backup.sql
tar xzf ~/autoledger-storage.tar.gz -C server     # restores server/storage/
./dev.sh
```

If you skipped the dump: nothing to do. `./dev.sh` migrates an empty database
and you register fresh (§5.1).

---

## 7. Sample data

**The walkthrough (Phase 6.1)** — `walkthrough/` at the repo root is a committed,
hand-enterable three-month accounting scenario (Harbor Point Fabrication) with a
tutorial and a computed answer key. Just open
[walkthrough/TUTORIAL.md](walkthrough/TUTORIAL.md) and type it into a fresh
organization. `npm run walkthrough` regenerates the folder; it writes to no
database.

---

## 8. Tests

The suite runs against the **second** Postgres container (`:5433`,
durability off), never your dev database, and it needs Redis:

```bash
docker compose up -d postgres-test redis
cd server && npm test        # ~3.3 min, 1678 tests
cd client && npm test        # 277 tests
```

`./dev.sh` starts `postgres` and `redis` but **not** `postgres-test` — bring
that one up yourself the first time. `globalSetup` creates and migrates the test
databases on its own; there is no manual step. Two server tests are skipped by
design (gated live-provider cases).

Type-checking is separate, because `tsx` strips types without checking them:

```bash
(cd server && npm run typecheck)
(cd client && npm run typecheck)
```

---

## 9. The per-terminal path

`./dev.sh` is the fast path. Use separate terminals when you want to restart one
process alone, attach a debugger, or read one process's output cleanly:

```bash
docker compose up -d                  # postgres :5432, postgres-test :5433, redis :6379
cd server && npm run migrate          # once, after any pull that adds migrations

# terminal 1
cd server && npm run dev              # http://localhost:5000
# terminal 2
cd client && npm run dev              # http://localhost:5173
# terminal 3 (optional — only processes queued jobs)
cd server && npm run worker
```

Shut down with `Ctrl-C` in each; `docker compose down` stops the containers.
**`docker compose down -v` also destroys the Postgres volume and all your data.**

---

## 10. Troubleshooting the first run

| Symptom | Cause / fix |
|---|---|
| `dev.sh must be run from the repository root` | `cd` to the repo root — it checks for `docker-compose.yml` + `server/package.json` |
| `Docker Compose v2 is required` | the compose plugin is missing (§1.2), or you didn't re-login after `usermod -aG docker` |
| `missing .env` / `missing server/.env` / `missing client/.env` | §3 |
| `server dependencies not installed` | §4 |
| `port 5000 is already in use` | an orphaned earlier run. `pgrep -af 'tsx watch'`, then `kill -TERM -<pid>` — the **negative** pid, to signal the process group |
| Server exits with `Invalid server environment` | `server/.env` incomplete; the message lists every missing variable |
| `ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different` | you pasted the same `openssl` output twice — §3.1 |
| Health returns 503, `connect ECONNREFUSED` | Postgres isn't up: `docker compose up -d postgres`, then `docker exec autodb_postgres pg_isready -U autodb_user -d autodb` |
| `port 5432 already allocated` | another project owns it. Change `PG_PORT` in the root `.env` **and** mirror it in `server/.env` |
| Vite exits on a port error | `strictPort` is on by design — it won't drift to 5174, because the server's CORS origin is pinned to 5173 |
| CORS error in the browser console | `FRONTEND_URL` in `server/.env` must exactly match the page's origin, scheme and port included |
| Every authenticated request 401s, no CORS error | a `localhost` / `127.0.0.1` mismatch — see §5.1 |
| Migration fails with `column ... does not exist` | a stale Docker volume from an older schema. `cd server && npm run db:reset`, or `docker compose down -v`. **Both destructive** — dump first |
| `npm test`: `database "autodb_test" does not exist` | normally self-healing; if it persists, `postgres-test` isn't up (§8) |
| `npm test`: "Could not reach Redis" | `docker compose up -d redis`. The suite only ever flushes Redis db index 1, never your dev index 0 |
| Type errors don't show under `npm run dev` | correct — `tsx` doesn't type-check. Run `npm run typecheck` |

The longer list, with the reasoning behind each, is
[docs/development.md § Troubleshooting](docs/development.md#troubleshooting).

---

## 11. Cheat sheet

```bash
./dev.sh                                  # everything, one command
curl localhost:5000/api/v1/health         # is it up

cd server
npm run migrate                           # apply pending migrations
npm run typecheck                         # tsx does NOT type-check
npm test                                  # needs postgres-test + redis
npm run verify:integrity                  # debits == credits, across the whole DB
npm run db:reset                          # DESTRUCTIVE — drop schema, re-migrate
npm run walkthrough                       # regenerate walkthrough/

docker compose ps                         # container status
docker compose down                       # stop containers (volume survives)
docker compose down -v                    # DESTRUCTIVE — drops the data volume
docker exec autodb_postgres pg_dump -U autodb_user -d autodb > backup.sql
```

Ports: server **5000**, client **5173**, Postgres **5432**, test Postgres
**5433**, Redis **6379**.

---

## 12. Where to read next

| File | For |
|---|---|
| [CLAUDE.md](CLAUDE.md) | what is actually built, phase by phase, and the 16 hard rules in short form |
| [docs/development.md](docs/development.md) | every env var, every npm script, the dependency policy |
| [docs/roadmap.md](docs/roadmap.md) | each phase's full delivered detail and its deliberate gaps |
| [docs/architecture.md](docs/architecture.md) | tenancy, RBAC, the platform/app split, repository layout |
| [docs/guardrails.md](docs/guardrails.md) | the 16 rules in full, with code examples |
| [study/README.md](study/README.md) | the interview-prep notes generated from this project's decisions |
