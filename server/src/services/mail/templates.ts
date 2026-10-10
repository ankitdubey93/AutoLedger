import type { EmailTemplate, RenderedEmail } from '../../types/email.js';

/**
 * Phase 38b — every email the product sends, as pure functions of their
 * data. No template engine (rule 14): a dozen short messages do not need
 * one, and string functions are trivially testable.
 *
 * Every interpolated value goes through `esc` in the HTML part. The data is
 * user-controlled (an organization name, a person's name) and an email
 * client renders HTML, so an organization called `<img src=x onerror=…>`
 * must arrive as text. The plain-text part needs no escaping.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function str(data: Record<string, unknown>, key: string, fallback = ''): string {
  const value = data[key];
  return typeof value === 'string' ? value : fallback;
}

/** One shared frame so every email looks like it came from the same product. */
function layout(heading: string, paragraphs: string[], action: { label: string; url: string } | null): string {
  const button =
    action === null
      ? ''
      : `<p style="margin:24px 0"><a href="${esc(action.url)}" style="background:#4f46e5;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${esc(action.label)}</a></p>
<p style="color:#6b7280;font-size:12px">If the button does not work, copy this link into your browser:<br>${esc(action.url)}</p>`;
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="line-height:1.5">${p}</p>`).join('\n')}
${button}
<p style="color:#9ca3af;font-size:12px;margin-top:32px">Sent by AutoLedger.</p>
</body></html>`;
}

function textBody(paragraphs: string[], action: { label: string; url: string } | null): string {
  return [...paragraphs, ...(action === null ? [] : [`${action.label}: ${action.url}`]), '', '— AutoLedger'].join('\n\n');
}

/**
 * Renders one email. `link` is the decrypted token-bearing URL for the
 * templates that need one; it is never stored in `template_data`.
 */
export function renderEmail(template: EmailTemplate, data: Record<string, unknown>, link: string | null): RenderedEmail {
  const url = link ?? '';
  switch (template) {
    case 'password_reset': {
      const action = { label: 'Choose a new password', url };
      const text = ['Someone asked to reset the password for your AutoLedger account.', 'The link works once and expires in 30 minutes. If it was not you, ignore this email — your password has not changed.'];
      return {
        subject: 'Reset your AutoLedger password',
        html: layout('Reset your password', text.map(esc), action),
        text: textBody(text, action),
      };
    }
    case 'invitation': {
      const org = str(data, 'organizationName');
      const inviter = str(data, 'inviterName', 'Someone');
      const role = str(data, 'roleLabel');
      const action = { label: `Join ${org}`, url };
      const lines = [`${inviter} invited you to join ${org} on AutoLedger as ${role}.`, 'The invitation expires in 7 days. You will need to sign in (or create an account) with this email address to accept it.'];
      return {
        subject: `${inviter} invited you to ${org} on AutoLedger`,
        html: layout(`Join ${org}`, lines.map(esc), action),
        text: textBody(lines, action),
      };
    }
    case 'verify_email': {
      const action = { label: 'Verify my email', url };
      const lines = ['Confirm this is your email address for AutoLedger.', 'The link expires in 24 hours.'];
      return { subject: 'Verify your email for AutoLedger', html: layout('Verify your email', lines.map(esc), action), text: textBody(lines, action) };
    }
    case 'confirm_email_change': {
      const action = { label: 'Confirm new email', url };
      const lines = [
        'You asked to change the email you sign in to AutoLedger with to this address.',
        'Your sign-in email will not change until you confirm. The link expires in 24 hours. If it was not you, ignore this email.',
      ];
      return { subject: 'Confirm your new AutoLedger email', html: layout('Confirm your new email', lines.map(esc), action), text: textBody(lines, action) };
    }
    case 'email_changed_notice': {
      const newEmail = str(data, 'newEmail');
      const lines = [
        `The email you sign in to AutoLedger with was changed to ${newEmail}.`,
        'If you did not make this change, reset your password from the sign-in page straight away and contact the organization owner.',
      ];
      return { subject: 'Your AutoLedger sign-in email was changed', html: layout('Your sign-in email changed', lines.map(esc), null), text: textBody(lines, null) };
    }
    case 'bill_awaiting_approval': {
      const org = str(data, 'organizationName');
      const vendor = str(data, 'vendorName', 'a vendor');
      const number = str(data, 'billNumber');
      const amount = str(data, 'amount');
      const action = { label: 'Review the bill', url: str(data, 'url') };
      const lines = [
        `A bill from ${vendor}${number === '' ? '' : ` (${number})`}${amount === '' ? '' : ` for ${amount}`} is waiting for your approval in ${org}.`,
        'You are receiving this because you can approve bills. Turn these emails off in Account settings → Notifications.',
      ];
      return { subject: `Bill awaiting approval — ${vendor}`, html: layout('A bill needs your approval', lines.map(esc), action), text: textBody(lines, action) };
    }
    case 'party_statement': {
      // Phase 39b. `subject` and `body` were filled from the organization's
      // own template at send time (utils/placeholders.ts) and are plain
      // text; every paragraph is escaped here like any other value, so
      // neither a template author nor a customer name can inject markup.
      const org = str(data, 'organizationName');
      const subject = str(data, 'subject', `Statement from ${org}`);
      const paragraphs = str(data, 'body')
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p !== '');
      const action = { label: data.actionLabel === 'view' ? 'View statement' : 'Review and pay', url };
      return {
        subject,
        html: layout(`Statement from ${org}`, paragraphs.map((p) => esc(p).replace(/\n/g, '<br>')), action),
        text: textBody(paragraphs, action),
      };
    }
    case 'quote_sent': {
      // Phase 41. The optional `message` is the sender's plain text; it is
      // escaped paragraph by paragraph like a statement body.
      const org = str(data, 'organizationName');
      const purchase = data.direction === 'PURCHASE';
      const number = str(data, 'quoteNumber');
      const revision = typeof data.revision === 'number' && data.revision > 1 ? ` (revision ${String(data.revision)})` : '';
      const title = str(data, 'title');
      const total = str(data, 'total');
      const validUntil = str(data, 'validUntil');
      const kind = purchase ? 'Price confirmation request' : 'Quote';
      const heading = `${kind} ${number}${revision} from ${org}`;
      const message = str(data, 'message')
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p !== '');
      const lines = [
        ...message,
        `${org} has sent you ${purchase ? 'a price confirmation request' : 'a quote'}${title === '' ? '' : ` for "${title}"`}: ${number}${revision}, total ${total}.`,
        `${purchase ? 'Please confirm or decline these prices' : 'You can accept or decline it online'} until ${validUntil}.`,
      ];
      const action = { label: purchase ? 'Review and confirm' : 'Review and accept', url };
      return {
        subject: heading,
        html: layout(heading, lines.map((p) => esc(p).replace(/\n/g, '<br>')), action),
        text: textBody(lines, action),
      };
    }
    case 'quote_responded': {
      const org = str(data, 'organizationName');
      const party = str(data, 'partyName', 'The recipient');
      const number = str(data, 'quoteNumber');
      const accepted = data.response === 'ACCEPTED';
      const signer = str(data, 'signerName');
      const reason = str(data, 'declineReason');
      const verb = accepted ? 'accepted' : 'declined';
      const lines = [
        `${party} ${verb} quote ${number} in ${org}${accepted && signer !== '' ? `, signed by ${signer}` : ''}.`,
        ...(!accepted && reason !== '' ? [`Reason given: ${reason}`] : []),
        ...(accepted ? ['Convert it to a draft from the quote when you are ready.'] : []),
        'Turn these emails off in Account settings → Notifications.',
      ];
      const action = { label: 'Open the quote', url: str(data, 'url') };
      return {
        subject: `Quote ${number} ${verb} — ${party}`,
        html: layout(`Quote ${number} ${verb}`, lines.map(esc), action),
        text: textBody(lines, action),
      };
    }
    case 'invitation_accepted': {
      const org = str(data, 'organizationName');
      const who = str(data, 'memberName');
      const lines = [`${who} accepted your invitation and joined ${org}.`, 'Turn these emails off in Account settings → Notifications.'];
      return { subject: `${who} joined ${org}`, html: layout(`${who} joined ${org}`, lines.map(esc), null), text: textBody(lines, null) };
    }
  }
}
