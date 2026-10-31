/**
 * The mail channel of the host (ADR 0014): the source's code asks for messages and attachments;
 * the host holds the connection, the password and the reach. Only senders the reach lets through
 * and mail to the source's addresses ever reach the code. Attachments come out of the whole
 * message (a body structure misses inline PDFs), held by their checksum until delivered.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MailReach, MailCheck } from './model.js';
import { senderAllowed } from './reach.js';
import { judge, type Judged } from '../../llm/judge.js';

/** What a source's code learns from `triage`: the probability that the mail brings a receipt, how sure the model is, and which model said so; `receipt: null` when no model answered. */
export type Triage = { receipt: number; confidence: number; by: string } | { receipt: null; why: string };

const TRIAGE = 'Does this mail bring a receipt for the books: an invoice, a bill, a receipt or a credit note, attached or behind a link? A newsletter, an offer, a shipping notice, a reminder without the bill or a private message is no receipt.';

export interface MailSummary { uid: number; from: string; to: string[]; subject: string; date: string; messageId: string }
export interface MailBackend {
  /** Messages of the folder after `after` (a UID), oldest first, at most `limit`; without `after`, those since `since`. */
  list(folder: string, after: number | undefined, since: Date, limit: number): Promise<{ validity: string; messages: MailSummary[] }>;
  /** The attachments of one message, from its whole source. */
  attachments(folder: string, uid: number): Promise<Array<{ filename: string; contentType: string; content: Buffer }>>;
  close(): Promise<void>;
}

/** The real backend: one IMAP connection per pull or check. The libraries load on first use, so a start without mail sources never loads them. */
export async function imapBackend(r: MailReach, password: string, port = 993): Promise<MailBackend> {
  const [{ ImapFlow }, { simpleParser }] = await Promise.all([import('imapflow'), import('mailparser')]);
  const client = new ImapFlow({ host: r.host, port, secure: true, auth: { user: r.account, pass: password }, logger: false, connectionTimeout: 20_000, greetingTimeout: 20_000 });
  try { await client.connect(); } catch (e) { client.close(); throw e; }
  return {
    async list(folder, after, since, limit) {
      const lock = await client.getMailboxLock(folder);
      try {
        const validity = String(client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidValidity : '');
        const uids = ((await client.search(after ? { uid: `${after + 1}:*` } : { since }, { uid: true })) || []).filter((u) => !after || u > after).sort((a, b) => a - b).slice(0, limit);
        const messages: MailSummary[] = [];
        if (uids.length) for await (const m of client.fetch(uids.join(','), { envelope: true }, { uid: true })) {
          const env = m.envelope;
          messages.push({ uid: m.uid, from: env?.from?.[0]?.address ?? '', to: [...(env?.to ?? []), ...(env?.cc ?? [])].map((a) => a.address ?? ''), subject: env?.subject ?? '', date: env?.date?.toISOString() ?? '', messageId: env?.messageId ?? `uid-${validity}-${m.uid}` });
        }
        return { validity, messages: messages.sort((a, b) => a.uid - b.uid) };
      } finally { lock.release(); }
    },
    async attachments(folder, uid) {
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) return [];
        const parsed = await simpleParser(msg.source);
        return parsed.attachments.map((a) => ({ filename: a.filename ?? 'attachment', contentType: a.contentType, content: a.content }));
      } finally { lock.release(); }
    },
    async close() { await client.logout().catch(() => client.close()); },
  };
}

/** A login the mail server refused: the password or the login name is wrong. */
export class MailLoginError extends Error {}

/** Node's codes for a TLS certificate this machine does not trust: the server was reached (r6h-26). */
const CERTIFICATE = /^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_|ERR_TLS_CERT_|UNABLE_TO_GET_ISSUER_CERT|HOSTNAME_MISMATCH)/;

/** What a failed connection or login means for the check's words. */
export function mailFailure(e: unknown): Extract<MailCheck, { ok: false }> {
  if (e instanceof MailLoginError) return { ok: false, reason: 'login' };
  const code = String((e as { code?: string }).code ?? (e as Error).message).slice(0, 200);
  return { ok: false, reason: CERTIFICATE.test(code) ? 'certificate' : 'connect', detail: code };
}

/**
 * A stand-in mailbox for tests and the verify sandbox, never a real one: VANILLA_FAKE_MAILBOX
 * names a JSON file `{ password, messages: MailSummary[] }`; another password is refused as a
 * real server would. As VANILLA_SECRETS_FILE stands in for the keychain.
 */
function fakeBackend(file: string, password: string): MailBackend {
  const box = JSON.parse(readFileSync(file, 'utf8')) as { password: string; messages: MailSummary[] };
  if (password !== box.password) throw new MailLoginError('Authentication failed');
  return {
    async list(_folder, after, since) { return { validity: '1', messages: box.messages.filter((m) => (after ? m.uid > after : Date.parse(m.date) >= since.getTime())) }; },
    async attachments() { return []; },
    async close() {},
  };
}

/** The backend of a check or a pull: the stand-in when one is named, else the real server; a refused login is a MailLoginError. */
export async function mailBackend(r: MailReach, password: string): Promise<MailBackend> {
  if (process.env.VANILLA_FAKE_MAILBOX) return fakeBackend(process.env.VANILLA_FAKE_MAILBOX, password);
  try {
    return await imapBackend(r, password);
  } catch (e) {
    if ((e as { authenticationFailed?: boolean }).authenticationFailed) throw new MailLoginError((e as Error).message);
    throw e;
  }
}

export interface MailCursor { validity: string; uid: number }
/** An attachment's bytes the host holds until it delivers them, with the address of the mail's sender. */
export interface Held { name: string; content: Buffer; from?: string }
export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * What the code may call: `messages(cursor)` (a page of mail it may see, and the cursor after
 * it), `attachments(uid)` (each as a file reference to bytes the host holds) and `triage(uid)`
 * (whether the mail brings a receipt, by its sender and subject only, asked of the model of the
 * step mail-triage). `held` collects the bytes by reference for the delivery, with their sender.
 */
export function mailChannel(backend: MailBackend, r: Pick<MailReach, 'folders' | 'from' | 'skip'>, addresses: string[], since: Date, held: Map<string, Held>, judgeWith: typeof judge = judge) {
  const folder = r.folders[0] ?? 'INBOX';
  /** The sender of each message handed to the code. */
  const seen = new Map<number, string>();
  const subjects = new Map<number, string>();
  const mine = (to: string[]) => !addresses.length || to.some((a) => addresses.includes(a.toLowerCase()));
  return {
    async messages(cursor?: MailCursor, limit = 50) {
      const page = await backend.list(folder, cursor?.uid, since, limit);
      const restart = cursor && cursor.validity && page.validity && cursor.validity !== page.validity;
      const list = restart ? await backend.list(folder, undefined, since, limit) : page;
      const last = list.messages.at(-1)?.uid ?? (restart ? 0 : cursor?.uid ?? 0);
      const shown = list.messages.filter((m) => senderAllowed(r, m.from) && mine(m.to));
      for (const m of shown) { seen.set(m.uid, m.from.toLowerCase()); subjects.set(m.uid, m.subject); }
      return { messages: shown, cursor: { validity: list.validity, uid: last } satisfies MailCursor, done: list.messages.length < limit };
    },
    async attachments(uid: number) {
      if (!seen.has(uid)) throw new Error(`message ${uid} was not handed to this source`);
      const parts = await backend.attachments(folder, uid);
      return parts.map((p) => {
        const ref = `held:${sha256(p.content)}`;
        held.set(ref, { name: p.filename, content: p.content, from: seen.get(uid) });
        return { file: ref, filename: p.filename, contentType: p.contentType, size: p.content.length };
      });
    },
    async triage(uid: number): Promise<Triage> {
      if (!seen.has(uid)) throw new Error(`message ${uid} was not handed to this source`);
      try {
        const v: Judged = await judgeWith({ from: seen.get(uid)!, subject: subjects.get(uid) ?? '' }, { type: 'noul', instructions: TRIAGE }, { step: 'mail-triage', timeoutMs: 60_000 });
        return v.type === 'noul' ? { receipt: v.yes, confidence: v.confidence, by: `${v.provider} ${v.model}` } : { receipt: null, why: 'no yes/no answer' };
      } catch (e) {
        return { receipt: null, why: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
