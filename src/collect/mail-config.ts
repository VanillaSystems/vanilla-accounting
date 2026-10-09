/**
 * The workspace's mail.yaml: which mailboxes receipts are collected from, and how the senders of
 * a mailbox that mixes business and private mail are sorted. One company's facts, so they live in
 * its workspace; credentials stay in the workspace .env (<env>_IMAP_USER, <env>_IMAP_PASSWORD).
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Workspace } from '../workspace/workspace.js';

export interface Mailbox {
  label: string;
  /** The address, for the status board. */
  address: string;
  /** Prefix of the .env keys: <env>_IMAP_HOST, _PORT, _USER, _PASSWORD. */
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

export function loadMailConfig(ws: Workspace): MailConfig {
  const path = ws.paths.mail;
  if (!existsSync(path)) throw new Error(`${path} not found: receipt collection needs the workspace's mailboxes (see docs/runbooks/receipt-collection.md).`);
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
