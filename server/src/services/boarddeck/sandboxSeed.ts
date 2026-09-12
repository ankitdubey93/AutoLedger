import * as closeRunService from './closeRunService.js';
import * as fiscalPeriodService from '../ledger-core/fiscalPeriodService.js';
import type { SandboxSeedContext, SandboxCounts } from '../../types/sandbox.js';

/**
 * Phase 18 — BoardDeck's sandbox seeder.
 *
 * Imports `services/boarddeck/` plus `services/ledger-core/fiscalPeriodService`
 * — the same sanctioned cross-app bridge `closeRunService.ts` itself already
 * documents in its own header (guardrails rule 16: BoardDeck's rule-16
 * boundary explicitly names this service as one of its two permitted routes
 * into LedgerCore). No SQL, no other app's table.
 *
 * No `.pptx` is generated here — that is a queued background job needing the
 * worker process running, which this seeder does not assume. The "Generate
 * deck" button in the UI demonstrates that live instead.
 */
export async function seedSandbox(ctx: SandboxSeedContext): Promise<Partial<SandboxCounts>> {
  const periods = await fiscalPeriodService.listPeriods(ctx.orgId, {
    fiscalYearLabel: null,
    status: null,
  });
  const sorted = [...periods].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));

  // generatePeriods always creates the WHOLE fiscal year containing a date,
  // not just the month asked for, so LedgerCore's seeder — which calls it
  // once per real month across a 24-month, 3-calendar-year window — also
  // creates OPEN periods for calendar months outside the dataset entirely
  // (e.g. Jan 2024, or Dec 2026). Picking "the oldest/newest OPEN period"
  // by array position would land on one of those empty, out-of-range
  // months instead of a real one. Find each candidate by its actual
  // calendar month instead.
  //
  // reportService.closeReadiness's PERIOD_OPEN check means a close run only
  // ever makes sense against an OPEN period — a CLOSED one fails that check
  // by definition, so BOTH candidates below must be OPEN. LedgerCore's
  // seeder leaves the most recent 4 real months open (offsets -3..0):
  //   0  — Acme's DRAFT invoice, and (per bank-import.json's window) the
  //        month the bank statement actually covers → BLOCKED
  //  -1  — quill-supply's bill left AWAITING_APPROVAL from this month on
  //        (vendors.json's leaveUnapprovedFromOffset) → also BLOCKED
  //  -2  — clean: no draft invoice, no unapproved bill, and, since the bank
  //        import window is offset 0 only, no bank_transactions row at all
  //        → the genuine READY candidate
  //  -3  — clean too, kept in reserve
  const blockedMonthStart = ctx.monthDate(0, 1);
  const readyMonthStart = ctx.monthDate(-2, 1);

  const blockedCandidate = sorted.find(
    (p) => p.startsOn <= blockedMonthStart && p.endsOn >= blockedMonthStart,
  );
  const readyCandidate = sorted.find((p) => p.startsOn <= readyMonthStart && p.endsOn >= readyMonthStart);

  let closeRunCount = 0;

  if (readyCandidate !== undefined) {
    await closeRunService.createRun(ctx.orgId, ctx.userId, readyCandidate.id);
    closeRunCount += 1;
  }
  if (blockedCandidate !== undefined) {
    await closeRunService.createRun(ctx.orgId, ctx.userId, blockedCandidate.id);
    closeRunCount += 1;
  }

  return { closeRuns: closeRunCount };
}
