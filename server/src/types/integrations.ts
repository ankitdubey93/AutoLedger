/**
 * Phase 19.3 — platform integration types. Platform-scoped, like `jobs.ts` and
 * `audit.ts`: an integration is shared infrastructure, not owned by any one app.
 *
 * These moved out of `types/capture.ts` when Drive folder intake stopped being
 * an Capture feature. A folder now carries a `purpose`, and the purpose decides
 * which app receives the file — VENDOR_BILL goes to Capture's document capture,
 * BANK_STATEMENT to Accounting's bank import — always through that app's own
 * service function, never its tables (guardrails rule 16). A type named after
 * one app while serving two is the drift this rename exists to remove.
 */

// ------------------------------------------------------------- auth mode

/**
 * How the server authenticates to Google for this organization.
 *
 * OAUTH is the Phase 19.2 flow: the tenant walks a consent screen and we store
 * their refresh token, encrypted. SERVICE_ACCOUNT is Phase 19.3's default: the
 * tenant shares a folder with the server's own service-account address and no
 * consent screen, no token and no Google app verification are involved.
 *
 * The distinction is not cosmetic. Google issues refresh tokens that expire
 * after 7 days to an external OAuth app whose publishing status is "Testing",
 * so an OAUTH connection on an unverified app silently dies every week. A
 * service account has no refresh token to expire.
 */
export const DRIVE_AUTH_MODES = ['OAUTH', 'SERVICE_ACCOUNT'] as const;
export type DriveAuthMode = (typeof DRIVE_AUTH_MODES)[number];

// --------------------------------------------------------- folder purpose

/**
 * What a watched folder contains, and therefore which app's service receives
 * its files. Adding a third purpose is deliberately a compile error in
 * driveIntakeDispatcher until that app's seam is wired — see its `never`
 * exhaustiveness check.
 *
 * Only these two exist because only these two have a parser behind them:
 * Capture extracts vendor bills from PDFs and images, Accounting parses bank
 * statement CSVs. Sales invoices are entered by hand and have no intake path.
 */
export const DRIVE_FOLDER_PURPOSES = ['VENDOR_BILL', 'BANK_STATEMENT'] as const;
export type DriveFolderPurpose = (typeof DRIVE_FOLDER_PURPOSES)[number];

// ------------------------------------------------------- connection status

/**
 * PENDING_AUTH -> CONNECTED is the normal OAuth completion. CONNECTED ->
 * NEEDS_REAUTH happens when a refresh fails with invalid_grant (the user
 * revoked access at Google's end). Either non-PENDING_AUTH state can
 * restart the flow, back to PENDING_AUTH. No terminal state: a connection
 * only ever leaves this table via disconnect (a DELETE), never a status.
 *
 * A SERVICE_ACCOUNT connection is created CONNECTED directly — there is no
 * handshake to be pending on — and can never reach NEEDS_REAUTH, because
 * there is no user grant for a tenant to revoke.
 */
export const DRIVE_CONNECTION_STATUSES = ['PENDING_AUTH', 'CONNECTED', 'NEEDS_REAUTH'] as const;
export type DriveConnectionStatus = (typeof DRIVE_CONNECTION_STATUSES)[number];

export function isDriveConnectionStatus(value: string): value is DriveConnectionStatus {
  return (DRIVE_CONNECTION_STATUSES as readonly string[]).includes(value);
}

export const DRIVE_CONNECTION_TRANSITIONS = {
  PENDING_AUTH: ['PENDING_AUTH', 'CONNECTED'],
  CONNECTED: ['PENDING_AUTH', 'NEEDS_REAUTH'],
  NEEDS_REAUTH: ['PENDING_AUTH'],
} as const satisfies Record<DriveConnectionStatus, readonly DriveConnectionStatus[]>;

export function canTransitionDriveConnection(
  from: DriveConnectionStatus,
  to: DriveConnectionStatus,
): boolean {
  return (DRIVE_CONNECTION_TRANSITIONS[from] as readonly DriveConnectionStatus[]).includes(to);
}

// -------------------------------------------------------------- bank setup

/**
 * How a BANK_STATEMENT folder's CSVs are read. Mirrors the `dateFormat` and
 * `columnMap` fields of `schemas/accounting/bankSchema.ts`'s
 * `importStatementSchema`, because these values are passed straight through to
 * `bankImportService.importStatement` — a folder is stored configuration for an
 * import that would otherwise be typed into the manual form each time.
 */
export type DriveDateFormat = 'ISO' | 'DMY' | 'MDY';

/**
 * `null` on every optional column means "resolve it from the CSV header".
 * Either `amount`, or both `debit` and `credit`, must name a column — the same
 * rule `importStatementSchema` enforces, re-checked there on every import.
 */
export interface DriveColumnMap {
  date: string;
  description: string;
  amount: string | null;
  debit: string | null;
  credit: string | null;
  reference: string | null;
}

// ------------------------------------------------------------- the records

export interface DriveConnection {
  id: string;
  status: DriveConnectionStatus;
  authMode: DriveAuthMode;
  /**
   * The connected user's Google address in OAUTH mode, or the server's
   * service-account address in SERVICE_ACCOUNT mode. Never a secret in either
   * case — in SERVICE_ACCOUNT mode it is precisely the address the tenant must
   * share their folder with.
   */
  googleAccountEmail: string | null;
  connectedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DriveFolder {
  id: string;
  purpose: DriveFolderPurpose;
  /** Google's own folder ID, not this row's `id`. */
  folderId: string;
  folderName: string;
  isActive: boolean;

  /**
   * BANK_STATEMENT only; all three are `null` for VENDOR_BILL, enforced by
   * `chk_integration_drive_folders_purpose_payload`.
   *
   * `ledgerAccountId` is a Accounting account id held without a foreign key —
   * rules 8 and 16 collide and 16 wins. `ledgerAccountCode` is resolved for
   * display through `accountService.getAccountById`, never by joining
   * `accounts` from an integrations query.
   */
  ledgerAccountId: string | null;
  ledgerAccountCode: string | null;
  dateFormat: DriveDateFormat | null;
  columnMap: DriveColumnMap | null;

  lastSyncedAt: string | null;
  lastSyncError: string | null;
  importedFileCount: number;
  skippedFileCount: number;

  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
