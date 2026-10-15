/**
 * The mail channel of the host (ADR 0014): the source's code asks for messages and attachments;
 * the host holds the connection, the password and the reach. Only senders the reach lets through
 * and mail to the source's addresses ever reach the code. Attachments come out of the whole
 * message (a body structure misses inline PDFs), held by their checksum until delivered.
 */
import { createHash } from 'node:crypto';
import type { MailReach } from './model.js';
import { senderAllowed } from './reach.js';

export interface MailSummary { uid: number; from: string; to: string[]; subject: string; date: string; messageId: string }
export interface MailBackend {
  /** Messages of the folder after `after` (a UID), oldest first, at most `limit`; without `after`, those since `since`. */
  list(folder: string, after: number | undefined, since: Date, limit: number): Promise<{ validity: string; messages: MailSummary[] }>;
  /** The attachments of one message, from its whole source. */
  attachments(folder: string, uid: number): Promise<Array<{ filename: string; contentType: string; content: Buffer }>>;
  close(): Promise<void>;
}

/** The real backend: one IMAP connection per pull. The libraries load here, as the Mac app does not pack them (desktop/not-packed.cjs). */
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

export interface MailCursor { validity: string; uid: number }
export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * What the code may call: `messages(cursor)` (a page of mail it may see, and the cursor after
 * it) and `attachments(uid)` (each as a file reference to bytes the host holds). `held` collects
 * the bytes by reference for the delivery.
 */
export function mailChannel(backend: MailBackend, r: MailReach, addresses: string[], since: Date, held: Map<string, { name: string; content: Buffer }>) {
  const folder = r.folders[0] ?? 'INBOX';
  const seen = new Set<number>();
  const mine = (to: string[]) => !addresses.length || to.some((a) => addresses.includes(a.toLowerCase()));
  return {
    async messages(cursor?: MailCursor, limit = 50) {
      const page = await backend.list(folder, cursor?.uid, since, limit);
      const restart = cursor && cursor.validity && page.validity && cursor.validity !== page.validity;
      const list = restart ? await backend.list(folder, undefined, since, limit) : page;
      const last = list.messages.at(-1)?.uid ?? (restart ? 0 : cursor?.uid ?? 0);
      const shown = list.messages.filter((m) => senderAllowed(r, m.from) && mine(m.to));
      for (const m of shown) seen.add(m.uid);
      return { messages: shown, cursor: { validity: list.validity, uid: last } satisfies MailCursor, done: list.messages.length < limit };
    },
    async attachments(uid: number) {
      if (!seen.has(uid)) throw new Error(`message ${uid} was not handed to this source`);
      const parts = await backend.attachments(folder, uid);
      return parts.map((p) => {
        const ref = `held:${sha256(p.content)}`;
        held.set(ref, { name: p.filename, content: p.content });
        return { file: ref, filename: p.filename, contentType: p.contentType };
      });
    },
  };
}
