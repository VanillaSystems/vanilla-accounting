/**
 * A mailbox connected in Firma › Quellen (r5h-27): the person names the address, the IMAP server
 * and the login; the app writes `sources/<id>/source.yaml` bound to its IMAP code (as the update's
 * conversion of mail.yaml does, src/platform/sources/mail.ts), and the password goes into the
 * secret store, never into the workspace. The new source waits to be switched on like any other.
 * `previewMailbox` is the connection check: it logs in, reads the last weeks' mail headers and says
 * which mails the source would read, without fetching an attachment or writing anything.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Workspace } from '../../workspace/workspace.js';
import type { MailBackend } from './mail-channel.js';
import type { SourceDecl, SourceVerdict } from './model.js';
import { senderAllowed } from './reach.js';

export interface MailSourceInput { address: string; host: string; account?: string; label?: string }

const ADDRESS = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** What is wrong with the input, in the field it concerns; nothing when it can be written. */
export function mailInputProblem(i: MailSourceInput): 'address' | 'host' | 'account' | undefined {
  if (!ADDRESS.test(i.address.trim())) return 'address';
  if (!HOST.test(i.host.trim())) return 'host';
  if (i.account !== undefined && !i.account.trim()) return 'account';
  return undefined;
}

/** The source's id from its address (`sandra@malerei.example` → `sandra-malerei-example`), unique among `taken`. */
export function mailSourceId(address: string, taken: ReadonlySet<string>): string {
  const base = (address.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'm$1') || 'mail').slice(0, 48).replace(/-+$/, '');
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** source.yaml of a mailbox: every sender's mail to it, its attachments daily into the inbox. */
export function mailSourceYaml(i: MailSourceInput): string {
  const address = i.address.trim();
  const label = i.label?.trim() || address;
  const decl = {
    label,
    code: 'app:imap',
    settings: { boxes: [{ label, address }] },
    reach: { mail: { host: i.host.trim().toLowerCase(), account: i.account?.trim() || address, folders: ['INBOX'], from: ['*'] } },
    feeds: { attachments: { output: 'document', every: 'daily' } },
  };
  return `# The mailbox ${address}, connected in Firma › Quellen. Its password is a secret of the app, never in this folder.\n${stringify(decl)}`;
}

/** Writes the source's folder; refuses an id that exists unless `replace` (the same mailbox connected again, r6h-25). */
export function writeMailSource(ws: Pick<Workspace, 'paths'>, id: string, i: MailSourceInput, replace = false): void {
  const dir = join(ws.paths.root, 'sources', id);
  if (!replace && existsSync(join(dir, 'source.yaml'))) throw new Error(`sources/${id} exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'source.yaml'), mailSourceYaml(i));
}

/** Takes a mailbox source's folder out of the workspace (the undo of one the AI sidebar drafted). */
export function removeMailSource(ws: Pick<Workspace, 'paths'>, id: string): void {
  rmSync(join(ws.paths.root, 'sources', id), { recursive: true, force: true });
}

/** Where a mailbox goes (r6h-25): the source that holds the address already, else a new id unique among every source. */
export function mailSourceSlot(address: string, all: readonly SourceVerdict[]): { id: string; existing?: SourceDecl } {
  const existing = mailSourceFor(address, all.flatMap((v) => (v.kind === 'invalid' ? [] : [v.decl])));
  return existing ? { id: existing.id, existing } : { id: mailSourceId(address, new Set(all.map((v) => (v.kind === 'invalid' ? v.id : v.decl.id)))) };
}

/** The mailbox source of the workspace that holds `address` (its login or one of its boxes), by id. */
export function mailSourceFor(address: string, decls: readonly SourceDecl[]): SourceDecl | undefined {
  const a = address.trim().toLowerCase();
  return decls.find((d) => d.reach.mail && (d.reach.mail.account.toLowerCase() === a
    || (Array.isArray(d.settings.boxes) && (d.settings.boxes as Array<{ address?: string }>).some((b) => b.address?.toLowerCase() === a))));
}

/** One mail of the check: who sent it, its subject and day, and whether the source would read it. */
export interface PreviewMail { from: string; subject: string; date: string; read: boolean }
export interface MailPreview { days: number; total: number; read: number; mails: PreviewMail[] }

/** Of the mail of the last `days`, newest first, the ones the source would read (its senders, its addresses). */
export async function previewMailbox(backend: MailBackend, decl: SourceDecl, now = new Date(), days = 60, limit = 200): Promise<MailPreview> {
  const reach = (decl.reach.mail ?? decl.reach.macMail)!;
  const boxes = Array.isArray(decl.settings.boxes) ? (decl.settings.boxes as Array<{ to?: string }>) : [];
  const addresses = boxes.length && boxes.every((b) => b.to) ? boxes.map((b) => b.to!.toLowerCase()) : [];
  const since = new Date(now.getTime() - days * 86_400_000);
  const { messages } = await backend.list(reach.folders[0] ?? 'INBOX', undefined, since, limit);
  const mails = messages.map((m) => ({
    from: m.from, subject: m.subject, date: m.date.slice(0, 10),
    read: senderAllowed(reach, m.from) && (!addresses.length || m.to.some((a) => addresses.includes(a.toLowerCase()))),
  })).reverse();
  return { days, total: mails.length, read: mails.filter((m) => m.read).length, mails: mails.slice(0, 20) };
}
