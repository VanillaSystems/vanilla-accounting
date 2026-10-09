/**
 * The workspace's mail.yaml: which mailboxes receipts are collected from, and how the senders of
 * a mailbox that mixes business and private mail are sorted. One company's facts, so they live in
 * its workspace. Credentials are secrets, so they stay out of it: in the app's .env, which dotenv
 * reads from the app folder (<env>_IMAP_USER, <env>_IMAP_PASSWORD). See docs/mail-setup.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Workspace } from '../workspace/workspace.js';

export interface Mailbox {
  label: string;
  /** The address, for the status board. */
  address: string;
  /** Prefix of the app .env keys: <env>_IMAP_USER, _PASSWORD (required), _HOST, _PORT (optional). */
  env: string;
  host: string;
  /** Collect only mail sent to this address (an alias sharing one login). */
  filterTo?: string;
  /** Business and private mail in one box: senders are sorted by skipDomains. */
  mixed: boolean;
}

export interface MailConfig {
  mailboxes: Mailbox[];
  /** Senders of a mixed mailbox that never send receipts. */
  skipDomains: Set<string>;
  /** Senders whose mail always is collected. */
  includeDomains: Set<string>;
  /** Senders that send receipts as links, not attachments (npm run collect-links). */
  linkReceiptDomains: Set<string>;
}

/** A mailbox with what IMAP needs to log in, or the .env keys still missing. */
export type MailboxLogin =
  | { status: 'ready'; host: string; port: number; user: string; password: string }
  | { status: 'missing'; keys: string[] };

/** The login of a mailbox from the app's environment: host and port fall back to mail.yaml and 993. */
export function loginOf(m: Mailbox, env: NodeJS.ProcessEnv): MailboxLogin {
  const [user, password] = [env[`${m.env}_IMAP_USER`], env[`${m.env}_IMAP_PASSWORD`]];
  if (!user || !password) {
    return { status: 'missing', keys: [!user && `${m.env}_IMAP_USER`, !password && `${m.env}_IMAP_PASSWORD`].filter((k): k is string => !!k) };
  }
  return { status: 'ready', host: env[`${m.env}_IMAP_HOST`] || m.host, port: parseInt(env[`${m.env}_IMAP_PORT`] || '993'), user, password };
}

/** mail.yaml names mailboxes. The template npm run init writes is all comments, so it does not. */
export function mailConfigured(ws: Workspace): boolean {
  return existsSync(ws.paths.mail) && (parse(readFileSync(ws.paths.mail, 'utf8')) as { mailboxes?: unknown } | null)?.mailboxes != null;
}

export function loadMailConfig(ws: Workspace): MailConfig {
  const path = ws.paths.mail;
  if (!existsSync(path)) throw new Error(`${path} not found: receipt collection needs the workspace's mailboxes (see docs/mail-setup.md).`);
  const raw = (parse(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
  const fail = (msg: string): never => { throw new Error(`${path}: ${msg}`); };
  const list = (k: string): string[] => {
    const v = raw[k] ?? [];
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : fail(`${k} must be a list of domains`);
  };
  if (!Array.isArray(raw.mailboxes) || raw.mailboxes.length === 0) fail('mailboxes must list at least one mailbox');
  const mailboxes = (raw.mailboxes as Record<string, unknown>[]).map((m, i): Mailbox => {
    const text = (k: string) => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : fail(`mailboxes[${i}].${k} must be a non-empty text`));
    return {
      label: text('label'), address: text('address'), env: text('env'), host: text('host'),
      ...(m.filterTo === undefined ? {} : { filterTo: text('filterTo') }),
      mixed: m.mixed === true,
    };
  });
  return {
    mailboxes,
    skipDomains: new Set(list('skipDomains')),
    includeDomains: new Set(list('includeDomains')),
    linkReceiptDomains: new Set(list('linkReceiptDomains')),
  };
}

/**
 * For a mixed mailbox: skip what never is a receipt, include known senders, and leave the rest
 * ambiguous. PRINCIPLE: when an order could be business or private, collect it and let the match
 * step sort it by the card it was paid with.
 */
export function classifyDomain(domain: string, cfg: MailConfig): 'skip' | 'include' | 'ambiguous' {
  if (cfg.skipDomains.has(domain)) return 'skip';
  if (cfg.includeDomains.has(domain)) return 'include';
  return 'ambiguous';
}
