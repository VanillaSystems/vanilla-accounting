// The invitation e-mail. The app renders it and sends it from the sharer's own mail account, so the link
// with the key never passes through the share service (docs/adr/0016-sharing-books-end-to-end.md).
// A pure function, no dependency. Copied from the share service's src/email/invitation.ts with two
// changes: the publisher's line under the footer is an input (`publisher`), since the leak guard keeps
// the publisher's name and address out of the app's files (src/publish/leak-guard.ts IDENTITY_FILES);
// and a link on this computer may be http under any loopback name (the service's development server).
//
// HTML for mail clients: one column, 600 px at most, inline styles, no images, no remote resources, no
// tracking. Ink on white, green for the action, red only in the mark.

export interface InvitationInput {
  /** Who shares: «Anna Muster». */
  senderName: string;
  /** The page link with the key after the #: https://share.<domain>/<id>#<key>. */
  link: string;
  /** When the service deletes the share (ms since epoch or a Date). */
  expiresAt: number | Date;
  /** send: the books go out; return: they come back. */
  direction?: 'send' | 'return';
  /** The company whose books these are: «Muster Kaffee GmbH». */
  company?: string;
  /** The sender's own words to the recipient. */
  message?: string;
  /** Who runs the share service, one line under the footer; none: the line is left out. */
  publisher?: string;
}

export interface Invitation {
  subject: string;
  html: string;
  text: string;
}

const FONT = "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const HEAD_FONT = "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** «24.11.2026», in Swiss time. */
export function swissDate(at: number | Date): string {
  return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' }).format(
    typeof at === 'number' ? new Date(at) : at,
  );
}

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Only an https link to a share page with a fragment is put behind the button. */
function checkLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error('invitation: the link is not a URL');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('invitation: the link must be https');
  if (!url.hash || url.hash.length < 2) throw new Error('invitation: the link has no key after the #');
  return url.toString();
}

export function renderInvitation(input: InvitationInput): Invitation {
  const sender = oneLine(input.senderName);
  if (!sender) throw new Error('invitation: senderName is empty');
  const link = checkLink(input.link);
  const verb = input.direction === 'return' ? 'zurückgeschickt' : 'geschickt';
  const subject = `${sender} hat dir die Buchhaltung ${verb}`;
  const until = swissDate(input.expiresAt);
  const company = input.company ? oneLine(input.company) : '';
  const message = input.message?.trim() ?? '';
  const lock = 'Ende-zu-Ende verschlüsselt: nur wer diesen Link hat, kann sie öffnen. Auch der Dienst, der sie bis dahin aufbewahrt, kann sie nicht lesen.';
  const publisher = input.publisher ? oneLine(input.publisher) : '';
  const footer = `${sender} hat dir diese E-Mail mit Vanilla Accounting geschickt. Antworten gehen an ${sender}.`;

  const h = escapeHtml;
  const messageHtml = message
    ? `<p style="margin:20px 0 0;padding:12px 16px;border-left:3px solid #2e7d4f;background:#f7f8fa;border-radius:0 8px 8px 0;font-size:16px;color:#0b1220;">${h(message).replace(/\r?\n/g, '<br>')}</p>`
    : '';
  const html = `<!doctype html>
<html lang="de-CH"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f3f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e7eaf0;border-radius:12px;">
<tr><td style="padding:20px 28px;border-bottom:1px solid #e7eaf0;"><span style="display:inline-block;padding-left:10px;border-left:4px solid #e3232f;font:800 17px/1 ${HEAD_FONT};letter-spacing:-0.01em;text-transform:uppercase;color:#0b1220;">Vanilla Accounting</span></td></tr>
<tr><td style="padding:30px 28px 26px;font:16px/1.55 ${FONT};color:#0b1220;">
<h1 style="margin:0;font:800 25px/1.2 ${HEAD_FONT};letter-spacing:-0.02em;color:#0b1220;">${h(subject)}</h1>
${company ? `<p style="margin:10px 0 0;color:#4a5263;font-size:16px;">${h(company)}</p>` : ''}
${messageHtml}
<p style="margin:26px 0 0;"><a href="${h(link)}" style="display:inline-block;padding:14px 26px;border-radius:10px;background:#2e7d4f;color:#ffffff;font:600 16px/1.2 ${FONT};text-decoration:none;">Buchhaltung öffnen</a></p>
<p style="margin:16px 0 0;color:#4a5263;">Verfügbar bis ${until}.</p>
<p style="margin:6px 0 0;color:#6e7685;font-size:14px;">${h(lock)}</p>
<p style="margin:18px 0 0;color:#6e7685;font-size:13px;">Geht der Knopf nicht, kopiere diesen Link in den Browser:<br><span style="word-break:break-all;color:#4a5263;">${h(link)}</span></p>
</td></tr>
<tr><td style="padding:16px 28px 20px;border-top:1px solid #e7eaf0;background:#f7f8fa;border-radius:0 0 12px 12px;font:12.5px/1.5 ${FONT};color:#6e7685;">${h(footer)}${publisher ? `<br>${h(publisher)}` : ''}</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `${subject}.`,
    ...(company ? [company] : []),
    ...(message ? ['', message] : []),
    '',
    `Buchhaltung öffnen: ${link}`,
    '',
    `Verfügbar bis ${until}.`,
    lock,
    '',
    '--',
    footer,
    ...(publisher ? [publisher] : []),
  ].join('\n');

  return { subject, html, text };
}
