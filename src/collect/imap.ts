import 'dotenv/config';
import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { loginOf, type MailConfig } from './mail-config.js';

export interface EmailAccount {
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  filterTo?: string; // filter by To: address (for iCloud aliases)
}

export interface EmailSummary {
  uid: number;
  account: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  hasAttachments: boolean;
}

export interface EmailFull {
  uid: number;
  account: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  textBody: string;
  htmlBody: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

/** The workspace's mailboxes (mail.yaml) with their credentials from the app's .env. Throws naming the missing keys. */
export function mailAccounts(cfg: MailConfig): (EmailAccount & { mixed: boolean })[] {
  return cfg.mailboxes.map((m) => {
    const login = loginOf(m, process.env);
    if (login.status === 'missing') throw new Error(`${m.label}: add ${login.keys.join(' and ')} to the app's .env (docs/mail-setup.md).`);
    const { status: _, ...credentials } = login;
    return { label: m.label, ...credentials, ...(m.filterTo ? { filterTo: m.filterTo } : {}), mixed: m.mixed };
  });
}

function createClient(account: EmailAccount, timeouts: { connectionTimeout?: number; greetingTimeout?: number } = {}): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: account.password },
    logger: false,
    ...timeouts,
  });
}

/** Log in and out again, nothing fetched: proves host, port and password. Rejects with the server's answer. */
export async function checkLogin(account: EmailAccount): Promise<void> {
  const client = await connected(account, { connectionTimeout: 20_000, greetingTimeout: 20_000 });
  await client.logout();
}

/** A logged-in client. A server keeps the connection open after a refused LOGIN, so a failed connect closes it. */
async function connected(account: EmailAccount, options?: Parameters<typeof createClient>[1]): Promise<ReturnType<typeof createClient>> {
  const client = createClient(account, options);
  try {
    await client.connect();
  } catch (e) {
    client.close();
    throw e;
  }
  return client;
}

function hasAttachmentsInStructure(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) {
    return structure.childNodes.some((c: any) => hasAttachmentsInStructure(c));
  }
  return false;
}

export async function fetchEmailSummaries(
  account: EmailAccount,
  from: Date,
  to: Date,
): Promise<EmailSummary[]> {
  const client = await connected(account);

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const searchCriteria: SearchObject = {
        since: from,
        before: new Date(to.getTime() + 86400000),
      };
      if (account.filterTo) {
        searchCriteria.to = account.filterTo;
      }

      const uids = (await client.search(searchCriteria, { uid: true })) || [];
      if (uids.length === 0) return [];

      console.log(`  ${account.label}: ${uids.length} emails found, fetching envelopes...`);

      const summaries: EmailSummary[] = [];
      const batchSize = 50;

      for (let i = 0; i < uids.length; i += batchSize) {
        const batch = uids.slice(i, i + batchSize);
        const range = batch.join(',');

        for await (const msg of client.fetch(range, {
          envelope: true,
          bodyStructure: true,
        }, { uid: true })) {
          const env = msg.envelope;
          if (!env) throw new Error(`${account.label}: uid ${msg.uid} has no envelope`);
          summaries.push({
            uid: msg.uid,
            account: account.label,
            from: env.from?.[0] ? `${env.from[0].name || ''} <${env.from[0].address || ''}>`.trim() : '',
            to: env.to?.[0] ? (env.to[0].address || '') : '',
            subject: env.subject || '',
            date: env.date?.toISOString() || '',
            hasAttachments: hasAttachmentsInStructure(msg.bodyStructure),
          });
        }
      }

      return summaries.sort((a, b) => a.date.localeCompare(b.date));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export async function fetchEmailFull(
  account: EmailAccount,
  uid: number,
): Promise<EmailFull> {
  const client = await connected(account);

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`${account.label}: uid ${uid} not found`);
      const parsed = await simpleParser(msg.source);

      return {
        uid,
        account: account.label,
        from: parsed.from?.text || '',
        to: [parsed.to ?? []].flat().map((a) => a.text).join(', '),
        subject: parsed.subject || '',
        date: parsed.date?.toISOString() || '',
        textBody: parsed.text || '',
        htmlBody: parsed.html || '',
        attachments: (parsed.attachments || []).map(a => ({
          filename: a.filename || `attachment-${a.cid || 'unknown'}`,
          contentType: a.contentType,
          content: a.content,
        })),
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export function parseQuarter(q: string, overlapDays = 14): { from: Date; to: Date } {
  const m = q.match(/^(\d{4})-Q([1-4])$/);
  if (!m) throw new Error(`Invalid quarter format: ${q}. Use YYYY-QN, e.g. 2026-Q2`);
  const year = parseInt(m[1]);
  const quarter = parseInt(m[2]);
  const startMonth = (quarter - 1) * 3;
  // Pad BOTH ends by {overlapDays}: invoices for a purchase near a quarter
  // boundary arrive on the other side of it. The end pad matters as much as the
  // start one — an invoice emailed in early October for a 29 September payment
  // belongs to this quarter's collection. Without it the window also ended at
  // 00:00 on the quarter's last day, dropping that whole day's emails.
  const from = new Date(Date.UTC(year, startMonth, 1 - overlapDays));
  const to = new Date(Date.UTC(year, startMonth + 3, overlapDays, 23, 59, 59, 999));
  return { from, to };
}

/** Read quarter from CLI args (e.g. `npm run collect -- 2026-Q2`), default to current quarter */
export function getQuarterArg(): string {
  const arg = process.argv[2];
  if (arg) {
    if (!/^\d{4}-Q[1-4]$/.test(arg)) throw new Error(`Invalid quarter: ${arg}. Use YYYY-QN, e.g. 2026-Q2`);
    return arg;
  }
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `${now.getFullYear()}-Q${q}`;
}
