#!/usr/bin/env bash
#
# One-command dev launcher.
#
# Brings up postgres + redis (Docker), waits for their compose healthchecks,
# applies pending migrations, then runs the server, worker and client as
# three prefixed processes. One Ctrl-C stops all three.
#
# No arguments, no flags. Run from the repository root: ./dev.sh
#
# See docs/development.md and
# study/node-express/graceful-shutdown-and-process-lifecycle.md for why this
# script signals by PROCESS GROUP rather than by bare pid: `npm run dev`
# does not forward SIGTERM/SIGINT to its `tsx` child (verified in Phase 0 —
# the orphan kept holding port 5000 while health checks kept passing against
# it), so signalling the `npm` pid alone leaves the real process tree alive.
set -uo pipefail
# Deliberately NOT `set -e`: with background jobs and `wait -n`, errexit
# would kill this script on a child's non-zero exit before teardown can run,
# orphaning the other two children. Failures are checked explicitly instead.
#
# `pipefail` IS load-bearing: every child runs as `cmd | sed`, so without it
# the job's exit status is always sed's 0 and a crashed server would report
# success.

COMPOSE_SERVICES=(postgres redis)
SERVER_PORT=5000
CLIENT_PORT=5173
WAIT_TIMEOUT=90
TERM_GRACE_TENTHS=80   # 8.0s per child before SIGKILL

if [[ -t 1 ]]; then
  C_DEV=$'\033[1m'
  C_INFRA=$'\033[35m'
  C_SERVER=$'\033[36m'
  C_WORKER=$'\033[33m'
  C_CLIENT=$'\033[32m'
  C_OFF=$'\033[0m'
else
  C_DEV=''; C_INFRA=''; C_SERVER=''; C_WORKER=''; C_CLIENT=''; C_OFF=''
fi

CHILD_PGIDS=()
TEARING_DOWN=

log() {
  local color=$1 label=$2; shift 2
  printf '%s[%-6s]%s %s\n' "$color" "$label" "$C_OFF" "$*"
}

die() {
  log "$C_DEV" dev "$*" >&2
  exit 1
}

# Bash's own /dev/tcp — no dependency on ss/lsof/nc being installed.
# Returns 0 (true) when something is already listening on 127.0.0.1:$1.
port_busy() {
  (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null
}

preflight() {
  [[ -f docker-compose.yml && -f server/package.json ]] \
    || die "dev.sh must be run from the repository root"

  docker compose version >/dev/null 2>&1 \
    || die "Docker Compose v2 is required — install the compose plugin"

  [[ -f .env ]] \
    || die "missing .env — run: cp .env.example .env"
  [[ -f server/.env ]] \
    || die "missing server/.env — run: cp server/.env.example server/.env"
  [[ -f client/.env ]] \
    || die "missing client/.env — run: cp client/.env.example client/.env"

  [[ -d server/node_modules ]] \
    || die "server dependencies not installed — run: (cd server && npm install)"
  [[ -d client/node_modules ]] \
    || die "client dependencies not installed — run: (cd client && npm install)"

  # Fail loudly rather than start a stack that talks to an orphaned process
  # from an earlier, improperly-killed run holding the same port.
  if port_busy "$SERVER_PORT"; then
    die "port $SERVER_PORT is already in use — an earlier run may have been orphaned. Check: pgrep -af 'tsx watch'"
  fi
  if port_busy "$CLIENT_PORT"; then
    die "port $CLIENT_PORT is already in use — Vite uses strictPort and will not drift. Check: pgrep -af vite"
  fi
}

start_infra() {
  log "$C_INFRA" infra "starting postgres + redis"
  # --wait blocks until each service's OWN compose healthcheck reports
  # healthy — no sleep, no hand-rolled pg_isready poll loop.
  if ! docker compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" --quiet-pull "${COMPOSE_SERVICES[@]}"; then
    die "postgres/redis did not become healthy within ${WAIT_TIMEOUT}s — check: docker compose ps"
  fi
  log "$C_INFRA" infra "postgres + redis healthy"
}

run_migrations() {
  if ! (cd server && npm run migrate) 2>&1 | sed -u "s/^/${C_INFRA}[infra] ${C_OFF}/"; then
    die "migrations failed — not starting the stack"
  fi
}

# start_child <label> <color> <dir> <cmd...>
#
# The core mechanism. Four things must all be present for teardown() to be
# able to stop the whole npm -> tsx -> node tree with one signal:
#
#   1. `set -m` (job control) makes this background job its OWN process
#      group, with pgid == pid of the subshell below.
#   2. The pipeline is wrapped in `( ... ) &` so that $! is the pid of that
#      subshell (the group leader) rather than the pid of `sed`, the last
#      command in the pipeline — which is what $! would be without the
#      subshell, and which is not the group leader.
#   3. `set +m` right after suppresses bash's own "[1]- Terminated" job
#      control chatter at shutdown. The pgid is already captured, so turning
#      job control back off costs nothing.
#   4. `< /dev/null` on every child: these jobs run in a non-foreground
#      process group, and a TTY read from a non-foreground group raises
#      SIGTTIN and stops it. Vite binds stdin for its keyboard shortcuts
#      when stdin is a TTY, so without this redirect the client can hang
#      stopped rather than becoming ready.
start_child() {
  local label=$1 color=$2 dir=$3
  shift 3
  set -m
  (
    cd "$dir" || exit 1
    "$@" < /dev/null 2>&1 | sed -u "s/^/${color}[${label}]${C_OFF} /"
  ) &
  CHILD_PGIDS+=("$!")
  set +m
}

# Mirrors server/src/index.ts's shutdown discipline one level up: a latch so
# a second Ctrl-C cannot re-enter teardown, and a bounded wait before
# escalating rather than an unbounded one.
teardown() {
  if [[ -n "$TEARING_DOWN" ]]; then
    return
  fi
  TEARING_DOWN=1

  log "$C_DEV" dev "stopping client, worker, server"
  # Reverse spawn order (client, worker, server) so the message matches what
  # actually happens, and the server is the last thing to stop accepting
  # requests.
  local i p t
  for ((i = ${#CHILD_PGIDS[@]} - 1; i >= 0; i--)); do
    p=${CHILD_PGIDS[i]}
    kill -TERM "-$p" 2>/dev/null   # NEGATIVE pid = the whole process group
    for ((t = 0; t < TERM_GRACE_TENTHS; t++)); do
      kill -0 "-$p" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "-$p" 2>/dev/null   # bounded escalation, never an unbounded wait
  done
  log "$C_DEV" dev "all stopped"
  exit "$1"
}

# Because `set -m` put each child in its own process group, the terminal's
# Ctrl-C (SIGINT to the whole FOREGROUND process group) reaches only this
# script, never the children — deliberately. That is what makes shutdown a
# deterministic, ordered sequence this script controls, instead of three
# processes racing a broadcast signal. Exit 0 on an explicit Ctrl-C, matching
# server/src/index.ts, which treats SIGINT as a normal stop.
trap 'teardown 0' INT TERM

preflight
start_infra
run_migrations

start_child server "$C_SERVER" server npm run dev
start_child worker "$C_WORKER" server npm run worker
start_child client "$C_CLIENT" client npm run dev

log "$C_DEV" dev "server :$SERVER_PORT · client :$CLIENT_PORT · worker · Ctrl-C to stop all"

# wait -n returns as soon as ANY child exits, with that child's real exit
# status (this depends on `pipefail` above — without it every child's status
# would be sed's 0). A half-running stack is worse than no stack, so one
# death takes the other two down.
wait -n
rc=$?
log "$C_DEV" dev "a process exited (status $rc) — shutting the rest down"
teardown 1
