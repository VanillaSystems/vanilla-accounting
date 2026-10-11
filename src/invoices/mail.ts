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

/** What the person wrote in the send dialog. */
export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

export function checkMessage(m: MailMessage): MailMessage {
  const to = m.to.trim();
  if (!EMAIL.test(to)) throw new MailError('recipient', `Keine E-Mail-Adresse: ${to || '(leer)'}`, to || '–');
  return { to, subject: m.subject.trim(), body: m.body };
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

/** Sends `message` with the PDF attached; resolves with the Message-ID once the server took it. */
export async function sendMail(ws: Workspace, message: MailMessage, pdf: { filename: string; content: Buffer }): Promise<{ to: string; messageId: string }> {
  const m = checkMessage(message);
  const { settings, send } = await transport(ws);
  try {
    const info = await send.sendMail({
      from: settings.fromName ? { name: settings.fromName, address: settings.fromAddress } : settings.fromAddress,
      ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
      to: m.to,
      subject: m.subject,
      text: m.body,
      attachments: [{ filename: pdf.filename, content: pdf.content, contentType: 'application/pdf' }],
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
