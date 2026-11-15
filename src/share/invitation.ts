// The invitation e-mail. The app renders it and sends it from the sharer's own mail account, so the link
// with the key never passes through the share service (docs/adr/0016-sharing-books-end-to-end.md).
// A pure function, no dependency. Grown from the share service's src/email/invitation.ts: the
// publisher's line under the footer and the download page are inputs, since the leak guard keeps the
// publisher's name and address out of the app's files (src/publish/leak-guard.ts IDENTITY_FILES); a
// link on this computer may be http under any loopback name (the service's development server); and
// it carries every step a recipient who never used the app takes (download, macOS's «Dennoch
// öffnen», the link, the return), in the sharer's language (`texts`).
//
// HTML for mail clients: one column, 600 px at most, inline styles, no images, no remote resources, no
// tracking. Ink on white, green for the action, red only in the mark.

/**
 * Every sentence of the invitation, in the sharer's language (the app passes them from its
 * dictionaries, src/share/sharing.ts invitationTexts); German when none are given. `{sender}`,
 * `{company}`, `{date}`, `{hours}`, `{download}` are filled in here.
 */
export interface InvitationTexts {
  subject: string;
  subjectReturn: string;
  intro: string;
  introNoCompany: string;
  messageFrom: string;
  stepsTitle: string;
  step1: string;
  step2: string;
  step3: string;
  step4: string;
  button: string;
  until: string;
  lock: string;
  fallback: string;
  footer: string;
}

export const GERMAN: InvitationTexts = {
  subject: '{sender} hat dir die Buchhaltung geschickt',
  subjectReturn: '{sender} hat dir die Buchhaltung zurückgeschickt',
  intro: '{sender} teilt mit dir die Buchhaltung von {company}, damit du sie durchsiehst. Du brauchst dafür nur die App Vanilla Accounting: kein Konto, kein Passwort, keine PIN.',
  introNoCompany: '{sender} teilt mit dir die Buchhaltung, damit du sie durchsiehst. Du brauchst dafür nur die App Vanilla Accounting: kein Konto, kein Passwort, keine PIN.',
  messageFrom: 'Nachricht von {sender}:',
  stepsTitle: 'So geht es, einmal und in etwa fünf Minuten:',
  step1: 'Lade Vanilla Accounting für den Mac: {download}',
  step2: 'Öffne die App. Beim ersten Mal hält macOS sie an, weil Apple sie noch nicht geprüft hat: öffne dann Systemeinstellungen › Datenschutz & Sicherheit und klicke unten auf «Dennoch öffnen». Das braucht es nur einmal.',
  step3: 'Klicke hier auf «Buchhaltung öffnen». Die App fragt, ob du die Buchhaltung von {sender} öffnen willst: «Öffnen».',
  step4: 'Die Buchhaltung öffnet sich als Kopie zur Durchsicht. Korrigiere, was nicht stimmt, und schreib dazu, warum. «An {sender} zurückschicken» schickt deine Änderungen mit einem Klick zurück; {sender} entscheidet, was übernommen wird.',
  button: 'Buchhaltung öffnen',
  until: 'Du kannst den Link bis am {date} öffnen. Nach dem ersten Öffnen bleibt er noch {hours} Stunden offen, dann löscht ihn der Dienst; deine Kopie bleibt auf deinem Mac. Braucht es später einen neuen Stand, schickt dir {sender} einfach einen neuen Link.',
  lock: 'Ende-zu-Ende verschlüsselt: nur wer diesen Link hat, kann sie öffnen. Auch der Dienst, der sie bis dahin aufbewahrt, kann sie nicht lesen.',
  fallback: 'Geht der Knopf nicht, kopiere diesen Link in den Browser:',
  footer: '{sender} hat dir diese E-Mail mit Vanilla Accounting geschickt. Antworten gehen an {sender}.',
};

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
  /** Where the Mac app is downloaded (an https page); none: the service's own page, which offers it. */
  download?: string;
  /** How long a link stays open after its first opening. */
  hoursAfterOpen?: number;
  /** The sentences, in the sharer's language. */
  texts?: InvitationTexts;
  /** The language the date is written in (de-CH, fr-CH, …). */
  locale?: string;
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

/** «24. November 2026», in Swiss time and the given language: the deadline in plain words. */
export function longDate(at: number | Date, locale = 'de-CH'): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'Europe/Zurich', day: 'numeric', month: 'long', year: 'numeric' }).format(typeof at === 'number' ? new Date(at) : at);
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

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
  const w = input.texts ?? GERMAN;
  const company = input.company ? oneLine(input.company) : '';
  const download = input.download ? checkPage(input.download) : `${new URL(link).origin}/`;
  const vars = { sender, company, download, date: longDate(input.expiresAt, input.locale), hours: String(input.hoursAfterOpen ?? 5) };
  const say = (text: string) => fill(text, vars);
  const back = input.direction === 'return';
  const subject = say(back ? w.subjectReturn : w.subject);
  const message = input.message?.trim().slice(0, 2000) ?? '';
  const publisher = input.publisher ? oneLine(input.publisher) : '';
  const intro = say(company ? w.intro : w.introNoCompany);
  const steps = [w.step1, w.step2, w.step3, w.step4].map(say);
  const until = say(w.until);
  const footer = say(w.footer);

  const h = escapeHtml;
  const messageHtml = message
    ? `<p style="margin:20px 0 0;color:#4a5263;font-size:14px;">${h(say(w.messageFrom))}</p><p style="margin:6px 0 0;padding:12px 16px;border-left:3px solid #2e7d4f;background:#f7f8fa;border-radius:0 8px 8px 0;font-size:16px;color:#0b1220;">${h(message).replace(/\r?\n/g, '<br>')}</p>`
    : '';
  // Step 1 names the download page as a link of its own; the other steps are text.
  const stepHtml = (text: string, i: number) => `<li style="margin:0 0 10px;">${i === 0 ? h(text).replace(h(download), `<a href="${h(download)}" style="color:#2e7d4f;">${h(download)}</a>`) : h(text)}</li>`;
  const html = `<!doctype html>
<html lang="${h((input.locale ?? 'de-CH').slice(0, 5))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f3f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e7eaf0;border-radius:12px;">
<tr><td style="padding:20px 28px;border-bottom:1px solid #e7eaf0;"><span style="display:inline-block;padding-left:10px;border-left:4px solid #e3232f;font:800 17px/1 ${HEAD_FONT};letter-spacing:-0.01em;text-transform:uppercase;color:#0b1220;">Vanilla Accounting</span></td></tr>
<tr><td style="padding:30px 28px 26px;font:16px/1.55 ${FONT};color:#0b1220;">
<h1 style="margin:0;font:800 25px/1.2 ${HEAD_FONT};letter-spacing:-0.02em;color:#0b1220;">${h(subject)}</h1>
${company ? `<p style="margin:10px 0 0;color:#4a5263;font-size:16px;">${h(company)}</p>` : ''}
<p style="margin:18px 0 0;">${h(intro)}</p>
${messageHtml}
${back ? '' : `<p style="margin:22px 0 8px;font-weight:600;">${h(say(w.stepsTitle))}</p>
<ol style="margin:0;padding-left:22px;">${steps.map(stepHtml).join('')}</ol>`}
<p style="margin:22px 0 0;"><a href="${h(link)}" style="display:inline-block;padding:14px 26px;border-radius:10px;background:#2e7d4f;color:#ffffff;font:600 16px/1.2 ${FONT};text-decoration:none;">${h(say(w.button))}</a></p>
<p style="margin:16px 0 0;color:#4a5263;">${h(until)}</p>
<p style="margin:6px 0 0;color:#6e7685;font-size:14px;">${h(say(w.lock))}</p>
<p style="margin:18px 0 0;color:#6e7685;font-size:13px;">${h(say(w.fallback))}<br><span style="word-break:break-all;color:#4a5263;">${h(link)}</span></p>
</td></tr>
<tr><td style="padding:16px 28px 20px;border-top:1px solid #e7eaf0;background:#f7f8fa;border-radius:0 0 12px 12px;font:12.5px/1.5 ${FONT};color:#6e7685;">${h(footer)}${publisher ? `<br>${h(publisher)}` : ''}</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `${subject}.`,
    ...(company ? [company] : []),
    '',
    intro,
    ...(message ? ['', say(w.messageFrom), message] : []),
    ...(back ? [] : ['', say(w.stepsTitle), ...steps.map((x, i) => `${i + 1}. ${x}`)]),
    '',
    `${say(w.button)}: ${link}`,
    '',
    until,
    say(w.lock),
    '',
    '--',
    footer,
    ...(publisher ? [publisher] : []),
  ].join('\n');

  return { subject, html, text };
}

/** The download page: an https address (http only on this computer). */
function checkPage(page: string): string {
  const url = new URL(page);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('invitation: the download page must be https');
  return url.toString();
}
