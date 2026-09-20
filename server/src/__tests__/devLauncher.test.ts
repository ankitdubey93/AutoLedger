import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-contract test for the repo-root `dev.sh` launcher — NOT a
 * behavioural test. It proves the script still says what it must say
 * (executable, invokes the npm scripts that actually exist, signals by
 * process group, redirects child stdin) and nothing more. It cannot prove
 * the stack actually starts — that proof is a real, manual `./dev.sh` run
 * (see plans/one-command-dev-launcher.md, Step 1) followed by a curl against
 * /api/v1/health and a Ctrl-C, none of which belongs inside Vitest: spawning
 * Docker, Postgres, Redis and three long-running watchers would make this
 * suite depend on the developer's own machine state, which
 * vitest.config.ts's per-worker database/Redis-index/storage-root isolation
 * goes to deliberate lengths to avoid.
 *
 * No cross-tenant isolation case here (rule 15) — this file reads two
 * package.json files and a shell script; nothing here touches a table.
 */

// server/src/__tests__/ -> server/src -> server -> repo root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEV_SH_PATH = path.join(REPO_ROOT, 'dev.sh');

async function readDevSh(): Promise<string> {
  return readFile(DEV_SH_PATH, 'utf8');
}

describe('dev.sh launcher contract', () => {
  it('exists at the repository root and is executable', async () => {
    const stats = await stat(DEV_SH_PATH);
    expect(stats.isFile()).toBe(true);
    // Some execute bit (owner, group or other) must be set.
    expect(stats.mode & 0o111).not.toBe(0);
  });

  it('invokes only npm scripts that actually exist', async () => {
    const [devSh, serverPkgRaw, clientPkgRaw] = await Promise.all([
      readDevSh(),
      readFile(path.join(REPO_ROOT, 'server', 'package.json'), 'utf8'),
      readFile(path.join(REPO_ROOT, 'client', 'package.json'), 'utf8'),
    ]);
    const serverPkg = JSON.parse(serverPkgRaw) as { scripts: Record<string, string> };
    const clientPkg = JSON.parse(clientPkgRaw) as { scripts: Record<string, string> };

    // Drift guard: if `worker` (or `dev`/`migrate`) is ever renamed in
    // server/package.json without updating dev.sh, this fails instead of
    // the launcher breaking silently at runtime.
    expect(serverPkg.scripts).toHaveProperty('dev');
    expect(serverPkg.scripts).toHaveProperty('worker');
    expect(serverPkg.scripts).toHaveProperty('migrate');
    expect(clientPkg.scripts).toHaveProperty('dev');

    expect(devSh).toContain('npm run dev');
    expect(devSh).toContain('npm run worker');
    expect(devSh).toContain('npm run migrate');
  });

  it('sets pipefail and toggles job control', async () => {
    const devSh = await readDevSh();
    expect(devSh).toContain('set -uo pipefail');
    expect(devSh).toContain('set -m');
    expect(devSh).toContain('set +m');
  });

  it('signals children by process group, never by bare pid', async () => {
    const devSh = await readDevSh();
    // The leading minus is what makes the signal reach the whole process
    // group rather than just the group leader.
    expect(devSh).toMatch(/kill -TERM "-\$/);
    expect(devSh).toMatch(/kill -KILL "-\$/);
    expect(devSh).not.toContain('pkill');
    expect(devSh).not.toContain('killall');
  });

  it('redirects every child stdin from /dev/null', async () => {
    const devSh = await readDevSh();
    expect(devSh).toContain('< /dev/null');
  });
});
