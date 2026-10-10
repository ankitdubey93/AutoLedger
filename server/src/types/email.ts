/**
 * Phase 38b — outbound email types. Platform-scoped: any module may send.
 */

/** Mirrors the CHECK on `email_outbox.template` (migration 082). */
export const EMAIL_TEMPLATES = [
  'password_reset',
  'invitation',
  'verify_email',
  'confirm_email_change',
  'email_changed_notice',
  'bill_awaiting_approval',
  'invitation_accepted',
  'party_statement',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export function isEmailTemplate(value: string): value is EmailTemplate {
  return (EMAIL_TEMPLATES as readonly string[]).includes(value);
}

export const EMAIL_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * The one transition table for an outbox row (guardrails rule 10).
 *
 * - PENDING → SENDING: the drain claimed it.
 * - SENDING → SENT: the transport accepted it.
 * - SENDING → PENDING: a retryable failure (or a stale claim reclaimed
 *   after a worker crash), with a backed-off `next_attempt_at`.
 * - SENDING → FAILED: a permanent failure, or the last retry spent.
 */
export const EMAIL_STATUS_TRANSITIONS: Readonly<Record<EmailStatus, readonly EmailStatus[]>> = {
  PENDING: ['SENDING'],
  SENDING: ['SENT', 'PENDING', 'FAILED'],
  SENT: [],
  FAILED: [],
};

export function canTransitionEmail(from: EmailStatus, to: EmailStatus): boolean {
  return EMAIL_STATUS_TRANSITIONS[from].includes(to);
}

/** Events a user can opt out of. Mirrors the CHECK on `user_notification_preferences.event`. */
export const NOTIFICATION_EVENTS = ['bill_awaiting_approval', 'invitation_accepted'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export function isNotificationEvent(value: string): value is NotificationEvent {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** A rendered message, ready for a transport. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** What a transport is handed. */
export interface OutgoingEmail extends RenderedEmail {
  to: { email: string; name: string | null };
  from: { email: string; name: string };
  replyTo: string | null;
}

/** An organization's sender settings (`organization_email_settings`). */
export interface OrganizationEmailSettings {
  senderName: string | null;
  replyTo: string | null;
  /** The platform's verified From address — fixed, shown for context. */
  fromEmail: string;
  /** Which transport this deployment uses — so the settings page can say whether mail is really sent. */
  transport: 'log' | 'mailpit' | 'brevo';
}

export interface NotificationPreference {
  event: NotificationEvent;
  enabled: boolean;
}
