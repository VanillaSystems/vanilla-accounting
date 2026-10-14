/**
 * mail.yaml as sources (ADR 0014): one source folder per mailbox, bound to the app's IMAP code,
 * its reach the mailbox's host, account and senders. `mailFromSources` reads them back, so the
 * conversion is checked to lose nothing before the workspace's mail.yaml gives way to it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLedger, readLedger } from './ledger.js';
import { parse, stringify } from 'yaml';
import type { Workspace } from '../../workspace/workspace.js';
import { sources } from './index.js';
import type { SourceDecl } from './model.js';

/** mail.yaml as it was before sources: read only to convert it. */
export interface MailConfig {
  mailboxes: Mailbox[];
  skipDomains: Set<string>;
  includeDomains: Set<string>;
  linkReceiptDomains: Set<string>;
}
export interface Mailbox { label: string; address: string; env: string; host: string; filterTo?: string; mixed: boolean }

/** mail.yaml names mailboxes. The template `npm run init` wrote is all comments, so it does not. */
export function mailConfigured(ws: Pick<Workspace, 'paths'>): boolean {
  return existsSync(ws.paths.mail) && (parse(readFileSync(ws.paths.mail, 'utf8')) as { mailboxes?: unknown } | null)?.mailboxes != null;
}

export function loadMailConfig(ws: Pick<Workspace, 'paths'>): MailConfig {
  const path = ws.paths.mail;
  const raw = (parse(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
  const fail = (msg: string): never => { throw new Error(`${path}: ${msg}`); };
  const list = (k: string): string[] => {
    const v = raw[k] ?? [];
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : fail(`${k} must be a list of domains`);
  };
  if (!Array.isArray(raw.mailboxes) || raw.mailboxes.length === 0) fail('mailboxes must list at least one mailbox');
  const mailboxes = (raw.mailboxes as Record<string, unknown>[]).map((m, i): Mailbox => {
    const text = (k: string) => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : fail(`mailboxes[${i}].${k} must be a non-empty text`));
    return { label: text('label'), address: text('address'), env: text('env'), host: text('host'), ...(m.filterTo === undefined ? {} : { filterTo: text('filterTo') }), mixed: m.mixed === true };
  });
  return { mailboxes, skipDomains: new Set(list('skipDomains')), includeDomains: new Set(list('includeDomains')), linkReceiptDomains: new Set(list('linkReceiptDomains')) };
}

/** The workspace's mailboxes, from its mail sources: each box's address and the address mail is sent to, and the login. For the leak guard and the boards. */
export function mailboxesOf(ws: Pick<Workspace, 'paths'>, appRoot: string): Array<{ source: string; label: string; address: string; to?: string; account: string }> {
  return sources(ws, appRoot).flatMap((v) => {
    if (v.kind === 'invalid' || !v.decl.reach.mail) return [];
    const boxes = Array.isArray(v.decl.settings.boxes) ? (v.decl.settings.boxes as Array<{ label: string; address: string; to?: string }>) : [];
    return boxes.map((b) => ({ source: v.decl.id, label: b.label, address: b.address, ...(b.to ? { to: b.to } : {}), account: v.decl.reach.mail!.account }));
  });
}

const idOf = (m: Mailbox) => m.env.toLowerCase().replace(/_/g, '-');
const envOf = (id: string) => id.toUpperCase().replace(/-/g, '_');
/** A list entry that is a domain, as a sender pattern; anything else (a stray word) is no sender a mail can have. */
const isDomain = (d: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d);
const senders = (domains: Iterable<string>) => [...domains].filter(isDomain).sort().map((d) => `*@${d}`);

/**
 * One source.yaml per login: mailboxes that share a login (one `env`, told apart by the address
 * mail is sent to) are one place outside, so one source with each of them in `settings.boxes`. The
 * login name comes from the app's .env as before (`<ENV>_IMAP_USER`), else the first address.
 */
export function sourcesFromMail(cfg: MailConfig, env: NodeJS.ProcessEnv): Array<{ id: string; yaml: string }> {
  const logins = new Map<string, Mailbox[]>();
  for (const m of cfg.mailboxes) logins.set(idOf(m), [...(logins.get(idOf(m)) ?? []), m]);
  return [...logins].map(([id, boxes]) => {
    const [first] = boxes;
    const mixed = boxes.some((m) => m.mixed);
    const decl = {
      label: boxes.map((m) => m.label).join(' · '),
      code: 'app:imap',
      settings: {
        boxes: boxes.map((m) => ({ label: m.label, address: m.address, ...(m.filterTo ? { to: m.filterTo } : {}), mixed: m.mixed })),
        skip: [...cfg.skipDomains].sort(),
        include: [...cfg.includeDomains].sort(),
        links: [...cfg.linkReceiptDomains].sort(),
      },
      reach: { mail: { host: first.host, account: env[`${first.env}_IMAP_USER`] || first.address, folders: ['INBOX'], from: ['*'], skip: mixed ? senders(cfg.skipDomains) : [] } },
      feeds: { attachments: { output: 'document', every: 'daily' } },
    };
    const stray = [...cfg.skipDomains].filter((d) => !isDomain(d)).sort();
    const note = mixed && stray.length ? `# Not a sender domain, so left out of reach.mail.skip (kept in settings.skip): ${stray.join(', ')}\n` : '';
    return { id, yaml: `# ${boxes.map((m) => `The mailbox ${m.label} (${m.address})`).join('; ')}, from mail.yaml. The password is the secret source:${id}:mail.\n${note}${stringify(decl)}` };
  });
}

/** The mailboxes of the sources bound to the app's IMAP code, as mail.yaml held them. */
export function mailFromSources(decls: SourceDecl[]): MailConfig {
  const mail = decls.filter((d) => d.code.kind === 'app' && d.code.id === 'imap' && d.reach.mail);
  const list = (d: SourceDecl, k: string) => (Array.isArray(d.settings[k]) ? (d.settings[k] as string[]) : []);
  type Box = { label: string; address: string; to?: string; mixed?: boolean };
  return {
    mailboxes: mail.flatMap((d) => ((d.settings.boxes ?? []) as Box[]).map((b): Mailbox => ({
      label: b.label, address: b.address, env: envOf(d.id), host: d.reach.mail!.host, ...(b.to ? { filterTo: b.to } : {}), mixed: b.mixed === true,
    }))),
    skipDomains: new Set(mail.flatMap((d) => list(d, 'skip'))),
    includeDomains: new Set(mail.flatMap((d) => list(d, 'include'))),
    linkReceiptDomains: new Set(mail.flatMap((d) => list(d, 'links'))),
  };
}

/**
 * The update's conversion (ADR 0014): mail.yaml becomes `sources/<login>/source.yaml`, each
 * source's cursor is seeded from the old download journal (the highest message it read), so the
 * first pull goes on where the old collector stopped, and mail.yaml goes to data/backups/.
 * A source folder that exists is left as it is. Returns the sources written.
 */
export function convertMail(ws: Pick<Workspace, 'paths'>, env: NodeJS.ProcessEnv, now = () => new Date()): { sources: string[]; backup: string } {
  const cfg = loadMailConfig(ws);
  const journalFile = join(ws.paths.data, 'download-journal.json');
  const journal = existsSync(journalFile) ? (JSON.parse(readFileSync(journalFile, 'utf8')) as Array<{ account?: string; uid?: number }>) : [];
  const written: string[] = [];
  for (const f of sourcesFromMail(cfg, env)) {
    const dir = join(ws.paths.root, 'sources', f.id);
    if (existsSync(join(dir, 'source.yaml'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'source.yaml'), f.yaml);
    written.push(f.id);
    const labels = new Set(cfg.mailboxes.filter((m) => idOf(m) === f.id).map((m) => m.label));
    const uids = journal.filter((j) => labels.has(String(j.account)) && typeof j.uid === 'number').map((j) => j.uid!);
    if (uids.length && !readLedger(ws, f.id).length) appendLedger(ws, f.id, { at: now().toISOString(), run: 'update', feed: 'attachments', cursor: { validity: '', uid: Math.max(...uids) } });
  }
  const backups = join(ws.paths.data, 'backups');
  mkdirSync(backups, { recursive: true });
  const backup = join(backups, 'mail.yaml.before-sources');
  if (!existsSync(backup)) copyFileSync(ws.paths.mail, backup);
  rmSync(ws.paths.mail);
  return { sources: written, backup };
}
