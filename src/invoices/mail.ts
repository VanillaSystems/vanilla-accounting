/**
 * Sending a document by e-mail through the company's own mailbox (ADR 0010): the stored PDF,
 * byte for byte, as the attachment. The settings come from the manifest (`outgoingMail`), the
 * password from src/secrets/. Nothing here records anything: the caller records the document
 * as sent once the server took the message, and nothing when it did not.
 */
import nodemailer from 'nodemailer';
import { secrets } from '../secrets/secrets.js';
import type { Workspace } from '../workspace/workspace.js';
import type { OutgoingMail } from './model.js';

export type MailRefusal = 'notConfigured' | 'noPassword' | 'recipient' | 'failed';

export class MailError extends Error {
  /** What the mail server said, or where the password goes: the UI words the rest by `code`. */
  constructor(readonly code: MailRefusal, message: string, readonly detail?: string) { super(message); }
}

/** What the person wrote in the send dialog: `to`, `cc` and `bcc` each one address or several, separated by commas or semicolons. */
export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  /** Copies, seen by every recipient (spec 4.4.11: the contact's other persons). */
  cc?: string;
  /** Copies unseen by the recipients: the sender's own («Kopie an mich», a payslip's proof of dispatch). */
  bcc?: string;
}

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

/** The addresses of a field: split at commas and semicolons, each checked; the first wrong one is refused by name. */
export function addressesOf(field: string | undefined): string[] {
  const list = (field ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const bad = list.find((x) => !EMAIL.test(x));
  if (bad) throw new MailError('recipient', `Keine E-Mail-Adresse: ${bad}`, bad);
  return [...new Map(list.map((x) => [x.toLowerCase(), x])).values()];
}

export function checkMessage(m: MailMessage): MailMessage {
  const to = addressesOf(m.to);
  if (!to.length) throw new MailError('recipient', 'Keine E-Mail-Adresse: (leer)', '–');
  const cc = addressesOf(m.cc);
  const bcc = addressesOf(m.bcc);
  return { to: to.join(', '), subject: m.subject.trim(), body: m.body, ...(cc.length ? { cc: cc.join(', ') } : {}), ...(bcc.length ? { bcc: bcc.join(', ') } : {}) };
}

async function transport(ws: Workspace): Promise<{ settings: OutgoingMail; send: nodemailer.Transporter }> {
  const settings = ws.outgoingMail;
  if (!settings) throw new MailError('notConfigured', 'Kein Postausgang eingerichtet (Firma › E-Mail-Versand).');
  const pass = settings.user ? await secrets.get('smtp') : undefined;
  if (settings.user && !pass) throw new MailError('noPassword', `Das Passwort des Postausgangs fehlt (${secrets.where('smtp')}).`, secrets.where('smtp'));
  const send = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'tls',
    requireTLS: settings.security === 'starttls',
    ignoreTLS: settings.security === 'none',
    ...(settings.user ? { auth: { user: settings.user, pass } } : {}),
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
  });
  return { settings, send };
}

/**
 * Sends `message` with the PDF attached, and `more` after it (a Vorlage's fixed attachment, a
 * Rapport), each byte for byte; resolves with the Message-ID once the server took it for every
 * recipient. A copy alone accepted is no delivery.
 */
export async function sendMail(ws: Workspace, message: MailMessage, pdf: { filename: string; content: Buffer }, more: ReadonlyArray<{ filename: string; content: Buffer }> = []): Promise<{ to: string; messageId: string; cc?: string[]; bcc?: string[] }> {
  const m = checkMessage(message);
  const to = addressesOf(m.to);
  const cc = addressesOf(m.cc);
  const bcc = addressesOf(m.bcc);
  const { settings, send } = await transport(ws);
  try {
    const info = await send.sendMail({
      from: settings.fromName ? { name: settings.fromName, address: settings.fromAddress } : settings.fromAddress,
      ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      subject: m.subject,
      text: m.body,
      attachments: [pdf, ...more].map((a) => ({ filename: a.filename, content: a.content, contentType: 'application/pdf' })),
    });
    const took = new Set((info.accepted as Array<string | { address: string }>).map((a) => (typeof a === 'string' ? a : a.address).toLowerCase()));
    const refused = to.filter((x) => !took.has(x.toLowerCase()));
    if (refused.length) throw new Error(`abgelehnt: ${refused.join(', ')}`);
    return { to: to.join(', '), messageId: info.messageId, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}) };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new MailError('failed', `E-Mail nicht gesendet: ${why}`, why);
  } finally {
    send.close();
  }
}

/** The address the mailbox sends from, or undefined without one set up. */
export const sendingAddress = (ws: Workspace): string | undefined => ws.outgoingMail?.fromAddress || undefined;

/**
 * Sends a message without an attachment (the share's invitation and the sender's confirmation,
 * src/share/sharing.ts): plain text, and HTML when given. Resolves once the server took it.
 */
export async function sendText(ws: Workspace, message: MailMessage & { html?: string; replyTo?: string }): Promise<{ to: string; messageId: string }> {
  const m = checkMessage(message);
  const { settings, send } = await transport(ws);
  try {
    const info = await send.sendMail({
      from: settings.fromName ? { name: settings.fromName, address: settings.fromAddress } : settings.fromAddress,
      ...(message.replyTo ?? settings.replyTo ? { replyTo: message.replyTo ?? settings.replyTo } : {}),
      to: m.to,
      subject: m.subject,
      text: m.body,
      ...(message.html ? { html: message.html } : {}),
    });
    if (!info.accepted.length) throw new Error(`abgelehnt: ${info.rejected.join(', ')}`);
    return { to: m.to, messageId: info.messageId };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new MailError('failed', `E-Mail nicht gesendet: ${why}`, why);
  } finally {
    send.close();
  }
}

/** Logs in to the mailbox without sending anything: Firma › E-Mail's check. */
export async function verifyMail(ws: Workspace): Promise<void> {
  const { send } = await transport(ws);
  try {
    await send.verify();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new MailError('failed', `Postausgang nicht erreichbar: ${why}`, why);
  } finally {
    send.close();
  }
}
