import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, clearStorage, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { dispatchDriveFile, type DriveIntakeTarget } from '../../services/integrations/driveIntakeDispatcher.js';
import * as apFlowDocumentService from '../../services/ap-flow/apFlowDocumentService.js';

/**
 * The guardrails rule 16 seam — driveIntakeDispatcher. Integration tier, real
 * PostgreSQL: proves each purpose reaches the right app's real tables through
 * that app's own service, and that the two-way SKIPPED/throw contract holds.
 */

const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function countRows(table: string, orgId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM ${table} WHERE org_id = $1`, [orgId]);
  return Number(rows[0]?.count ?? '0');
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let cashAccountIdA: string;

function vendorBillTarget(overrides: Partial<DriveIntakeTarget> = {}): DriveIntakeTarget {
  return {
    orgId: orgA,
    createdBy: userA.id,
    purpose: 'VENDOR_BILL',
    folder: { ledgerAccountId: null, dateFormat: null, columnMap: null },
    file: { buffer: PDF_BYTES, originalname: 'invoice.pdf' },
    ...overrides,
  };
}

function bankStatementTarget(csv: string, overrides: Partial<DriveIntakeTarget> = {}): DriveIntakeTarget {
  return {
    orgId: orgA,
    createdBy: userA.id,
    purpose: 'BANK_STATEMENT',
    folder: { ledgerAccountId: cashAccountIdA, dateFormat: 'ISO', columnMap: null },
    file: { buffer: Buffer.from(csv, 'utf8'), originalname: 'statement.csv' },
    ...overrides,
  };
}

beforeEach(async () => {
  await resetTables();
  await clearStorage();
  userA = await createUserWithOrg({ label: 'dispatch-a', orgName: 'Dispatch Org A' });
  orgA = userA.orgId;
  userB = await createUserWithOrg({ label: 'dispatch-b', orgName: 'Dispatch Org B' });
  orgB = userB.orgId;
  cashAccountIdA = await accountId(orgA, '1110');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(closePool);

describe('dispatchDriveFile', () => {
  it('VENDOR_BILL: imports through AP-Flow and creates one ap_flow_documents row', async () => {
    const outcome = await dispatchDriveFile(vendorBillTarget());

    expect(outcome.status).toBe('IMPORTED');
    expect(outcome).toMatchObject({ resultApp: 'ap-flow' });
    expect(await countRows('ap_flow_documents', orgA)).toBe(1);
  });

  it('VENDOR_BILL: the same content arriving as a second, renamed Drive file is still IMPORTED, as a visible DUPLICATE', async () => {
    // The exact bug this reproduces: a renamed re-upload of the identical
    // invoice, via Drive, used to be silently absorbed into the original
    // registration — nothing new appeared anywhere for a reviewer to see.
    const first = await dispatchDriveFile(vendorBillTarget({ file: { buffer: PDF_BYTES, originalname: 'invoice.pdf' } }));
    expect(first.status).toBe('IMPORTED');

    const second = await dispatchDriveFile(
      vendorBillTarget({ file: { buffer: PDF_BYTES, originalname: 'invoice-renamed.pdf' } }),
    );

    expect(second.status).toBe('IMPORTED');
    expect(second).toMatchObject({ resultApp: 'ap-flow' });
    if (first.status !== 'IMPORTED' || second.status !== 'IMPORTED') throw new Error('unreachable');
    // A genuinely NEW document row — not the same one reused.
    expect(second.resultEntityId).not.toBe(first.resultEntityId);

    expect(await countRows('ap_flow_documents', orgA)).toBe(2);
    const { rows } = await pool.query<{ status: string; duplicate_of_id: string | null }>(
      'SELECT status, duplicate_of_id FROM ap_flow_documents WHERE org_id = $1 AND id = $2',
      [orgA, second.resultEntityId],
    );
    expect(rows[0]?.status).toBe('DUPLICATE');
    expect(rows[0]?.duplicate_of_id).toBe(first.resultEntityId);
  });

  it('BANK_STATEMENT: imports through LedgerCore and creates the bank transaction rows', async () => {
    const csv = ['Date,Description,Amount', '2026-06-01,Payment,100.00', '2026-06-02,Supplies,-40.00', '2026-06-03,Fee,-5.00'].join(
      '\n',
    );

    const outcome = await dispatchDriveFile(bankStatementTarget(csv));

    expect(outcome.status).toBe('IMPORTED');
    expect(outcome).toMatchObject({ resultApp: 'ledger-core' });
    expect(await countRows('bank_transactions', orgA)).toBe(3);
  });

  it('BANK_STATEMENT: an unparseable date is SKIPPED with importStatement\'s row-naming message intact', async () => {
    const csv = ['Date,Description,Amount', 'not-a-date,Payment,100.00'].join('\n');

    const outcome = await dispatchDriveFile(bankStatementTarget(csv));

    expect(outcome.status).toBe('SKIPPED');
    expect(outcome).toMatchObject({
      reason: expect.stringMatching(/^Import failed:.*row 2:/) as unknown,
    });
    expect(await countRows('bank_transactions', orgA)).toBe(0);
  });

  it('BANK_STATEMENT: invalid UTF-8 bytes are SKIPPED, never reach importStatement', async () => {
    const outcome = await dispatchDriveFile(
      bankStatementTarget('', { file: { buffer: Buffer.from([0xff, 0xfe, 0xff]), originalname: 'statement.csv' } }),
    );

    expect(outcome).toEqual({ status: 'SKIPPED', reason: 'File is not valid UTF-8 text' });
    expect(await countRows('bank_transactions', orgA)).toBe(0);
  });

  it('BANK_STATEMENT: a CSV over the character cap is SKIPPED before parsing', async () => {
    const oversized = 'Date,Description,Amount\n' + 'x'.repeat(900_001);
    const outcome = await dispatchDriveFile(
      bankStatementTarget('', { file: { buffer: Buffer.from(oversized, 'utf8'), originalname: 'statement.csv' } }),
    );

    expect(outcome.status).toBe('SKIPPED');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('900,000') as unknown });
  });

  it('VENDOR_BILL: an unrecognized file type is SKIPPED, not IMPORTED', async () => {
    const outcome = await dispatchDriveFile(
      vendorBillTarget({ file: { buffer: Buffer.from('plain text, not a pdf'), originalname: 'notes.txt' } }),
    );

    expect(outcome.status).toBe('SKIPPED');
    expect(await countRows('ap_flow_documents', orgA)).toBe(0);
  });

  it('a thrown network error propagates — it is never converted to SKIPPED', async () => {
    vi.spyOn(apFlowDocumentService, 'captureFile').mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(dispatchDriveFile(vendorBillTarget())).rejects.toThrow('ECONNRESET');
  });

  it('cross-tenant: a folder naming another org\'s account is SKIPPED and writes to neither org', async () => {
    const cashAccountIdB = await accountId(orgB, '1110');
    const csv = ['Date,Description,Amount', '2026-06-01,Payment,100.00'].join('\n');

    const outcome = await dispatchDriveFile(
      bankStatementTarget(csv, { orgId: orgA, folder: { ledgerAccountId: cashAccountIdB, dateFormat: 'ISO', columnMap: null } }),
    );

    expect(outcome).toEqual({ status: 'SKIPPED', reason: 'Bank account not found' });
    expect(await countRows('bank_transactions', orgA)).toBe(0);
    expect(await countRows('bank_transactions', orgB)).toBe(0);
  });
});
