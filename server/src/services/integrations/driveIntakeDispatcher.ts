import { ApiError } from '../../utils/apiError.js';
import { MAX_CSV_CHARS } from '../../config/constants.js';
import * as captureDocumentService from '../capture/captureDocumentService.js';
import * as bankImportService from '../accounting/bankImportService.js';
import type { DriveColumnMap, DriveDateFormat, DriveFolderPurpose } from '../../types/integrations.js';
import { MODULE_TAGS } from '../../config/modules.js';

/**
 * The guardrails rule 16 seam for Drive folder intake: hands one downloaded
 * file to the app that owns its folder's purpose, through that app's OWN
 * public service function. This file imports two app SERVICES and reads or
 * writes ZERO app tables — no SQL of any kind lives here.
 *
 * VENDOR_BILL -> captureDocumentService.captureFile. The identical path
 * POST /capture/documents/upload already uses, so extraction, PII masking,
 * AI usage metering (Phase 19.1) and confidence-gated auto-post all keep
 * working with no additional wiring.
 *
 * BANK_STATEMENT -> bankImportService.importStatement. The folder stores the
 * ledger account, date format and column map a manual import would otherwise
 * ask for on the form each time.
 */

export interface DriveIntakeTarget {
  orgId: string;
  /** The FOLDER's created_by — the person who configured this intake, not the connection's owner. */
  createdBy: string;
  purpose: DriveFolderPurpose;
  folder: {
    ledgerAccountId: string | null;
    dateFormat: DriveDateFormat | null;
    columnMap: DriveColumnMap | null;
  };
  file: {
    buffer: Buffer;
    originalname: string;
  };
}

export type DriveIntakeOutcome =
  | { status: 'IMPORTED'; resultApp: typeof MODULE_TAGS.capture | typeof MODULE_TAGS.accounting; resultEntityId: string }
  | { status: 'SKIPPED'; reason: string };

/** The `skip_reason` / `last_sync_error` column bound (`integration_drive_files.skip_reason`, migration 053). */
const REASON_MAX_CHARS = 1000;

/**
 * Converts a downloaded Drive CSV to text for `importStatement`, which takes
 * a string, not a Buffer.
 *
 * Three checks, in this order, and none may be skipped:
 *
 * 1. A cheap byte pre-gate before decoding at all. UTF-8 is at most 4 bytes
 *    per code unit, so this can never reject a string that would have fit
 *    under MAX_CSV_CHARS once decoded.
 * 2. `fatal: true`, NOT `buffer.toString('utf8')`. `toString` silently
 *    substitutes U+FFFD for invalid bytes, which would turn a Latin-1 bank
 *    export into a file that parses "fine" with corrupted payee names — the
 *    same reasoning `utils/mimeSniff.ts` gives for its own round-trip check.
 * 3. The real cap, on decoded characters, matching `importStatementSchema`'s
 *    own bound exactly.
 *
 * Returns the decoded text, or a SKIPPED outcome to return directly.
 */
function decodeCsv(buffer: Buffer): { content: string } | { skipped: DriveIntakeOutcome } {
  if (buffer.byteLength > MAX_CSV_CHARS * 4) {
    return { skipped: { status: 'SKIPPED', reason: 'CSV exceeds the size limit' } };
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { skipped: { status: 'SKIPPED', reason: 'File is not valid UTF-8 text' } };
  }

  if (content.length > MAX_CSV_CHARS) {
    return { skipped: { status: 'SKIPPED', reason: 'CSV exceeds the 900,000 character limit' } };
  }

  // Deliberately NOT stripping a BOM here — parseCsv already strips it from
  // the first header cell (utils/csv.ts's own contract). Stripping twice
  // would be a silent divergence waiting to happen.
  return { content };
}

async function dispatchVendorBill(target: DriveIntakeTarget): Promise<DriveIntakeOutcome> {
  const { document } = await captureDocumentService.captureFile(target.orgId, target.createdBy, target.file);
  return { status: 'IMPORTED', resultApp: MODULE_TAGS.capture, resultEntityId: document.id };
}

async function dispatchBankStatement(target: DriveIntakeTarget): Promise<DriveIntakeOutcome> {
  const decoded = decodeCsv(target.file.buffer);
  if ('skipped' in decoded) return decoded.skipped;

  // The purpose-payload CHECK on integration_drive_folders guarantees these
  // two are non-null for a BANK_STATEMENT folder; the ! assertions document
  // that invariant rather than re-deriving it with a runtime throw.
  const result = await bankImportService.importStatement(target.orgId, target.createdBy, {
    accountId: target.folder.ledgerAccountId!,
    fileName: target.file.originalname,
    content: decoded.content,
    dateFormat: target.folder.dateFormat!,
    columnMap: target.folder.columnMap,
    closingBalanceCents: null,
    closingBalanceOn: null,
  });

  return { status: 'IMPORTED', resultApp: MODULE_TAGS.accounting, resultEntityId: result.import.id };
}

/**
 * Returns SKIPPED for a permanent, file-specific rejection (415, 422, 409, an
 * undecodable CSV, an over-cap CSV) — the caller records this, and the file
 * is never retried.
 *
 * THROWS for anything else (network, 5xx, a bug) — the caller records
 * nothing for this file, so the next sweep retries it. This two-way split is
 * lifted intact from 19.2's `syncConnection`.
 */
export async function dispatchDriveFile(target: DriveIntakeTarget): Promise<DriveIntakeOutcome> {
  try {
    switch (target.purpose) {
      case 'VENDOR_BILL':
        return await dispatchVendorBill(target);
      case 'BANK_STATEMENT':
        return await dispatchBankStatement(target);
      default: {
        // Exhaustiveness: adding a third purpose is a compile error here
        // until this switch handles it.
        const _never: never = target.purpose;
        throw new Error(`Unhandled Drive folder purpose ${String(_never)}`);
      }
    }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 409 || err.status === 415 || err.status === 422)) {
      // importStatement's 422 names the first three unparseable rows, e.g.
      // "Import failed: 4 row(s) could not be parsed (row 3: ...)" — the
      // single most useful thing a folder card can show, so it is preserved
      // verbatim rather than replaced with a generic message.
      return { status: 'SKIPPED', reason: err.message.slice(0, REASON_MAX_CHARS) };
    }
    throw err;
  }
}
